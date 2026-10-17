import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { startServer } from '../src/web/server.mjs';
import { createChatBroker } from '../src/web/chats.mjs';
import { fakeGoose, PNG, JPEG } from './fixtures/fake-goose-acp.mjs';
import { createRunDir, writeJsonAtomic } from '../src/store/runs.mjs';

const ORIGIN = 'https://chores.example';
const RUN_ID = '20261005T061300Z-ab12';

/** A fake k8s client with one recipe CronJob; `running` makes its Job active. */
function fakeK8s({ running = false, fail = false, schedule = '13 8 * * 1', created } = {}) {
  const started = [];
  return {
    started,
    async listCronJobs() {
      if (fail) throw new Error('api down');
      return [{
        metadata: { name: 'hello-cron', labels: { 'aemtli.sapn.ch/recipe': 'hello' }, creationTimestamp: created },
        spec: { schedule, timeZone: 'Europe/Zurich' },
      }, {
        metadata: { name: 'paused' },
        spec: { schedule: '0 0 * * *', suspend: true },
      }];
    },
    async listJobs() {
      return running ? [{ metadata: { labels: { 'aemtli.sapn.ch/recipe': 'hello' } }, status: { active: 1 } }] : [];
    },
    async runNow(name) { started.push(name); return { metadata: { name: `${name}-manual-x1` } }; },
  };
}

/** Starts the UI against temp dirs; `body` gets a request helper. */
async function withUi(body, { k8s = fakeK8s(), now = '2026-10-11T12:00:00Z', moreRuns = [], fixtureRun = true, stateDir = true, chats = null, verify = async t => { if (t !== 'good') throw new Error('no'); return { email: 'owner@example.com' }; }, proxy } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aemtli-ui-'));
  const recipesDir = join(root, 'recipes');
  const dataDir = join(root, 'data');
  mkdirSync(recipesDir);
  writeFileSync(join(recipesDir, 'hello.yaml'), 'title: Hello <b>world</b>\ndescription: Says "hi" & leaves\nprompt: hi\n');
  const dir = createRunDir(dataDir, fixtureRun ? 'hello' : 'unused', RUN_ID);
  writeJsonAtomic(join(dir, 'run.json'), { recipe: 'hello', id: RUN_ID, status: 'succeeded', trigger: 'schedule', startedAt: '2026-10-05T06:13:00Z', durationMs: 4200, tokens: { total: 15 }, model: 'fake-model' });
  writeFileSync(join(dir, 'result.md'), '## Grüessech\n\nHi <script>alert(1)</script> [x](javascript:alert(1))\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  writeFileSync(join(dir, 'run.log'), 'log line\n');
  for (const [i, { startedAt, trigger = 'schedule' }] of moreRuns.entries()) {
    const id = `${startedAt.replace(/[-:]/g, '').replace(/\.\d+/, '')}-${String(i).padStart(4, '0')}`;
    writeJsonAtomic(join(createRunDir(dataDir, 'hello', id), 'run.json'), { recipe: 'hello', id, status: 'succeeded', trigger, startedAt, durationMs: 1000 });
  }
  const lines = [];
  const server = await startServer({ k8s, dataDir, recipesDir, verify, proxy, allowedOrigin: ORIGIN, version: '0.0.0-test', timeZone: 'Europe/Zurich', stateDir: stateDir ? join(root, 'state') : null, chats, log: l => lines.push(l), now: () => new Date(now) }, { port: 0, host: '127.0.0.1' });
  const port = server.address().port;
  /** One request; `token` null means no Access header. */
  const call = (path, { method = 'GET', token = 'good', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { ...(token ? { 'cf-access-jwt-assertion': token } : {}), ...headers } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: 101 }); });
    req.on('error', reject);
    req.end();
  });
  try {
    await body({ call, k8s, lines, port, root });
  } finally {
    await new Promise(r => { server.closeAllConnections(); server.close(r); });
  }
}

test('health needs no token, everything else does', () =>
  withUi(async ({ call, lines }) => {
    assert.equal((await call('/healthz', { token: null })).status, 200);
    assert.equal((await call('/', { token: null })).status, 403);
    assert.equal((await call('/', { token: 'forged' })).status, 403);
    assert.equal((await call('/static/app.css', { token: null })).status, 403);
    assert.ok(lines.some(l => l.startsWith('refused GET /')));
  }));

test('the dashboard shows the recipe, its next run and its last run, escaped', () =>
  withUi(async ({ call }) => {
    const res = await call('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.body, /Hello &lt;b&gt;world&lt;\/b&gt;/);
    assert.match(res.body, /Says &quot;hi&quot; &amp; leaves/);
    assert.doesNotMatch(res.body, /<b>world<\/b>/);
    // The schedule in words, as its own line next to the name.
    assert.match(res.body, /<p class="when" title="Mondays at 08:13 \(13 8 \* \* 1, Europe\/Zurich\)">Mondays at 08:13<\/p>/, 'the whole schedule in the tooltip, as the text may be cut at two lines');
    assert.match(res.body, /<link rel="stylesheet" href="\/static\/app\.css\?v=0\.0\.0-test">/, 'assets carry the version');
    assert.match(res.body, /<script type="module" src="\/static\/app\.js\?v=0\.0\.0-test"><\/script>/);
    assert.doesNotMatch(res.body, />13 8 \* \* 1</, 'no cron in the text, only in the tooltip');
    // When it runs next, said the way a person would.
    assert.match(res.body, /<span class="next">tomorrow 08:13<\/span>/);
    assert.match(res.body, /title="Says &quot;hi&quot; &amp; leaves"/, 'what it does is on the name');
    assert.doesNotMatch(res.body, /title=""/, 'and no empty tooltip where there is none');
    // This week (5 to 11 Oct, Sunday is today): Monday's run is ticked off and links to it.
    assert.match(res.body, /<h1 id="plan-title">This week<\/h1><p class="range">5 Oct to 11 Oct<\/p>/);
    assert.match(res.body, new RegExp(`<a class="mark succeeded" href="/recipes/hello/runs/${RUN_ID}">✓</a>`));
    assert.match(res.body, /<li class="day ran" title="Mon 5 Oct: done at 08:13">/, 'the day carries its run');
    assert.match(res.body, /<li class="day today" title="Sun 11 Oct: nothing">/, 'and today is marked as today');
    assert.match(res.body, /Mon 5 Oct: done at 08:13/, 'every day says what it holds');
    // The paused one runs only by hand and has nothing due.
    assert.match(res.body, /<span class="next">only by hand<\/span>/);
    assert.match(res.body, /Paused\. Normally every day at 00:00 \(UTC\)/, 'a zone other than the page\'s is named');
    assert.match(res.body, /<span class="status succeeded">Done<\/span>/);
    assert.match(res.body, /<link rel="icon" href="\/static\/icon\.svg\?v=0\.0\.0-test" type="image\/svg\+xml">/);
    assert.match(res.body, /owner@example\.com/);
  }));

test('a slot that passed without a run is marked, one still ahead is due', async () => {
  const daily = { k8s: fakeK8s({ schedule: '13 8 * * *', created: '2026-10-07T00:00:00Z' }) };
  const count = (body, kind) => body.match(new RegExp(`<span class="mark ${kind}"`, 'g'))?.length ?? 0;
  // Sunday noon: Wednesday to Sunday passed without a run. Monday ran; Tuesday
  // was before the CronJob existed, so it is not held against it.
  await withUi(async ({ call }) => {
    const { body } = await call('/');
    assert.equal(count(body, 'missed'), 5);
    assert.equal(count(body, 'due'), 0);
    assert.match(body, /did not run at 08:13/, 'the day says what it missed');
  }, daily);
  // Sunday 07:00 in Zurich: today's 08:13 is still due.
  await withUi(async ({ call }) => {
    const { body } = await call('/');
    assert.equal(count(body, 'missed'), 4);
    assert.equal(count(body, 'due'), 1);
  }, { ...daily, now: '2026-10-11T05:00:00Z' });
  // A run that started twelve minutes late still counts for its slot; one
  // started by hand does not.
  await withUi(async ({ call }) => {
    assert.equal(count((await call('/')).body, 'missed'), 4, 'Tue, Thu, Fri, Sat; not Wed');
  }, { k8s: fakeK8s({ schedule: '13 8 * * *' }), now: '2026-10-10T12:00:00Z', moreRuns: [{ startedAt: '2026-10-07T06:25:00Z' }, { startedAt: '2026-10-09T06:14:00Z', trigger: 'manual' }] });
  // Without a creation time, only slots after the oldest run on disk are
  // judged: older runs may have been pruned.
  await withUi(async ({ call }) => {
    assert.equal(count((await call('/')).body, 'missed'), 2, 'Fri, Sat');
  }, { k8s: fakeK8s({ schedule: '13 8 * * *' }), now: '2026-10-10T12:00:00Z', fixtureRun: false, moreRuns: [{ startedAt: '2026-10-08T06:20:00Z' }] });
  // Slots a quarter of an hour apart: a run at 08:20 keeps the 08:15 slot,
  // not the 08:00 one as well.
  await withUi(async ({ call }) => {
    assert.equal(count((await call('/')).body, 'missed'), 2, 'Fri 08:15 and Sat 08:00');
  }, { k8s: fakeK8s({ schedule: '0,15 8 * * *' }), now: '2026-10-10T12:00:00Z', fixtureRun: false, moreRuns: [{ startedAt: '2026-10-09T06:00:00Z' }, { startedAt: '2026-10-10T06:20:00Z' }] });
  // Every minute: the chart shows the runs, not 1440 boxes a day.
  await withUi(async ({ call }) => {
    const { body } = await call('/');
    assert.doesNotMatch(body, /class="mark (missed|due)"/);
    assert.match(body, /class="mark succeeded"/);
  }, { k8s: fakeK8s({ schedule: '* * * * *' }) });
  // Twenty minutes late is not missed yet: the pod may still be starting.
  await withUi(async ({ call }) => {
    assert.equal(count((await call('/')).body, 'due'), 1);
  }, { ...daily, now: '2026-10-11T06:33:00Z' });
});

test('a recipe page lists its runs, a run page shows the answer escaped', () =>
  withUi(async ({ call }) => {
    const recipe = await call('/recipes/hello');
    assert.equal(recipe.status, 200);
    assert.match(recipe.body, new RegExp(`/recipes/hello/runs/${RUN_ID}`));
    const run = await call(`/recipes/hello/runs/${RUN_ID}`);
    assert.equal(run.status, 200);
    assert.match(run.body, /<h2>Grüessech<\/h2>/, 'the result is rendered Markdown');
    assert.match(run.body, /<td>1<\/td>/);
    assert.match(run.body, /Hi &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(run.body, /<script>alert/);
    assert.doesNotMatch(run.body, /href="javascript:/);
    assert.match(run.body, /Mon 5 Oct, 08:13/, 'the run is titled by when it ran, in the display zone');
    assert.match(run.body, /<p class="crumb"><a href="\/recipes\/hello">Hello &lt;b&gt;world&lt;\/b&gt;<\/a>/);
    assert.match(run.body, /log line/);
    assert.equal((await call('/recipes/nope')).status, 404);
    assert.equal((await call('/recipes/hello/runs/20261012T061300Z-ffff')).status, 404);
    assert.equal((await call('/recipes/..%2Fetc')).status, 404);
    assert.equal((await call('/recipes/hello/runs/..%2F..%2Frun.json')).status, 404);
  }));

test('run now: same-origin only, refused while running, unknown recipe 404', async () => {
  await withUi(async ({ call, k8s }) => {
    const post = headers => call('/api/recipes/hello/run', { method: 'POST', headers });
    assert.equal((await post({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ 'sec-fetch-site': 'same-site', origin: ORIGIN })).status, 403);
    assert.deepEqual(k8s.started, []);
    const ok = await post({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
    assert.equal(ok.status, 202);
    assert.deepEqual(JSON.parse(ok.body), { job: 'hello-cron-manual-x1' });
    assert.deepEqual(k8s.started, ['hello-cron'], 'the CronJob name, not the recipe label');
    assert.equal((await call('/api/recipes/nope/run', { method: 'POST', headers: { origin: ORIGIN } })).status, 404);
    assert.equal((await call('/api/recipes/hello/run')).status, 404, 'GET is not a run');
  });
  await withUi(async ({ call }) => {
    assert.equal((await call('/api/recipes/hello/run', { method: 'POST', headers: { origin: ORIGIN } })).status, 409);
  }, { k8s: fakeK8s({ running: true }) });
});

test('static files are served from the list, nothing else', () =>
  withUi(async ({ call }) => {
    const css = await call('/static/app.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers['cache-control'], 'max-age=300');
    const pinned = await call('/static/app.css?v=0.0.0-test');
    assert.equal(pinned.headers['cache-control'], 'public, max-age=31536000, immutable', 'this version\'s URL never changes');
    assert.equal((await call('/static/app.css?v=0.0.1')).headers['cache-control'], 'max-age=300', 'another version is not pinned');
    assert.match(css.headers['content-type'], /text\/css/);
    const icon = await call('/static/icon.svg');
    assert.equal(icon.status, 200);
    assert.match(icon.headers['content-type'], /image\/svg\+xml/);
    const font = await call('/static/fonts/schibsted-grotesk.woff2');
    assert.equal(font.status, 200);
    assert.equal(font.headers['content-type'], 'font/woff2');
    assert.equal((await call('/static/fonts/OFL.txt')).status, 200);
    assert.equal((await call('/static/fonts/')).status, 404);
    assert.equal((await call('/static/constructor')).status, 404, 'only the list\'s own keys');
    assert.equal((await call('/static/__proto__')).status, 404);
    assert.equal((await call('/static/../package.json')).status, 404);
    assert.equal((await call('/static/server.mjs')).status, 404);
  }));

test('without goose serve the chat page says so, and the chat API is off', () =>
  withUi(async ({ call }) => {
    const res = await call('/chat');
    assert.match(res.body, /The chat is off/);
    assert.doesNotMatch(res.body, /chat\.js/);
    assert.equal((await call('/api/chats')).status, 404);
  }));

test('the chat API: conversations, a stream, and changes from this origin only', async () => {
  const chats = createChatBroker({ connect: fakeGoose().connect, cwd: '/w' });
  await withUi(async ({ call, port }) => {
    const page = await call('/chat');
    assert.match(page.body, /<ul id="chats" class="chats-list">/);
    assert.match(page.body, /\/static\/chat\.js\?v=/);
    const same = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    assert.equal((await call('/api/chats', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
    const made = await post(port, '/api/chats', { mode: 'approve' }, same);
    assert.equal(made.status, 201);
    const { id } = JSON.parse(made.body);
    assert.equal((await post(port, `/api/chats/${id}/say`, { text: 'Hoi' }, { ...same, origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(port, `/api/chats/${id}/say`, { text: '  ' }, same)).status, 400);
    assert.equal((await post(port, `/api/chats/${id}/say`, { text: 'Hoi' }, same)).status, 202);
    assert.equal((await post(port, `/api/chats/${id}/mode`, { mode: 'yolo' }, same)).status, 400);
    assert.equal((await post(port, `/api/chats/${id}/answer`, { option: 'x' }, same)).status, 409, 'no question waits');
    assert.equal((await call('/api/chats/..%2Fx/events')).status, 404);
    const list = JSON.parse((await call('/api/chats')).body);
    assert.deepEqual(list.chats.map(c => c.id), [id]);
    // The stream: a snapshot first, with what was said.
    const first = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: `/api/chats/${id}/events`, headers: { 'cf-access-jwt-assertion': 'good' } }, res => {
        assert.match(res.headers['content-type'], /^text\/event-stream/);
        res.setEncoding('utf8');
        res.once('data', d => { resolve(JSON.parse(d.replace(/^data: /, ''))); req.destroy(); });
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(first.kind, 'snapshot');
    assert.deepEqual(first.events.map(e => e.type), ['user', 'agent']);
    // Every change, from another site, refused before it reaches goose.
    const evil = { ...same, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
    for (const [method, path] of [['POST', '/api/chats'], ['POST', `/api/chats/${id}/say`], ['POST', `/api/chats/${id}/stop`], ['POST', `/api/chats/${id}/answer`], ['POST', `/api/chats/${id}/mode`], ['DELETE', `/api/chats/${id}`]]) {
      assert.equal((await call(path, { method, headers: evil })).status, 403, `${method} ${path}`);
    }
    assert.ok(chats.chats.has(id), 'not deleted');
  }, { chats });
  chats.close();
});

test('the chat API takes images with a message, and serves them back by id', async () => {
  const goose = fakeGoose();
  const chats = createChatBroker({ connect: goose.connect, cwd: '/w' });
  await withUi(async ({ call, port }) => {
    const same = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const { id } = JSON.parse((await post(port, '/api/chats', {}, same)).body);
    const refused = await post(port, `/api/chats/${id}/say`, { text: 'x', images: [{ mimeType: 'image/png', data: JPEG }] }, same);
    assert.equal(refused.status, 400);
    assert.match(JSON.parse(refused.body).error, /not the PNG it says it is/);
    assert.equal((await post(port, `/api/chats/${id}/say`, { text: 7 }, same)).status, 400);
    const long = await post(port, `/api/chats/${id}/say`, { text: 'x'.repeat(65537) }, same);
    assert.match(JSON.parse(long.body).error, /text is longer than 64 KB/, 'the text keeps its old limit');
    assert.equal((await post(port, `/api/chats/${id}/say`, { text: ' ', images: [] }, same)).status, 400, 'nothing to say');
    assert.equal((await post(port, `/api/chats/${id}/say`, { text: ' ', images: [{ mimeType: 'image/png', data: PNG }] }, same)).status, 202, 'an image alone');
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(goose.prompts.at(-1), [{ type: 'image', mimeType: 'image/png', data: PNG }]);
    const ref = chats.chats.get(id).events[0].images[0];
    const got = await call(`/api/chats/${id}/images/${ref.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers['content-type'], 'image/png');
    assert.equal(got.headers['content-security-policy'], "default-src 'none'; img-src 'self'");
    assert.equal(got.headers['x-content-type-options'], 'nosniff');
    assert.equal((await call(`/api/chats/${id}/images/${'0'.repeat(24)}`)).status, 404);
    assert.equal((await call(`/api/chats/${id}/images/..%2F`)).status, 404);
    assert.equal((await call(`/api/chats/other/images/${ref.id}`)).status, 404, 'only under its own conversation');
    assert.equal((await call(`/api/chats/${id}/images/${ref.id}`, { token: null })).status, 403, 'behind Access like the rest');
    // The larger limit is for a message only.
    const huge = await post(port, `/api/chats/${id}/say`, { text: 'x', images: [{ mimeType: 'image/png', data: 'A'.repeat(13 * 1024 * 1024) }] }, same);
    assert.match(JSON.parse(huge.body).error, /at most 12 MB/);
    const modeTooBig = await post(port, `/api/chats/${id}/mode`, { mode: 'auto', pad: 'x'.repeat(70_000) }, same);
    assert.match(JSON.parse(modeTooBig.body).error, /at most 64 KB/);
  }, { chats });
  chats.close();
});

test('a stream that closes stops watching; one for a conversation that is gone is a 404', async () => {
  const chats = createChatBroker({ connect: fakeGoose().connect, cwd: '/w' });
  await withUi(async ({ call, port }) => {
    const { id } = await chats.create();
    await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: `/api/chats/${id}/events`, headers: { 'cf-access-jwt-assertion': 'good' } }, res => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('close', resolve);
      req.on('error', reject);
      req.end();
    });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(chats.chats.get(id).watchers.size, 0);
    const missing = await call('/api/chats/nope/events');
    assert.equal(missing.status, 404);
    assert.match(missing.headers['content-type'], /^application\/json/);
  }, { chats });
  chats.close();
});

/** A POST with a JSON body. */
function post(port, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'cf-access-jwt-assertion': 'good', ...headers } }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('a failing cluster API is a 500 with the detail in the log only', () =>
  withUi(async ({ call, lines }) => {
    const res = await call('/');
    assert.equal(res.status, 500);
    assert.doesNotMatch(res.body, /api down/);
    assert.ok(lines.some(l => /api down/.test(l)));
  }, { k8s: fakeK8s({ fail: true }) }));

test('AUTH_MODE=none lets requests in as "local"', () =>
  withUi(async ({ call }) => {
    const res = await call('/', { token: null });
    assert.equal(res.status, 200);
    assert.match(res.body, /local/);
  }, { verify: null }));

test('nothing upgrades: the browser no longer talks to goose', () =>
  withUi(async ({ call }) => {
    const upgrade = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') };
    assert.equal((await call('/acp', { headers: upgrade })).status, 403);
    assert.equal((await call('/other', { headers: upgrade })).status, 403);
  }));

test('a malformed request target is refused, on plain requests and upgrades, and the server stays up', () =>
  withUi(async ({ call, port }) => {
    const raw = text => new Promise((resolve, reject) => {
      const s = connect(port, '127.0.0.1', () => s.write(text));
      let data = '';
      s.on('data', d => { data += d; });
      s.on('end', () => resolve(data));
      s.on('close', () => resolve(data));
      s.on('error', reject);
    });
    assert.match(await raw('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400/);
    const key = randomBytes(16).toString('base64');
    await raw(`GET //[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`);
    assert.equal((await call('/healthz', { token: null })).status, 200);
  }));

test('favourites: a star from the same origin is kept on the server and comes first', () =>
  withUi(async ({ call, root }) => {
    const star = (name, on, headers = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }) => call(`/api/favorites/${name}/${on ? 'on' : 'off'}`, { method: 'POST', headers });
    let page = (await call('/')).body;
    assert.ok(page.indexOf('>Hello &lt;b&gt;world') < page.indexOf('>paused</a>'), 'by next run: hello before the paused one');
    assert.match(page, /<input type="search" id="find" placeholder="Search 2 chores"/);
    assert.match(page, /data-search="hello hello &lt;b&gt;world&lt;\/b&gt; mondays at 08:13 says &quot;hi&quot; &amp; leaves"/);
    assert.equal((await star('paused', true, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await star('Not_A_Name', true)).status, 404);
    assert.equal((await star('paused', true)).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'state', 'favorites.json'), 'utf8')), ['paused']);
    page = (await call('/')).body;
    assert.ok(page.indexOf('>paused</a>') < page.indexOf('>Hello &lt;b&gt;world'), 'a favourite comes first');
    assert.match(page, /<li class="chore" data-search="paused[^"]*" data-fav="1">/);
    assert.match(page, /<button type="button" class="fav" data-recipe="paused" aria-pressed="true"[^>]*>★<\/button>/);
    assert.equal((await star('paused', false)).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'state', 'favorites.json'), 'utf8')), []);
    assert.equal((await call('/api/favorites/paused/on')).status, 404, 'GET is not a star');
  }));

test('without a state directory there are no favourites to keep, and the page says nothing of it', () =>
  withUi(async ({ call }) => {
    assert.equal((await call('/api/favorites/hello/on', { method: 'POST', headers: { origin: ORIGIN } })).status, 503);
    assert.doesNotMatch((await call('/')).body, /data-fav=/);
  }, { stateDir: false }));

test('a file a job kept is a download from its run page, and nothing else is', () =>
  withUi(async ({ call, root, port }) => {
    const dir = join(root, 'data', 'runs', 'hello', RUN_ID);
    mkdirSync(join(dir, 'files'));
    writeFileSync(join(dir, 'files', 'pain.xml'), '<Document/>');
    writeFileSync(join(dir, 'files', 'page.html'), '<script>alert(1)</script>');
    writeFileSync(join(dir, 'files', 'unlisted.txt'), 'x');
    writeFileSync(join(dir, 'files', '.hidden'), 'x');
    writeFileSync(join(dir, 'files', 'scan.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x80]));
    writeFileSync(join(root, 'secret.txt'), 'nobody');
    symlinkSync(join(root, 'secret.txt'), join(dir, 'files', 'link.txt'));
    const record = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    writeJsonAtomic(join(dir, 'run.json'), { ...record, files: [
      { name: 'pain.xml', type: 'application/xml', bytes: 11 },
      { name: 'page.html', type: 'text/html', bytes: 25 },
      { name: 'link.txt', type: 'text/plain', bytes: 6 },
      { name: '.hidden', type: 'text/plain', bytes: 1 },
      { name: 'scan.pdf', type: 'application/pdf', bytes: 8 },
    ] });
    // A binary file comes back byte for byte, not through a text decoder.
    const pdf = await fetch(`http://127.0.0.1:${port}/recipes/hello/runs/${RUN_ID}/files/scan.pdf`, { headers: { 'cf-access-jwt-assertion': 'good' } });
    assert.deepEqual([...new Uint8Array(await pdf.arrayBuffer())], [0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x80]);
    const page = await call(`/recipes/hello/runs/${RUN_ID}`);
    assert.match(page.body, new RegExp(`<a href="/recipes/hello/runs/${RUN_ID}/files/pain.xml" download>pain.xml</a> <span class="quiet">11 bytes</span>`));
    const file = await call(`/recipes/hello/runs/${RUN_ID}/files/pain.xml`);
    assert.equal(file.status, 200);
    assert.equal(file.body, '<Document/>');
    assert.match(file.headers['content-type'], /^application\/xml/);
    assert.equal(file.headers['content-disposition'], 'attachment; filename="pain.xml"');
    assert.equal(file.headers['x-content-type-options'], 'nosniff');
    for (const name of ['page.html', 'unlisted.txt', 'link.txt', '.hidden', '..%2Frun.json', '%E0%A4%A', 'missing.xml']) {
      assert.equal((await call(`/recipes/hello/runs/${RUN_ID}/files/${name}`)).status, 404, name);
    }
    assert.equal((await call(`/recipes/hello/runs/${RUN_ID}/files/pain.xml`, { token: null })).status, 403, 'signed in only');
  }));

test('a conversation can be put away and taken back out, and deleting it forgets that', async () => {
  const goose = fakeGoose();
  const chats = createChatBroker({ connect: goose.connect, cwd: '/w' });
  await withUi(async ({ call, port, root }) => {
    const same = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const { id } = JSON.parse((await post(port, '/api/chats', {}, same)).body);
    const listed = async () => JSON.parse((await call('/api/chats')).body).chats.find(c => c.id === id);
    assert.equal((await listed()).archived, false);
    assert.equal((await post(port, `/api/chats/${id}/archive`, { archived: 'yes' }, same)).status, 400);
    assert.equal((await post(port, '/api/chats/made-up/archive', { archived: true }, same)).status, 404, 'no such conversation');
    assert.equal((await post(port, `/api/chats/${id}/archive`, { archived: true }, same)).status, 200);
    assert.equal((await listed()).archived, true);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'state', 'chats-archived.json'), 'utf8')), [id]);
    // Another browser, or this one after a reload, sees the same.
    assert.equal((await post(port, `/api/chats/${id}/archive`, { archived: false }, same)).status, 200);
    assert.equal((await listed()).archived, false);
    // A file somebody edited by hand: only ids that could name a conversation
    // are read back, so nothing else reaches the page or the file again.
    writeFileSync(join(root, 'state', 'chats-archived.json'), JSON.stringify(['../etc/passwd', 'x'.repeat(200), id, 7, null]));
    assert.equal((await listed()).archived, true);
    await post(port, `/api/chats/${id}/archive`, { archived: true }, same);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'state', 'chats-archived.json'), 'utf8')), [id]);
    await post(port, `/api/chats/${id}/archive`, { archived: true }, same);
    assert.equal((await call(`/api/chats/${id}`, { method: 'DELETE', headers: same })).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'state', 'chats-archived.json'), 'utf8')), [], 'a deleted conversation is not an archived one');
    assert.equal((await post(port, `/api/chats/${id}/archive`, { archived: true }, { ...same, origin: 'https://evil.example' })).status, 403);
  }, { chats });
  chats.close();
});

test('asking about a run: the run goes in front of the question, in a conversation of its own or one that is named', async () => {
  const chats = createChatBroker({ connect: fakeGoose().connect, cwd: '/w' });
  await withUi(async ({ call, port, lines }) => {
    const page = await call(`/recipes/hello/runs/${RUN_ID}`);
    assert.match(page.body, /<form id="ask" data-recipe="hello" data-run="20261005T061300Z-ab12">/);
    assert.match(page.body, /<option value="">a new conversation<\/option>/);
    const same = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const where = `/api/recipes/hello/runs/${RUN_ID}/chat`;
    assert.equal((await post(port, where, { text: 'Und die zweite?' }, { ...same, origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(port, where, { text: ' ' }, same)).status, 400);
    assert.equal((await post(port, where, { text: 'x', chat: '../etc' }, same)).status, 400);
    const long = await post(port, where, { text: 'x'.repeat(2001) }, same);
    assert.equal(long.status, 400, 'a question too long is refused, not cut');
    assert.match(JSON.parse(long.body).error, /at most 2000 characters/);
    assert.equal((await post(port, '/api/recipes/hello/runs/20261012T061300Z-ffff/chat', { text: 'x' }, same)).status, 404);
    const made = await post(port, where, { text: 'Und die zweite Rechnung?' }, same);
    assert.equal(made.status, 202);
    const { chat } = JSON.parse(made.body);
    const said = chats.chats.get(chat).events.find(e => e.type === 'user').text;
    assert.match(said, /Chore: Hello <b>world<\/b> \(hello\)/, 'the title as the recipe file has it, not escaped for a page');
    assert.match(said, new RegExp(`Page: ${ORIGIN}/recipes/hello/runs/${RUN_ID}`));
    assert.match(said, /## Grüessech/, 'what the run wrote');
    assert.ok(said.endsWith('Und die zweite Rechnung?'));
    assert.ok(lines.some(l => l.includes(`asks about hello/${RUN_ID} in ${chat}`)));
    // A conversation that is named is used, and a second question lands in it.
    await new Promise(r => setTimeout(r, 50));
    const again = await post(port, where, { text: 'Noch eine Frage', chat }, same);
    assert.equal(again.status, 202);
    assert.deepEqual(JSON.parse(again.body), { chat });
    assert.equal(chats.chats.get(chat).events.filter(e => e.type === 'user').length, 2);
    assert.deepEqual((await chats.list()).map(c => c.id), [chat], 'no second conversation was made');
    // While goose is still answering, the question is refused rather than lost.
    await new Promise(r => setTimeout(r, 50));
    assert.equal((await post(port, where, { text: 'SLOW', chat }, same)).status, 202);
    assert.equal((await post(port, where, { text: 'und noch eine', chat }, same)).status, 409);
  }, { chats });
  chats.close();
});

test('without the chat a run cannot be asked about, and the page offers nothing', () =>
  withUi(async ({ call, port }) => {
    const page = await call(`/recipes/hello/runs/${RUN_ID}`);
    assert.doesNotMatch(page.body, /id="ask"/);
    const res = await post(port, `/api/recipes/hello/runs/${RUN_ID}/chat`, { text: 'Hoi' }, { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' });
    assert.equal(res.status, 404);
    assert.match(res.body, /the chat is off/);
  }));

test('without a state directory a conversation cannot be put away', async () => {
  const goose = fakeGoose();
  const chats = createChatBroker({ connect: goose.connect, cwd: '/w' });
  await withUi(async ({ port }) => {
    const same = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const { id } = JSON.parse((await post(port, '/api/chats', {}, same)).body);
    const res = await post(port, `/api/chats/${id}/archive`, { archived: true }, same);
    assert.equal(res.status, 503);
    assert.match(JSON.parse(res.body).error, /STATE_DIR/);
  }, { chats, stateDir: false });
  chats.close();
});
