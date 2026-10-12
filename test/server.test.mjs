import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { startServer } from '../src/web/server.mjs';
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
async function withUi(body, { k8s = fakeK8s(), now = '2026-10-11T12:00:00Z', moreRuns = [], fixtureRun = true, stateDir = true, verify = async t => { if (t !== 'good') throw new Error('no'); return { email: 'owner@example.com' }; }, proxy } = {}) {
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
  const server = await startServer({ k8s, dataDir, recipesDir, verify, proxy, allowedOrigin: ORIGIN, version: '0.0.0-test', timeZone: 'Europe/Zurich', stateDir: stateDir ? join(root, 'state') : null, log: l => lines.push(l), now: () => new Date(now) }, { port: 0, host: '127.0.0.1' });
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
    assert.match(res.body, /<p class="when" title="13 8 \* \* 1 \(Europe\/Zurich\)">Mondays at 08:13<\/p>/);
    assert.doesNotMatch(res.body, />13 8 \* \* 1</, 'no cron in the text, only in the tooltip');
    // When it runs next, said the way a person would.
    assert.match(res.body, /<span class="next">tomorrow 08:13<\/span>/);
    assert.match(res.body, /title="Says &quot;hi&quot; &amp; leaves"/, 'what it does is on the name');
    assert.doesNotMatch(res.body, /title=""/, 'and no empty tooltip where there is none');
    // This week (5 to 11 Oct, Sunday is today): Monday's run is ticked off and links to it.
    assert.match(res.body, /<h1 id="plan-title">This week<\/h1><p>5 Oct to 11 Oct<\/p>/);
    assert.match(res.body, new RegExp(`<a class="mark succeeded" href="/recipes/hello/runs/${RUN_ID}">✓</a>`));
    assert.match(res.body, /<li class="day ran" title="Mon 5 Oct: done at 08:13">/, 'the day carries its run');
    assert.match(res.body, /<li class="day today" title="Sun 11 Oct: nothing">/, 'and today is marked as today');
    assert.match(res.body, /Mon 5 Oct: done at 08:13/, 'every day says what it holds');
    // The paused one runs only by hand and has nothing due.
    assert.match(res.body, /<span class="next">only by hand<\/span>/);
    assert.match(res.body, /Paused\. Normally every day at 00:00 \(UTC\)/, 'a zone other than the page\'s is named');
    assert.match(res.body, /<span class="status succeeded">Done<\/span>/);
    assert.match(res.body, /<link rel="icon" href="\/static\/icon\.svg" type="image\/svg\+xml">/);
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

test('the chat page carries goose\'s working directory', () =>
  withUi(async ({ call }) => {
    const res = await call('/chat');
    assert.match(res.body, /data-cwd="\/data\/workspace"/);
    assert.match(res.body, /\/static\/chat\.js/);
  }));

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

test('/acp upgrades only with a token and a proxy, other paths never', async () => {
  const proxied = [];
  const proxy = (req, socket) => { proxied.push(req.url); socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); };
  const upgrade = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') };
  await withUi(async ({ call }) => {
    assert.equal((await call('/acp', { token: null, headers: upgrade })).status, 403);
    assert.equal((await call('/other', { headers: upgrade })).status, 403);
    assert.equal((await call('/acp', { headers: upgrade })).status, 101);
    assert.deepEqual(proxied, ['/acp']);
  }, { proxy });
  await withUi(async ({ call }) => {
    assert.equal((await call('/acp', { headers: upgrade })).status, 403, 'no proxy, no chat');
  });
});

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
