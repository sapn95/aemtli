// The web UI: a dashboard of the recipe CronJobs, their runs, a button to run
// one now, and a chat with goose. Every route but /healthz requires a valid
// Cloudflare Access token (unless AUTH_MODE=none, for a laptop).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { nextRun, describeCron, runsBetween, weekOf } from './cron.mjs';
import { renderMarkdown } from './markdown.mjs';
import { LABEL_RECIPE, jobRunning } from './k8s.mjs';
import { listRuns, readRun, readRunFile, RECIPE_NAME, RUN_ID } from '../store/runs.mjs';
import { layout, dashboard, recipePage, runPage, chatPage } from './pages.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const STATIC = {
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
    return { title: name, description: '' };
  }
}

/**
 * Builds the request handlers. `deps`: k8s client, dataDir, recipesDir,
 * verify (Access verifier, or null for AUTH_MODE=none), proxy (ACP upgrade
 * handler), allowedOrigin, version, chatCwd (goose's working directory for
 * chat sessions), timeZone (for showing times), log, now.
 */
export function createApp(deps) {
  const { k8s, dataDir, recipesDir, verify, proxy, allowedOrigin, version, chatCwd = '/data/workspace', timeZone: displayZone = 'UTC', log = console.log, now = () => new Date() } = deps;

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
  async function runNow(req, res, name) {
    const site = req.headers['sec-fetch-site'];
    const origin = req.headers.origin;
    if ((site && site !== 'same-origin') || (allowedOrigin && origin !== allowedOrigin)) {
      return send(res, 403, 'application/json', JSON.stringify({ error: 'cross-site request refused' }));
    }
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
      return send(res, 200, STATIC[file], readFileSync(join(PUBLIC, file)), { 'cache-control': 'max-age=300' });
    }
    if (req.method === 'GET' && path === '/') {
      const items = await collect();
      const week = { days: weekOf(now(), displayZone) };
      return page(res, user, 'Chores', dashboard({ items, week, timeZone: displayZone }));
    }
    if (req.method === 'GET' && path === '/chat') return page(res, user, 'Chat', chatPage(chatCwd), 'chat.js', 'chat');

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

    /** The 'upgrade' handler: /acp only, and only after the same identity check. */
    async upgrade(req, socket, head) {
      socket.on('error', () => socket.destroy());
      const refuse = () => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      let path;
      try {
        path = new URL(req.url, 'http://ui').pathname;
      } catch {
        return refuse();
      }
      const user = path === '/acp' ? await identify(req) : null;
      if (!user || !proxy) return refuse();
      return proxy(req, socket, head);
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
