import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { startServer } from '../src/web/server.mjs';
import { createRunDir, writeJsonAtomic } from '../src/store/runs.mjs';

const ORIGIN = 'https://chores.example';
const RUN_ID = '20261012T061300Z-ab12';

/** A fake k8s client with one recipe CronJob; `running` makes its Job active. */
function fakeK8s({ running = false, fail = false } = {}) {
  const started = [];
  return {
    started,
    async listCronJobs() {
      if (fail) throw new Error('api down');
      return [{
        metadata: { name: 'hello-cron', labels: { 'aemtli.sapn.ch/recipe': 'hello' } },
        spec: { schedule: '13 8 * * 1', timeZone: 'Europe/Zurich' },
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
async function withUi(body, { k8s = fakeK8s(), verify = async t => { if (t !== 'good') throw new Error('no'); return { email: 'owner@example.com' }; }, proxy } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aemtli-ui-'));
  const recipesDir = join(root, 'recipes');
  const dataDir = join(root, 'data');
  mkdirSync(recipesDir);
  writeFileSync(join(recipesDir, 'hello.yaml'), 'title: Hello <b>world</b>\ndescription: Says "hi" & leaves\nprompt: hi\n');
  const dir = createRunDir(dataDir, 'hello', RUN_ID);
  writeJsonAtomic(join(dir, 'run.json'), { recipe: 'hello', id: RUN_ID, status: 'succeeded', trigger: 'schedule', startedAt: '2026-10-12T06:13:00Z', durationMs: 4200, tokens: { total: 15 }, model: 'fake-model' });
  writeFileSync(join(dir, 'result.md'), 'Grüessech <script>alert(1)</script>\n');
  writeFileSync(join(dir, 'run.log'), 'log line\n');
  const lines = [];
  const server = await startServer({ k8s, dataDir, recipesDir, verify, proxy, allowedOrigin: ORIGIN, version: '0.0.0-test', log: l => lines.push(l), now: () => new Date('2026-10-11T12:00:00Z') }, { port: 0, host: '127.0.0.1' });
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
    await body({ call, k8s, lines, port });
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
    // Monday 12 October, 08:13 in Zurich.
    assert.match(res.body, /2026-10-12 08:13/);
    assert.match(res.body, /badge succeeded/);
    assert.match(res.body, /paused/);
    assert.match(res.body, /owner@example\.com/);
  }));

test('a recipe page lists its runs, a run page shows the answer escaped', () =>
  withUi(async ({ call }) => {
    const recipe = await call('/recipes/hello');
    assert.equal(recipe.status, 200);
    assert.match(recipe.body, new RegExp(`/recipes/hello/runs/${RUN_ID}`));
    const run = await call(`/recipes/hello/runs/${RUN_ID}`);
    assert.equal(run.status, 200);
    assert.match(run.body, /Grüessech &lt;script&gt;/);
    assert.doesNotMatch(run.body, /<script>alert/);
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
