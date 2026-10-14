import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGateways, createGatewayClient, createNotifier, toolWords } from '../src/web/approvals.mjs';
import { needsYou } from '../src/web/pages.mjs';
import { startGateway } from '../src/gateway/server.mjs';
import { startServer } from '../src/web/server.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-mcp.mjs', import.meta.url));
const TOKEN = 'gateway-token-for-the-tests-0123456789';
const ORIGIN = 'https://chores.example';

test('GATEWAYS: a JSON list with a token file per gateway, or a clear error', () => {
  const read = path => ({ '/t/epost': 'tok-e\n', '/t/pingen': 'tok-p' })[path];
  const list = parseGateways('[{"name":"epost","title":"ePost","url":"http://aemtli-mcp-epost:8081/","mcp":"http://aemtli-mcp-epost:8080/mcp"},{"name":"pingen","url":"https://p.example"}]', '/t', read);
  assert.deepEqual(list, [
    { name: 'epost', title: 'ePost', url: 'http://aemtli-mcp-epost:8081', mcp: 'http://aemtli-mcp-epost:8080/mcp', token: 'tok-e' },
    { name: 'pingen', title: 'pingen', url: 'https://p.example', token: 'tok-p' },
  ]);
  assert.deepEqual(createGatewayClient({ gateways: list }).mcpServers, [{ type: 'http', name: 'epost', url: 'http://aemtli-mcp-epost:8080/mcp', headers: [] }]);
  assert.throws(() => parseGateways('[{"name":"a","url":"http://x","mcp":"ftp://y"}]', '/t', () => 'x'), /http or https/);
  assert.deepEqual(parseGateways(undefined, undefined), []);
  assert.deepEqual(parseGateways('[]', undefined), []);
  for (const [spec, why] of [
    ['epost=http://x', /must be JSON/],
    ['{"name":"x"}', /JSON list/],
    ['[{"name":"Epost","url":"http://x"}]', /lower case/],
    ['[{"name":"a","url":"http://x"},{"name":"a","url":"http://y"}]', /unique/],
    ['[{"name":"a","url":"file:///etc"}]', /http or https/],
  ]) assert.throws(() => parseGateways(spec, '/t', () => 'x'), why, spec);
  assert.throws(() => parseGateways('[{"name":"a","url":"http://x"}]', undefined), /GATEWAY_TOKENS_DIR/);
  // A gateway with a token file of its own needs no directory.
  const own = parseGateways('[{"name":"kanban","url":"http://k:8081","tokenFile":"/secrets/kanban/token"}]', undefined, path => ({ '/secrets/kanban/token': 'tok-k\n' })[path]);
  assert.equal(own[0].token, 'tok-k');
  assert.equal(parseGateways('[{"name":"epost","url":"http://e"},{"name":"kanban","url":"http://k","tokenFile":"/k"}]', '/t', path => path).map(g => g.token).join(' '), '/t/epost /k');
  assert.throws(() => parseGateways('[{"name":"a","url":"http://x","tokenFile":"rel/token"}]', '/t', () => 'x'), /absolute path/);
});

test('the owner sees every argument whole, and what would hide is shown', () => {
  const long = `${'a'.repeat(5000)}THE END`;
  const html = needsYou({ items: [{ gateway: 'epost', gatewayTitle: 'ePost', tool: 'epost_send', id: 'x', requestedAt: '2026-10-11T12:00:00Z',
    arguments: Object.fromEntries([...Array.from({ length: 40 }, (_, i) => [`k${i}`, i]), ['to', 'Ba\u202Enk\u200b'], ['body', long]]) }], unreachable: [] }, 'UTC');
  assert.match(html, /THE END/, 'no cut');
  assert.match(html, /<dt>k39<\/dt>/, 'no key left out');
  assert.match(html, /Ba<span class="hidden-char">U\+202E<\/span>nk<span class="hidden-char">U\+200B<\/span>/);
  assert.match(html, /<code class="tool">epost_send<\/code>/, 'the real tool name next to the words');
});

test('tool names read as words, without the gateway prefix', () => {
  assert.equal(toolWords('epost_send_letter', 'epost'), 'send letter');
  assert.equal(toolWords('send-mail', 'ms365'), 'send mail');
});

/** A gateway with the fake server, plus a held call in it. */
async function withGateway(body) {
  const dir = mkdtempSync(join(tmpdir(), 'aemtli-apw-'));
  writeFileSync(join(dir, 'policy.yaml'), 'allow: [read_*]\napprove: [send_*]\n');
  writeFileSync(join(dir, 'token'), TOKEN);
  const { gateway, servers } = await startGateway({
    MCP_COMMAND: JSON.stringify([process.execPath, FAKE]), POLICY_FILE: join(dir, 'policy.yaml'), ADMIN_TOKEN_FILE: join(dir, 'token'),
    STATE_DIR: join(dir, 'state'), PORT: '0', ADMIN_PORT: '0', HOST: '127.0.0.1', PATH: process.env.PATH,
  }, { log: () => {} });
  const [mcpPort, adminPort] = servers.map(s => s.address().port);
  const rpc = async (method, params, sid) => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { sid: res.headers.get('mcp-session-id'), body: await res.json() };
  };
  const { sid } = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const hold = async args => (await rpc('tools/call', { name: 'send_thing', arguments: args }, sid)).body.result.content[0].text.match(/request (\S+) /)[1];
  try {
    await body({ url: `http://127.0.0.1:${adminPort}`, hold, dir });
  } finally {
    await gateway.close();
    for (const s of servers) s.close();
  }
}

test('the client lists held calls, decides them, and names a gateway that does not answer', () =>
  withGateway(async ({ url, hold }) => {
    const id = await hold({ to: 'Bank' });
    const client = createGatewayClient({ gateways: [
      { name: 'fake', title: 'Fake', url, token: TOKEN },
      { name: 'gone', title: 'Gone', url: 'http://127.0.0.1:1', token: TOKEN },
      { name: 'wrong', title: 'Wrong', url, token: `${TOKEN}x` },
    ] });
    const { items, unreachable } = await client.pending();
    assert.deepEqual(items.map(r => [r.gateway, r.gatewayTitle, r.id, r.status]), [['fake', 'Fake', id, 'pending']]);
    assert.deepEqual(unreachable.map(u => [u.name, u.error.startsWith('answered 401') || u.error]), [['gone', 'fetch failed'], ['wrong', true]]);
    const done = await client.decide('fake', id, 'approve');
    assert.deepEqual([done.status, done.body.status], [200, 'done']);
    assert.equal((await client.pending()).items.length, 0);
    assert.equal((await client.all()).items[0].status, 'done');
    assert.equal((await client.decide('nope', id, 'approve')).status, 404);
  }));

test('one push per new held call, with no arguments in it, and none twice, also after a restart', () =>
  withGateway(async ({ url, hold, dir }) => {
    const pushes = [];
    let fail = false;
    const ntfy = createServer((req, res) => {
      let text = '';
      req.on('data', c => { text += c; });
      req.on('end', () => {
        pushes.push({ path: req.url, headers: req.headers, text });
        res.writeHead(fail ? 500 : 200).end('{}');
      });
    });
    await new Promise(r => ntfy.listen(0, '127.0.0.1', r));
    const ntfyUrl = `http://127.0.0.1:${ntfy.address().port}`;
    const client = createGatewayClient({ gateways: [{ name: 'fake', title: 'Fake', url, token: TOKEN }] });
    const lines = [];
    const make = () => createNotifier({ client, ntfyUrl, topic: 'chores', token: 'ntfy-tok', stateFile: join(dir, 'notified.json'), clickUrl: `${ORIGIN}/#needs`, log: l => lines.push(l) });
    try {
      const first = await hold({ to: 'Secret Bank AG' });
      await make().tick();
      assert.equal(pushes.length, 1);
      const [push] = pushes;
      assert.equal(push.path, '/chores');
      assert.equal(push.headers.title, 'Fake: send thing');
      assert.equal(push.headers.click, `${ORIGIN}/#needs`);
      assert.equal(push.headers.authorization, 'Bearer ntfy-tok');
      assert.equal(push.text, 'Waiting for your approval.');
      assert.ok(!JSON.stringify(push).includes('Secret Bank'), 'the arguments stay on the Pi');

      const notifier = make();
      await notifier.tick();
      assert.equal(pushes.length, 1, 'a restart does not send it again');
      fail = true;
      await hold({ to: 'b' });
      await notifier.tick();
      assert.ok(lines.some(l => /could not notify fake\/.*ntfy answered 500/.test(l)));
      fail = false;
      await notifier.tick();
      assert.equal(pushes.length, 3, 'a failed push is tried again');
      await client.decide('fake', first, 'reject');
      await notifier.tick();
      assert.equal(JSON.parse(readFileSync(join(dir, 'notified.json'), 'utf8')).length, 1, 'decided ones are forgotten');

      // A burst: five pushes, then one that counts the rest.
      for (let i = 0; i < 7; i++) await hold({ burst: i });
      await notifier.tick();
      assert.deepEqual(pushes.slice(3).map(p => p.headers.title), [...Array(5).fill('Fake: send thing'), '2 more calls']);
      await notifier.tick();
      assert.equal(pushes.length, 9, 'and none of the seven again');
    } finally {
      ntfy.close();
    }
  }));

test('the UI shows held calls with their arguments escaped, and decides them same-origin only', () =>
  withGateway(async ({ url, hold, dir }) => {
    const id = await hold({ to: '<script>alert(1)</script>', body: 'line one\nline two' });
    mkdirSync(join(dir, 'recipes'));
    const k8s = { listCronJobs: async () => [], listJobs: async () => [] };
    const gateways = createGatewayClient({ gateways: [{ name: 'fake', title: 'Fake <i>', url, token: TOKEN }] });
    const server = await startServer({ k8s, dataDir: join(dir, 'data'), recipesDir: join(dir, 'recipes'), verify: null, allowedOrigin: ORIGIN, version: 't', gateways, log: () => {} }, { port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const page = await (await fetch(`${base}/`)).text();
      assert.match(page, /<h2 id="needs-title">Needs you<\/h2>/);
      assert.match(page, /<span class="gw">Fake &lt;i&gt;<\/span> wants to <strong>send thing<\/strong>/);
      assert.match(page, /<dt>to<\/dt><dd>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/dd>/);
      assert.match(page, /<dt>body<\/dt><dd><pre>line one\nline two<\/pre><\/dd>/, 'more than one line is a block');
      assert.doesNotMatch(page, /<script>alert/);
      assert.match(page, new RegExp(`<button class="approve" data-gateway="fake" data-id="${id}">Approve</button>`));

      const decide = (verb, headers) => fetch(`${base}/api/approvals/fake/${id}/${verb}`, { method: 'POST', headers });
      assert.equal((await decide('approve', { origin: 'https://evil.example' })).status, 403);
      assert.equal((await decide('approve', { origin: ORIGIN, 'sec-fetch-site': 'cross-site' })).status, 403);
      assert.equal((await fetch(`${base}/api/approvals/fake/../x/approve`, { method: 'POST', headers: { origin: ORIGIN } })).status, 404);
      const ok = await decide('approve', { origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).status, 'done');
      assert.equal((await decide('reject', { origin: ORIGIN })).status, 409);

      const chat = await (await fetch(`${base}/chat`)).text();
      assert.match(chat, /The chat is off/, 'no goose serve here');
      assert.doesNotMatch(page, /say-text/, 'nothing to tell goose without a chat');

      const history = await (await fetch(`${base}/approvals`)).text();
      assert.match(history, /<span class="status succeeded">Done<\/span>/);
      assert.match(history, /<pre class="result">send_thing/);
      assert.doesNotMatch(await (await fetch(`${base}/`)).text(), /Needs you/, 'nothing left to decide');
    } finally {
      server.close();
    }
  }));

test('without gateways the UI says how to add one, and refuses decisions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aemtli-apw-'));
  mkdirSync(join(dir, 'recipes'));
  const k8s = { listCronJobs: async () => [], listJobs: async () => [] };
  const server = await startServer({ k8s, dataDir: dir, recipesDir: join(dir, 'recipes'), verify: null, version: 't', log: () => {} }, { port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.match(await (await fetch(`${base}/approvals`)).text(), /No gateways yet/);
    const decide = `${base}/api/approvals/x/20261011T120000Z-0000000000000000/approve`;
    assert.equal((await fetch(decide, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status, 404);
    // No PUBLIC_ORIGIN and no Sec-Fetch-Site: nothing shows the post comes from this page.
    assert.equal((await fetch(decide, { method: 'POST' })).status, 403);
  } finally {
    server.close();
  }
});

test('a decision can carry a word to goose, and the decision stands if that fails', () =>
  withGateway(async ({ url, hold, dir }) => {
    mkdirSync(join(dir, 'recipes'));
    const k8s = { listCronJobs: async () => [], listJobs: async () => [] };
    const gateways = createGatewayClient({ gateways: [{ name: 'fake', title: 'Fake', url, token: TOKEN }] });
    // A chat that takes a message, and one conversation to take it.
    const said = [];
    const chats = {
      list: async () => [{ id: 'newest', title: 'Newest', status: 'idle' }, { id: 'older', title: 'Older', status: 'idle' }],
      say: async (id, text) => {
        if (id === 'busy') throw Object.assign(new Error('goose is still answering'), { status: 409 });
        said.push([id, text]);
      },
    };
    const server = await startServer({ k8s, dataDir: join(dir, 'data'), recipesDir: join(dir, 'recipes'), verify: null, allowedOrigin: ORIGIN, version: 't', gateways, chats, log: () => {} }, { port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${server.address().port}`;
    const decide = (id, verb, body) => fetch(`${base}/api/approvals/fake/${id}/${verb}`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    try {
      // A word with the decision, into the conversation he picked.
      const a = await hold({ to: 'a' });
      const page = await (await fetch(`${base}/`)).text();
      assert.match(page, /class="say-text"/, 'a box to tell goose');
      assert.match(page, /<option value="">the newest conversation<\/option>/);
      assert.match(await (await fetch(`${base}/approvals`)).text(), /class="say-text"/, 'and on the approvals page');
      const first = await decide(a, 'reject', { say: 'Use the other date', chat: 'older' });
      assert.equal(first.status, 200);
      const body = await first.json();
      assert.equal(body.status, 'rejected');
      assert.equal(body.said, 'older');
      assert.deepEqual(said, [['older', 'Use the other date']]);

      // No conversation named: the newest one.
      const b = await hold({ to: 'b' });
      assert.equal((await (await decide(b, 'reject', { say: 'Ask me first' })).json()).said, 'newest');
      assert.deepEqual(said.at(-1), ['newest', 'Ask me first']);

      // goose busy: the rejection stands and the reason says what to do.
      const c = await hold({ to: 'c' });
      const busy = await (await decide(c, 'reject', { say: 'Not like that', chat: 'busy' })).json();
      assert.equal(busy.status, 'rejected');
      assert.equal(busy.said, false);
      assert.match(busy.sayError, /say it in the chat in a moment/);

      // An id that could name no conversation, and a chat with none at all.
      const e = await hold({ to: 'e' });
      const bad = await (await decide(e, 'reject', { say: 'hey', chat: '../etc/passwd' })).json();
      assert.equal(bad.status, 'rejected');
      assert.equal(bad.said, false);
      assert.match(bad.sayError, /no conversation to tell/);

      // A body that is not JSON is refused before anything is decided.
      const f = await hold({ to: 'f' });
      const broken = await fetch(`${base}/api/approvals/fake/${f}/reject`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: '{"say": "half',
      });
      assert.equal(broken.status, 400);
      assert.equal((await (await decide(f, 'reject', {})).json()).status, 'rejected', 'still there to decide');

      // An empty word is no word at all, and nothing is said.
      const d = await hold({ to: 'd' });
      const quiet = await (await decide(d, 'reject', { say: '   ' })).json();
      assert.equal(quiet.said, undefined);
      assert.equal(said.length, 2);

      // A word with a call that was already decided tells nobody.
      assert.equal((await decide(d, 'reject', { say: 'again' })).status, 409);
      assert.equal(said.length, 2);
    } finally {
      server.close();
    }
  }));
