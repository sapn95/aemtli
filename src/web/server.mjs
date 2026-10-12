// The web UI: a dashboard of the recipe CronJobs, their runs, a button to run
// one now, and a chat with goose. Every route but /healthz requires a valid
// Cloudflare Access token (unless AUTH_MODE=none, for a laptop).
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { nextRun, describeCron, runsBetween, weekOf } from './cron.mjs';
import { renderMarkdown } from './markdown.mjs';
import { jobMeta } from '../run/meta.mjs';
import { APPROVAL_ID } from '../gateway/approvals.mjs';
import { LABEL_RECIPE, jobRunning } from './k8s.mjs';
import { listRuns, readRun, readRunFile, readRunAttachment, writeJsonAtomic, RECIPE_NAME, RUN_ID } from '../store/runs.mjs';
import { layout, dashboard, recipePage, runPage, chatPage, approvalsPage } from './pages.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const STATIC = {
  'icon.svg': 'image/svg+xml',
  'app.css': 'text/css',
  'app.js': 'text/javascript',
  'chat.js': 'text/javascript',
  'fonts/schibsted-grotesk.woff2': 'font/woff2',
  'fonts/OFL.txt': 'text/plain',
};
// How long after its slot a scheduled run may start and still count for it:
// the pod has to be scheduled and the image maybe pulled first.
const GRACE_MS = 30 * 60_000;
// More slots than this in a day, and the week chart stops drawing them.
const SLOT_CAP = 100;

/** Sends a complete response with the headers every page carries. */
function send(res, status, type, body, extra = {}) {
  res.writeHead(status, {
    'content-type': type.startsWith('font/') ? type : `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ...extra,
  });
  res.end(body);
}

/** Reads title and description from a recipe file, if it is there. */
function recipeMeta(recipesDir, name) {
  try {
    const doc = parseYaml(readFileSync(join(recipesDir, `${name}.yaml`), 'utf8'));
    return { title: doc?.title ?? name, description: doc?.description ?? '' };
  } catch {
    // A job: its title and description sit in its first comment lines.
    try {
      const meta = jobMeta(readFileSync(join(recipesDir, `${name}.mjs`), 'utf8'));
      return { title: meta.title ?? name, description: meta.description ?? '' };
    } catch {
      return { title: name, description: '' };
    }
  }
}

/**
 * Builds the request handlers. `deps`: k8s client, dataDir, recipesDir,
 * verify (Access verifier, or null for AUTH_MODE=none), chats (the chat
 * broker, or null when there is no goose serve), allowedOrigin, version,
 * timeZone (for showing times), gateways, stateDir, log, now.
 */
export function createApp(deps) {
  const { k8s, dataDir, recipesDir, verify, allowedOrigin, version, timeZone: displayZone = 'UTC', gateways = null, stateDir = null, chats = null, log = console.log, now = () => new Date() } = deps;

  // The owner's favourite chores, on the web pod's own volume so a phone and a
  // laptop see the same stars. Without a state directory there are none.
  const favouritesFile = stateDir ? join(stateDir, 'favorites.json') : null;
  function favourites() {
    if (!favouritesFile) return new Set();
    try {
      const names = JSON.parse(readFileSync(favouritesFile, 'utf8'));
      return new Set(Array.isArray(names) ? names.filter(n => typeof n === 'string' && RECIPE_NAME.test(n)) : []);
    } catch {
      return new Set();
    }
  }
  // Conversations the owner put away: kept here rather than in goose, which
  // has no such thing over ACP. Hidden from the list until the page asks for
  // them, and never deleted by it.
  const archivedFile = stateDir ? join(stateDir, 'chats-archived.json') : null;
  function archived() {
    if (!archivedFile) return new Set();
    try {
      const ids = JSON.parse(readFileSync(archivedFile, 'utf8'));
      return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && CHAT_ID.test(id)) : []);
    } catch {
      return new Set();
    }
  }
  function saveArchived(ids) {
    mkdirSync(stateDir, { recursive: true });
    writeJsonAtomic(archivedFile, [...ids].sort().slice(0, 500));
  }

  const NONE = { items: [], unreachable: [] };

  /** Resolves with the user's email, or null when the request may not pass. */
  async function identify(req) {
    if (!verify) return 'local';
    try {
      const { email } = await verify(req.headers['cf-access-jwt-assertion']);
      return email;
    } catch (err) {
      log(`refused ${req.method} ${req.url}: ${err.message}`);
      return null;
    }
  }

  /** One dashboard row per recipe CronJob, joined with its runs and Jobs. */
  async function collect() {
    const [crons, jobs] = await Promise.all([k8s.listCronJobs(), k8s.listJobs()]);
    const starred = favourites();
    return crons.map(cron => {
      const name = cron.metadata.labels?.[LABEL_RECIPE] ?? cron.metadata.name;
      const timeZone = cron.spec.timeZone ?? 'UTC';
      let next = null;
      try { next = nextRun(cron.spec.schedule, now(), timeZone)?.toISOString() ?? null; } catch { /* shown blank */ }
      const running = jobs.some(j => j.metadata.labels?.[LABEL_RECIPE] === name && jobRunning(j));
      const runs = listRuns(dataDir, name, 50);
      const suspended = Boolean(cron.spec.suspend);
      return {
        name,
        cronJob: cron.metadata.name,
        ...recipeMeta(recipesDir, name),
        schedule: cron.spec.schedule,
        // The words are wall-clock time in the CronJob's zone; say which
        // when the page shows times in another one.
        scheduleText: describeCron(cron.spec.schedule) + (timeZone === displayZone ? '' : ` (${timeZone})`),
        timeZone,
        suspended,
        nextRun: suspended ? null : next,
        running,
        lastRun: runs[0] ?? null,
        favorite: starred.has(name),
        week: weekCells(cron, runs, timeZone),
      };
    }).sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * This week's cells for one CronJob: the runs that happened, the slots
   * still due, and the slots that passed without a run. A scheduled run
   * keeps a slot if it started from a minute before it until GRACE_MS after
   * it, or until the next slot if that comes sooner, so one run never keeps
   * two slots. Only slots after the CronJob was created and after the oldest
   * run still on disk are judged, so a new chore or pruned runs never read
   * as missed. That is the oldest run of any trigger: pruning keeps the
   * newest runs, whatever started them. A day with SLOT_CAP slots or more
   * shows its runs only; a hundred empty boxes would say nothing.
   */
  function weekCells(cron, runs, timeZone) {
    const at = now().getTime();
    const schedule = cron.spec.schedule;
    const started = runs.filter(r => r.trigger !== 'manual').map(r => Date.parse(r.startedAt));
    const created = Date.parse(cron.metadata.creationTimestamp ?? '') || 0;
    const oldest = runs.length ? Date.parse(runs.at(-1).startedAt) || 0 : 0;
    const judgeFrom = Math.max(created, oldest);
    return weekOf(now(), displayZone).map(day => {
      const cell = {
        start: day.start,
        today: day.today,
        runs: runs.filter(r => new Date(r.startedAt) >= day.start && new Date(r.startedAt) < day.end).reverse(),
        planned: [],
        missed: [],
      };
      const slots = cron.spec.suspend ? [] : safeRuns(schedule, day.start, day.end, timeZone);
      if (slots.length >= SLOT_CAP) return cell;
      slots.forEach((slot, i) => {
        const t = slot.getTime();
        const following = slots[i + 1] ?? safeNext(schedule, slot, timeZone);
        const until = Math.min(t + GRACE_MS, following ? following.getTime() : Infinity);
        if (started.some(s => s >= t - 60_000 && s < until)) return;
        if (at < until) cell.planned.push(slot);
        else if (t >= judgeFrom) cell.missed.push(slot);
      });
      return cell;
    });
  }

  /** The next scheduled time after `from`, or null. */
  function safeNext(schedule, from, zone) {
    try { return nextRun(schedule, from, zone); } catch { return null; }
  }

  /** Scheduled times in a window, or none if the expression does not parse. */
  function safeRuns(schedule, from, to, zone) {
    if (from >= to) return [];
    try { return runsBetween(schedule, from, to, zone, SLOT_CAP); } catch { return []; }
  }

  /** A page inside the shared layout. */
  const page = (res, user, title, body, script = 'app.js', active = 'chores') =>
    send(res, 200, 'text/html', layout({ title, user, version, body, script, active }));

  /**
   * POST /api/recipes/<name>/run. A same-origin check stands in for a CSRF
   * token: the browser sets Sec-Fetch-Site and Origin itself, and another
   * site's form cannot fake either.
   */
  function sameOrigin(req) {
    const site = req.headers['sec-fetch-site'];
    // Neither header to go by (no PUBLIC_ORIGIN, and a client that does not
    // say where it posts from): refused, since nothing shows it is this page.
    if (!site && !allowedOrigin) return false;
    return !((site && site !== 'same-origin') || (allowedOrigin && req.headers.origin !== allowedOrigin));
  }
  const crossSite = res => send(res, 403, 'application/json', JSON.stringify({ error: 'cross-site request refused' }));

  const CHAT_ID = /^[A-Za-z0-9_.-]{1,64}$/;
  const sendJson = (res, status, body) => send(res, status, 'application/json', JSON.stringify(body));

  /** A JSON body of at most 64 KB, or null. */
  function jsonBody(req) {
    return new Promise(resolve => {
      let size = 0;
      const chunks = [];
      req.on('data', c => { size += c.length; if (size <= 65536) chunks.push(c); });
      req.on('end', () => {
        if (size > 65536) return resolve(null);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  /**
   * The chat: the conversations goose keeps, and for one of them a stream of
   * what it shows plus the few things one can do to it. Everything that
   * changes something is same-origin only.
   */
  async function chatApi(req, res, path) {
    if (!chats) return sendJson(res, 404, { error: 'the chat is off: goose serve is not configured' });
    if (req.method !== 'GET' && !sameOrigin(req)) return crossSite(res);
    const [, , , id, action] = path.split('/');
    try {
      if (!id) {
        if (req.method === 'GET') {
          const away = archived();
          return sendJson(res, 200, { chats: (await chats.list()).map(c => ({ ...c, archived: away.has(c.id) })) });
        }
        if (req.method === 'POST') {
          const body = await jsonBody(req);
          return sendJson(res, 201, await chats.create(typeof body?.mode === 'string' ? body.mode : undefined));
        }
        return sendJson(res, 405, { error: 'GET or POST' });
      }
      if (!CHAT_ID.test(id)) return sendJson(res, 404, { error: 'no such conversation' });
      if (req.method === 'DELETE' && !action) {
        await chats.remove(id);
        // A conversation that is gone is not one that was put away.
        const away = archived();
        if (away.delete(id) && archivedFile) saveArchived(away);
        return sendJson(res, 200, { deleted: id });
      }
      if (req.method === 'GET' && action === 'events') {
        let left = false;
        let stop = () => {};
        let beat = null;
        req.on('close', () => { left = true; clearInterval(beat); stop(); });
        // Loaded before the stream starts, so a conversation that is gone is
        // a plain 404, which the browser does not retry, where an ended
        // stream would be retried for ever.
        await chats.open(id);
        if (left) return undefined;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          // No buffering on the way out, so each change arrives as it happens.
          'x-accel-buffering': 'no',
        });
        stop = await chats.watch(id, res);
        if (left) stop();
        // A comment every 20 seconds keeps proxies from closing a quiet stream.
        else beat = setInterval(() => res.write(': still here\n\n'), 20_000);
        return undefined;
      }
      if (req.method === 'POST') {
        const body = await jsonBody(req);
        if (body === null) return sendJson(res, 400, { error: 'a JSON body of at most 64 KB' });
        if (action === 'say') {
          if (typeof body.text !== 'string' || !body.text.trim()) return sendJson(res, 400, { error: 'text is empty' });
          await chats.say(id, body.text);
          return sendJson(res, 202, { ok: true });
        }
        if (action === 'archive') {
          if (!archivedFile) return sendJson(res, 503, { error: 'no place to keep that (STATE_DIR)' });
          if (typeof body.archived !== 'boolean') return sendJson(res, 400, { error: 'archived must be true or false' });
          // Only a conversation goose keeps: an id that names none would take
          // a place in a file that holds 500 of them.
          if (body.archived) await chats.open(id);
          const away = archived();
          if (body.archived) away.add(id);
          else away.delete(id);
          saveArchived(away);
          return sendJson(res, 200, { archived: body.archived });
        }
        if (action === 'stop') { await chats.stop(id); return sendJson(res, 200, { ok: true }); }
        if (action === 'answer') { chats.answer(id, String(body.option ?? '')); return sendJson(res, 200, { ok: true }); }
        if (action === 'mode') {
          if (!['auto', 'approve', 'smart_approve', 'chat'].includes(body.mode)) return sendJson(res, 400, { error: 'unknown mode' });
          await chats.mode(id, body.mode);
          return sendJson(res, 200, { ok: true });
        }
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (res.headersSent) return res.end();
      log(`chat ${id ?? ''}: ${err.message}`);
      return sendJson(res, err.status ?? 502, { error: err.status ? err.message : 'goose did not answer' });
    }
  }

  async function runNow(req, res, name) {
    if (!sameOrigin(req)) return crossSite(res);
    const item = (await collect()).find(i => i.name === name);
    if (!item) return send(res, 404, 'application/json', JSON.stringify({ error: 'no such recipe' }));
    if (item.running) return send(res, 409, 'application/json', JSON.stringify({ error: 'already running' }));
    const job = await k8s.runNow(item.cronJob);
    log(`manual run of ${name} as job ${job.metadata?.name}`);
    return send(res, 202, 'application/json', JSON.stringify({ job: job.metadata?.name }));
  }

  /** Routes one authenticated request. */
  async function route(req, res, user) {
    const url = new URL(req.url, 'http://ui');
    const path = url.pathname;
    if (req.method === 'GET' && path.startsWith('/static/')) {
      const file = path.slice('/static/'.length);
      if (!Object.hasOwn(STATIC, file)) return send(res, 404, 'text/plain', 'not found');
      // The pages ask for ?v=<version>, so a new release is a new URL and the
      // old file can be cached for good; anything else for five minutes.
      const pinned = url.searchParams.get('v') === version;
      return send(res, 200, STATIC[file], readFileSync(join(PUBLIC, file)), { 'cache-control': pinned ? 'public, max-age=31536000, immutable' : 'max-age=300' });
    }
    if (req.method === 'GET' && path === '/') {
      const items = await collect();
      const week = { days: weekOf(now(), displayZone) };
      const needs = gateways?.configured ? await gateways.pending() : NONE;
      return page(res, user, 'Chores', dashboard({ items, week, timeZone: displayZone, now: now(), needs }));
    }
    if (req.method === 'GET' && path === '/chat') return page(res, user, 'Chat', chatPage(Boolean(chats)), chats ? 'chat.js' : 'app.js', 'chat');
    if (req.method === 'GET' && path === '/approvals') {
      const all = gateways?.configured ? await gateways.all() : NONE;
      return page(res, user, 'Approvals', approvalsPage(all, Boolean(gateways?.configured), displayZone), 'app.js', 'approvals');
    }
    if (path === '/api/chats' || path.startsWith('/api/chats/')) return chatApi(req, res, path);
    const star = path.match(/^\/api\/favorites\/([^/]+)\/(on|off)$/);
    if (req.method === 'POST' && star) {
      if (!sameOrigin(req)) return crossSite(res);
      if (!RECIPE_NAME.test(star[1])) return send(res, 404, 'application/json', JSON.stringify({ error: 'no such chore' }));
      if (!favouritesFile) return send(res, 503, 'application/json', JSON.stringify({ error: 'no place to keep favourites (STATE_DIR)' }));
      const names = favourites();
      if (star[2] === 'on') names.add(star[1]);
      else names.delete(star[1]);
      mkdirSync(stateDir, { recursive: true });
      writeJsonAtomic(favouritesFile, [...names].sort().slice(0, 500));
      return send(res, 200, 'application/json', JSON.stringify({ favorite: star[2] === 'on' }));
    }
    const decision = path.match(/^\/api\/approvals\/([a-z0-9-]+)\/([^/]+)\/(approve|reject)$/);
    if (req.method === 'POST' && decision && APPROVAL_ID.test(decision[2])) {
      if (!sameOrigin(req)) return crossSite(res);
      if (!gateways?.configured) return send(res, 404, 'application/json', JSON.stringify({ error: 'no gateways' }));
      const [, name, id, verb] = decision;
      log(`${user} ${verb === 'approve' ? 'approves' : 'rejects'} ${name}/${id}`);
      try {
        const { status, body } = await gateways.decide(name, id, verb);
        return send(res, status, 'application/json', JSON.stringify(body));
      } catch (err) {
        log(`gateway ${name}: ${err.message}`);
        return send(res, 502, 'application/json', JSON.stringify({ error: 'the gateway did not answer' }));
      }
    }

    const recipe = path.match(/^\/recipes\/([^/]+)$/);
    if (req.method === 'GET' && recipe && RECIPE_NAME.test(recipe[1])) {
      const item = (await collect()).find(i => i.name === recipe[1]);
      if (!item) return send(res, 404, 'text/plain', 'no such recipe');
      return page(res, user, item.title, recipePage(item, listRuns(dataDir, item.name, 50), displayZone));
    }
    const run = path.match(/^\/recipes\/([^/]+)\/runs\/([^/]+)$/);
    if (req.method === 'GET' && run && RECIPE_NAME.test(run[1]) && RUN_ID.test(run[2])) {
      const record = readRun(dataDir, run[1], run[2]);
      if (!record) return send(res, 404, 'text/plain', 'no such run');
      const result = renderMarkdown(readRunFile(dataDir, run[1], run[2], 'result.md'));
      const { title } = recipeMeta(recipesDir, run[1]);
      return page(res, user, `${title} run`, runPage(record, title, result, readRunFile(dataDir, run[1], run[2], 'run.log'), displayZone));
    }
    // A file a job kept with a run: always a download, never shown inline.
    const file = path.match(/^\/recipes\/([^/]+)\/runs\/([^/]+)\/files\/([^/]+)$/);
    if (req.method === 'GET' && file && RECIPE_NAME.test(file[1]) && RUN_ID.test(file[2])) {
      let fileName;
      try {
        fileName = decodeURIComponent(file[3]);
      } catch {
        return send(res, 404, 'text/plain', 'no such file');
      }
      // The name is checked before it goes into the header: letters, digits,
      // dashes, underscores and one dot, so no quote can end the filename.
      const found = readRunAttachment(dataDir, file[1], file[2], fileName);
      if (!found) return send(res, 404, 'text/plain', 'no such file');
      return send(res, 200, found.type, found.bytes, {
        'content-disposition': `attachment; filename="${fileName}"`,
        'cache-control': 'no-store',
      });
    }
    const action = path.match(/^\/api\/recipes\/([^/]+)\/run$/);
    if (req.method === 'POST' && action && RECIPE_NAME.test(action[1])) return runNow(req, res, action[1]);
    return send(res, 404, 'text/plain', 'not found');
  }

  return {
    /** The 'request' handler. */
    async handle(req, res) {
      if (req.url === '/healthz') return send(res, 200, 'text/plain', 'ok');
      try {
        new URL(req.url, 'http://ui');
      } catch {
        return send(res, 400, 'text/plain', 'bad request');
      }
      const user = await identify(req);
      if (!user) return send(res, 403, 'text/plain', 'forbidden');
      try {
        await route(req, res, user);
      } catch (err) {
        log(`error on ${req.method} ${req.url}: ${err.message}`);
        if (!res.headersSent) send(res, 500, 'text/plain', 'something went wrong; see the log');
      }
    },

    /**
     * The 'upgrade' handler: there is nothing to upgrade to any more. The
     * browser no longer speaks to goose; the chat broker does.
     */
    upgrade(req, socket) {
      socket.on('error', () => socket.destroy());
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return Promise.resolve();
    },
  };
}

/** Starts the UI server. Resolves once it listens. */
export function startServer(deps, { port = 8080, host = '0.0.0.0' } = {}) {
  const app = createApp(deps);
  const log = deps.log ?? console.log;
  // Neither handler may take the process down: whatever escapes them ends
  // this one request or socket, and the line says what it was.
  const server = createServer((req, res) => {
    app.handle(req, res).catch(err => {
      log(`unhandled on ${req.method}: ${err.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    app.upgrade(req, socket, head).catch(err => {
      log(`unhandled on upgrade: ${err.message}`);
      socket.destroy();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
