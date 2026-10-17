import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePolicy } from '../src/gateway/policy.mjs';
import { createApprovals } from '../src/gateway/approvals.mjs';
import { createServer } from 'node:http';
import { startGateway, parseAccount, createGateway } from '../src/gateway/server.mjs';
import { writeJsonAtomic } from '../src/store/runs.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-mcp.mjs', import.meta.url));
const TOKEN = 'admin-token-for-the-tests-0123456789';

test('a policy: exact names and wildcards, deny over approve over allow, approve by default', () => {
  const p = parsePolicy('allow: [read_*, send_thing]\napprove: [send_*]\ndeny: [secret_thing]\n');
  assert.equal(p.decide('read_thing'), 'allow');
  assert.equal(p.decide('send_thing'), 'approve', 'approve wins over allow');
  assert.equal(p.decide('secret_thing'), 'deny');
  assert.equal(p.decide('new_tool'), 'approve', 'a tool nobody listed waits for a decision');
  assert.equal(parsePolicy('default: allow\ndeny: [x]').decide('y'), 'allow');
  assert.equal(parsePolicy('allow: [a.b-c]').decide('aXb-c'), 'approve', 'a dot is a dot, not any character');
  assert.equal(parsePolicy('').decide('anything'), 'approve');
  for (const bad of ['alow: [x]', 'default: maybe', 'allow: x', 'allow: [a b]', 'allow: [1]', '- x']) {
    assert.throws(() => parsePolicy(bad), bad);
  }
});

test('hold_if: an allowed call waits when an argument that makes it outward is filled', () => {
  const p = parsePolicy('allow: [create-event, read_*]\nhold_if:\n  create-event: [body.attendees, notify]\n');
  assert.equal(p.decide('create-event', {}), 'allow');
  assert.equal(p.decide('create-event', { body: { subject: 'Zahnarzt' } }), 'allow');
  assert.equal(p.decide('create-event', { body: { attendees: [] } }), 'allow', 'an empty list sends nothing');
  assert.equal(p.decide('create-event', { body: { attendees: [{ emailAddress: { address: 'a@example.com' } }] } }), 'approve');
  assert.equal(p.decide('create-event', { Body: { ATTENDEES: [{}] } }), 'approve', 'no other spelling slips through');
  assert.equal(p.decide('create-event', { body: { attendees: [], Attendees: [{}] } }), 'approve', 'two spellings: the filled one decides');
  assert.equal(p.decide('create-event', { body: { attendees: '[{"a":1}]' } }), 'approve', 'a list sent as a string counts too');
  assert.equal(p.decide('create-event', { notify: true }), 'approve');
  assert.equal(p.decide('create-event', { notify: false }), 'allow');
  assert.equal(p.decide('create-event'), 'allow', 'without arguments: what the tool is');
  assert.equal(p.decide('read_x', { body: { attendees: [1] } }), 'allow', 'only the tools named');
  assert.deepEqual(p.holdsWhen('create-event'), ['body.attendees', 'notify']);
  assert.equal(parsePolicy('default: allow\nhold_if:\n  x: [a]').decide('x', { a: 1 }), 'approve', 'by default as well');
  assert.equal(parsePolicy('deny: [x]\nhold_if:\n  x: [a]').decide('x', { a: 1 }), 'deny', 'deny stays deny');
  for (const bad of ['hold_if: [x]', 'hold_if:\n  x: a', 'hold_if:\n  x: []', 'hold_if:\n  x: ["a..b"]', 'hold_if:\n  "a b": [c]']) {
    assert.throws(() => parsePolicy(bad), bad);
  }
});

/** Starts a gateway on free ports with the fake server; `body` gets helpers. */
async function withGateway(body, { policy = 'allow: [read_*]\napprove: [send_*]\ndeny: [secret_*]\n', env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aemtli-gw-'));
  writeFileSync(join(dir, 'policy.yaml'), policy);
  writeFileSync(join(dir, 'token'), `${TOKEN}\n`);
  const lines = [];
  const { gateway, servers } = await startGateway({
    MCP_COMMAND: JSON.stringify([process.execPath, FAKE]),
    POLICY_FILE: join(dir, 'policy.yaml'),
    ADMIN_TOKEN_FILE: join(dir, 'token'),
    STATE_DIR: join(dir, 'state'),
    PORT: '0',
    ADMIN_PORT: '0',
    HOST: '127.0.0.1',
    PATH: process.env.PATH,
    FAKE_MCP_SECRET: 's3cret',
    ...env,
  }, { log: l => lines.push(l) });
  const [mcpPort, adminPort] = servers.map(s => s.address().port);
  let nextId = 1;
  const post = async (message, { sid, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}), ...headers },
      body: typeof message === 'string' ? message : JSON.stringify(message),
    });
    const text = await res.text();
    return { status: res.status, sid: res.headers.get('mcp-session-id'), body: text ? JSON.parse(text) : null };
  };
  const rpc = (method, params, sid) => post({ jsonrpc: '2.0', id: nextId++, method, params }, { sid });
  const open = async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.status, 200);
    assert.ok(init.sid);
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { sid: init.sid })).status, 202);
    return init.sid;
  };
  const admin = async (path, { method = 'GET', token = TOKEN } = {}) => {
    const res = await fetch(`http://127.0.0.1:${adminPort}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json() };
  };
  try {
    await body({ post, rpc, open, admin, gateway, lines, dir, mcpPort });
  } finally {
    await gateway.close();
    for (const s of servers) s.close();
  }
}

test('reads pass through, the server keeps its credentials, the gateway its own settings', () =>
  withGateway(async ({ rpc, open }) => {
    const sid = await open();
    const call = await rpc('tools/call', { name: 'read_thing', arguments: { id: '7' } }, sid);
    const text = call.body.result.content[0].text;
    assert.match(text, /^read_thing \{"id":"7"\} call 1 secret=s3cret admin=none account=none$/);
  }));

test('a call is held for its arguments, and the tool says when', () =>
  withGateway(async ({ rpc, open, admin }) => {
    const sid = await open();
    const { tools } = (await rpc('tools/list', {}, sid)).body.result;
    assert.match(tools.find(t => t.name === 'read_thing').description, /With body\.to filled in, it needs the owner's approval/);
    assert.match((await rpc('tools/call', { name: 'read_thing', arguments: { id: '1' } }, sid)).body.result.content[0].text, /^read_thing/);
    const held = await rpc('tools/call', { name: 'read_thing', arguments: { body: { to: ['someone@example.com'] } } }, sid);
    assert.match(held.body.result.content[0].text, /^Not done yet: read_thing needs the owner's approval/);
    assert.equal((await admin('/approvals')).body.approvals[0].tool, 'read_thing');
  }, { policy: 'allow: [read_*]\napprove: [send_*]\ndeny: [secret_*]\nhold_if:\n  read_thing: [body.to]\n' }));

test('the tool list hides what is denied and says what needs approval', () =>
  withGateway(async ({ rpc, open }) => {
    const sid = await open();
    const { tools } = (await rpc('tools/list', {}, sid)).body.result;
    assert.deepEqual(tools.map(t => t.name), ['read_thing', 'send_thing']);
    assert.equal(tools[0].description, 'Reads a thing.');
    assert.match(tools[1].description, /^Sends a thing\.\n\nNeeds the owner's approval/);
    const denied = await rpc('tools/call', { name: 'secret_thing', arguments: {} }, sid);
    assert.equal(denied.body.error.message, 'Unknown tool: secret_thing');
  }));

test('a call that needs approval is held, once, and runs only when approved', () =>
  withGateway(async ({ rpc, open, admin, lines }) => {
    const sid = await open();
    const held = await rpc('tools/call', { name: 'send_thing', arguments: { to: 'Bank' } }, sid);
    const text = held.body.result.content[0].text;
    const id = text.match(/request (\S+) /)[1];
    assert.match(text, /^Not done yet: send_thing needs the owner's approval/);
    // The same call again is the same request, in any key order.
    const again = await rpc('tools/call', { name: 'send_thing', arguments: { to: 'Bank' } }, sid);
    assert.match(again.body.result.content[0].text, new RegExp(`request ${id} `));
    // Nothing ran: the session's first real call is still call 1.
    assert.match((await rpc('tools/call', { name: 'read_thing', arguments: {} }, sid)).body.result.content[0].text, /call 1 /);

    assert.equal((await admin('/approvals', { token: null })).status, 401);
    assert.equal((await admin('/approvals', { token: `${TOKEN}x` })).status, 401);
    const { approvals } = (await admin('/approvals')).body;
    assert.deepEqual(approvals.map(a => [a.id, a.tool, a.status, a.arguments]), [[id, 'send_thing', 'pending', { to: 'Bank' }]]);

    const done = await admin(`/approvals/${id}/approve`, { method: 'POST' });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'done');
    assert.match(done.body.result, /^send_thing \{"to":"Bank"\} call 1 secret=s3cret/, 'in a process of its own');
    assert.equal((await admin(`/approvals/${id}/approve`, { method: 'POST' })).status, 409, 'never twice');
    assert.equal((await admin(`/approvals/${id}/reject`, { method: 'POST' })).status, 409);
    assert.ok(lines.some(l => l === `held send_thing as ${id}`));
    assert.ok(!lines.some(l => l.includes('Bank')), 'arguments stay out of the log');
  }));

test('rejected, failed and crashed calls are recorded as such', () =>
  withGateway(async ({ rpc, open, admin }) => {
    const sid = await open();
    const hold = async args => (await rpc('tools/call', { name: 'send_thing', arguments: args }, sid)).body.result.content[0].text.match(/request (\S+) /)[1];
    const [a, b, c] = [await hold({ to: 'a' }), await hold({ fail: true }), await hold({ crash: true })];
    assert.equal((await admin(`/approvals/${a}/reject`, { method: 'POST' })).body.status, 'rejected');
    const failed = (await admin(`/approvals/${b}/approve`, { method: 'POST' })).body;
    assert.deepEqual([failed.status, failed.result], ['failed', 'could not send_thing']);
    const crashed = (await admin(`/approvals/${c}/approve`, { method: 'POST' })).body;
    assert.equal(crashed.status, 'failed');
    assert.match(crashed.result, /exited \(3\)/);
    assert.equal((await admin('/approvals/nonsense/approve', { method: 'POST' })).status, 404);
    assert.equal((await admin('/approvals/20261011T120000Z-0000000000000000/approve', { method: 'POST' })).status, 409);
  }));

test('nothing reaches the server around the policy', () =>
  withGateway(async ({ post, rpc, open, admin, lines }) => {
    const sid = await open();
    // A tools/call sent as a notification gets no answer and must not run.
    for (const sneaky of [{ jsonrpc: '2.0', method: 'tools/call', params: { name: 'send_thing', arguments: { to: 'x' } } },
      { jsonrpc: '2.0', id: null, method: 'tools/call', params: { name: 'send_thing', arguments: { to: 'y' } } }]) {
      assert.equal((await post(sneaky, { sid })).status, 202);
    }
    assert.ok(lines.some(l => l === 'dropped notification tools/call'));
    // Names the server does not list are unknown, whatever they look like.
    for (const name of ['Send_thing', 'send_thing ', 'send_thing\u200b', 'nope', 42]) {
      assert.match((await rpc('tools/call', { name, arguments: {} }, sid)).body.error.message, /^Unknown tool/, String(name));
    }
    assert.match((await rpc('resources/list', {}, sid)).body.error.message, /not available through the gateway/);
    assert.match((await rpc('prompts/get', { name: 'x' }, sid)).body.error.message, /not available through the gateway/);
    assert.deepEqual((await admin('/approvals')).body.approvals, [], 'nothing was held');
    assert.match((await rpc('tools/call', { name: 'read_thing', arguments: {} }, sid)).body.result.content[0].text, /call 1 /, 'and nothing ran');
  }));

test('the HTTP side refuses what it should', () =>
  withGateway(async ({ post, rpc, open, mcpPort }) => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    assert.equal((await post(init, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await post('{nope')).status, 400);
    assert.equal((await post({ id: 1, method: 'x' })).status, 400, 'not JSON-RPC 2.0');
    assert.equal((await post([init, init])).status, 400, 'initialize comes alone');
    assert.equal((await rpc('tools/list', {})).status, 400, 'no session');
    assert.equal((await rpc('tools/list', {}, 'not-a-session')).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${mcpPort}/mcp`)).status, 405);
    assert.equal((await fetch(`http://127.0.0.1:${mcpPort}/other`, { method: 'POST' })).status, 404);
    assert.equal((await post('x'.repeat(1024 * 1024 + 1))).status, 413);
    const sid = await open();
    // A batch answers in a batch; a server request back to us is refused, not left hanging.
    const batch = await post([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }], { sid });
    assert.deepEqual(batch.body.map(r => r.id), ['a', 'b']);
    const del = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sid } });
    assert.equal(del.status, 204);
    assert.equal((await rpc('tools/list', {}, sid)).status, 404, 'closed');
  }));

test('the store: arguments have a size limit, nobody decides past the time to live, a restart fails what was running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aemtli-ap-'));
  let clock = new Date('2026-10-11T12:00:00Z');
  const store = createApprovals({ dir, ttlMs: 3600_000, now: () => clock });
  assert.throws(() => store.hold('send', { body: 'x'.repeat(70 * 1024) }), /over 64 KB/);
  const old = store.hold('send', { to: 'a' });
  clock = new Date('2026-10-11T13:00:01Z');
  assert.equal(store.claim(old.id, 'running'), null, 'too late');
  assert.equal(store.list()[0].status, 'expired');
  const fresh = store.hold('send', { to: 'a' });
  assert.notEqual(fresh.id, old.id, 'an expired request is not reused');
  assert.equal(store.claim(fresh.id, 'running').status, 'running');
  const again = createApprovals({ dir, ttlMs: 3600_000, now: () => clock });
  const recovered = again.get(fresh.id);
  assert.equal(recovered.status, 'failed');
  assert.match(recovered.result, /restarted while this call ran/);
  assert.equal(store.get('../etc/passwd'), null);
});

test('ids never collide, and the number of waiting calls has a limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aemtli-ap-'));
  const store = createApprovals({ dir, now: () => new Date('2026-10-11T12:00:00Z') });
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(store.hold('send', { i }).id);
  assert.equal(ids.size, 200, 'all in the same second, all different');
  for (const id of ids) assert.match(id, /^20261011T120000Z-[0-9a-f]{16}$/);
  assert.throws(() => store.hold('send', { i: 200 }), /200 calls are waiting/);
  assert.equal(store.hold('send', { i: 3 }).id, [...ids][3], 'one already waiting is still found');
});

test('decided requests beyond `keep` are pruned, pending ones never', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aemtli-ap-'));
  let n = 0;
  const store = createApprovals({ dir, keep: 20, now: () => new Date(Date.UTC(2026, 9, 11, 0, 0, n++)) });
  const pending = store.hold('send', { keep: true });
  for (let i = 0; i < 25; i++) {
    const r = store.hold('send', { i });
    store.claim(r.id, 'rejected');
  }
  store.hold('send', { last: true });
  const files = readdirSync(dir);
  assert.equal(files.length, 20);
  assert.ok(files.includes(`${pending.id}.json`), 'the oldest, but pending');
  assert.equal(JSON.parse(readFileSync(join(dir, `${pending.id}.json`), 'utf8')).status, 'pending');
  writeJsonAtomic(join(dir, 'junk.json'), { status: 'pending' });
  writeFileSync(join(dir, '20261011T000000Z-ffff.json'), '{half');
  assert.equal(createApprovals({ dir, keep: 20 }).list().length, 20, 'files that are not requests are ignored');
});

test('a server that cannot start fails its calls at once, not after the timeout', () =>
  withGateway(async ({ rpc }) => {
    const started = Date.now();
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.match(init.body.error.message, /did not start|exited/);
    assert.ok(Date.now() - started < 5000);
    assert.equal(init.sid, null, 'no session for a failed initialize');
  }, { env: { MCP_COMMAND: '["/nonexistent/mcp-server"]' } }));

test('a gateway will not start half configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aemtli-gw-'));
  writeFileSync(join(dir, 'p'), 'allow: [x]');
  writeFileSync(join(dir, 't'), 'short');
  const base = { MCP_COMMAND: '["node","x.js"]', POLICY_FILE: join(dir, 'p'), ADMIN_TOKEN_FILE: join(dir, 't'), STATE_DIR: dir, PORT: '0', ADMIN_PORT: '0', HOST: '127.0.0.1' };
  await assert.rejects(startGateway({ ...base, MCP_COMMAND: 'node x.js' }), /JSON array/);
  await assert.rejects(startGateway({ ...base, MCP_COMMAND: '[]' }), /JSON array/);
  await assert.rejects(startGateway({ ...base, POLICY_FILE: '' }), /POLICY_FILE/);
  await assert.rejects(startGateway({ ...base, ADMIN_TOKEN_FILE: '' }), /ADMIN_TOKEN_FILE/);
  await assert.rejects(startGateway(base), /at least 16 characters/);
  await assert.rejects(startGateway({ ...base, GATEWAY_ACCOUNT: '{"login":"login"}' }), /GATEWAY_ACCOUNT/);
  writeFileSync(join(dir, 't'), 'a-token-long-enough-for-the-gateway');
  // An agent must not reach the login: the policy has to deny it.
  await assert.rejects(startGateway({ ...base, GATEWAY_ACCOUNT: '{"status":{"tool":"verify"},"login":{"tool":"x"}}' }), /names verify, which the policy must deny/);
  writeFileSync(join(dir, 'p'), 'allow: [x]\ndeny: [verify]');
  await assert.rejects(startGateway({ ...base, GATEWAY_ACCOUNT: '{"status":{"tool":"verify"},"login":{"tool":"x"}}' }), /names x, which the policy must deny/);
});

test('a big answer comes through whole, and one past the limit stops the server', () =>
  withGateway(async ({ rpc, open, lines }) => {
    const sid = await open();
    // A scan of a few megabytes, as base64: these are the answers the backup
    // job reads, and at 4 MB the gateway used to kill the server over them.
    const big = (await rpc('tools/call', { name: 'read_thing', arguments: { bytes: 8 * 1024 * 1024 } }, sid)).body.result.content[0].text;
    assert.equal(big.length, 8 * 1024 * 1024);
    const huge = await rpc('tools/call', { name: 'read_thing', arguments: { bytes: 25 * 1024 * 1024 } }, sid);
    assert.match(huge.body.error?.message ?? huge.body.result?.content?.[0]?.text ?? '', /exited|did not start/);
    assert.ok(lines.some(l => /sent a line over 24 MB/.test(l)), lines.join(' | '));
  }));

const ACCOUNT = JSON.stringify({ status: { tool: 'secret_status' }, login: { tool: 'secret_login', arguments: { force: true } } });

test('GATEWAY_ACCOUNT: a status, a login or both, each a tool with optional arguments', () => {
  assert.equal(parseAccount(''), null);
  assert.equal(parseAccount(undefined), null);
  assert.deepEqual(parseAccount('{"status":{"tool":"verify-login"}}'), { status: { tool: 'verify-login' }, login: null });
  assert.deepEqual(parseAccount(ACCOUNT).login, { tool: 'secret_login', arguments: { force: true } });
  for (const bad of ['nope', '[]', '{}', '{"status":{}}', '{"login":{"tool":"x"}}', '{"status":{"tool":"s"},"login":{"tool":""}}', '{"status":{"tool":"s"},"login":{"tool":"x","arguments":[1]}}', '{"status":"verify-login"}']) {
    assert.throws(() => parseAccount(bad), /GATEWAY_ACCOUNT/, bad);
  }
});

test('without GATEWAY_ACCOUNT there is no login to tell or renew', () =>
  withGateway(async ({ admin }) => {
    assert.equal((await admin('/account')).status, 404);
    assert.equal((await admin('/account/login', { method: 'POST' })).status, 404);
  }));

test('the owner sees and renews the server\'s login through the admin port, around the policy', () =>
  withGateway(async ({ rpc, open, admin, lines }) => {
    assert.equal((await admin('/account', { token: 'wrong-token-wrong-token' })).status, 401);
    assert.equal((await admin('/account/login', { method: 'POST', token: null })).status, 401);
    // Agents do not see the login tools, and cannot call them.
    const sid = await open();
    assert.ok(!(await rpc('tools/list', {}, sid)).body.result.tools.some(t => t.name.startsWith('secret_')));
    assert.equal((await rpc('tools/call', { name: 'secret_login', arguments: {} }, sid)).body.error.message, 'Unknown tool: secret_login');
    // And GATEWAY_ACCOUNT stays with the gateway.
    assert.match((await rpc('tools/call', { name: 'read_thing', arguments: {} }, sid)).body.result.content[0].text, /account=none$/);

    const before = await admin('/account');
    assert.equal(before.status, 200);
    assert.equal(JSON.parse(before.body.text).success, false);
    const started = await admin('/account/login', { method: 'POST' });
    assert.equal(started.status, 200);
    assert.equal(started.body.ok, true);
    const answer = JSON.parse(started.body.text);
    assert.equal(answer.error, 'device_code_required');
    assert.match(answer.message, /code ABCD1234/);
    assert.equal(answer.force, true, 'with the arguments GATEWAY_ACCOUNT gives');
    assert.ok(lines.includes('login with secret_login'));
    // The login completes after the tool answered, in the same process: only
    // a gateway that kept that process up and asks it learns of it.
    await new Promise(resolve => setTimeout(resolve, 250));
    const told = (await admin('/account')).body;
    assert.equal(told.canLogin, true);
    const after = JSON.parse(told.text);
    assert.equal(after.success, true);
    assert.equal(after.userData.userPrincipalName, 'example@example.com');
    assert.equal(after.pid, answer.pid, 'asked in the process that logs in');
    // A second login starts over in a process of its own, and ends the first.
    const second = JSON.parse((await admin('/account/login', { method: 'POST' })).body.text);
    assert.notEqual(second.pid, answer.pid);
    assert.ok(!alive(answer.pid), 'the first login\'s process is gone');
    assert.equal(JSON.parse((await admin('/account')).body.text).success, false);
  }, { env: { GATEWAY_ACCOUNT: ACCOUNT } }));

/** Whether a process still runs. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('logins asked for at once run one after the other, and leave no process behind', async () => {
  let pids = [];
  await withGateway(async ({ admin }) => {
    const all = await Promise.all([1, 2, 3].map(() => admin('/account/login', { method: 'POST' })));
    pids = all.map(r => JSON.parse(r.body.text).pid);
    assert.equal(new Set(pids).size, 3, 'three logins, three processes');
    assert.deepEqual(pids.slice(0, 2).map(alive), [false, false], 'each ended by the next');
    assert.equal(alive(pids[2]), true, 'the last one waits for its code');
  }, { env: { GATEWAY_ACCOUNT: ACCOUNT } });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(pids.map(alive), [false, false, false], 'and closing the gateway ends that one too');
});

test('a status-only account can be told but not renewed, and the status is shared while it runs', () =>
  withGateway(async ({ admin, lines }) => {
    const [a, b] = await Promise.all([admin('/account'), admin('/account')]);
    assert.equal(a.body.canLogin, false);
    assert.equal(JSON.parse(a.body.text).pid, JSON.parse(b.body.text).pid, 'one process answered both');
    assert.equal((await admin('/account/login', { method: 'POST' })).status, 404);
    assert.ok(!lines.some(l => l.startsWith('login')));
  }, { env: { GATEWAY_ACCOUNT: JSON.stringify({ status: { tool: 'secret_status' } }) } }));

test('a login\'s process lives as long as a code does, and then the status comes from a fresh one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aemtli-gw-'));
  const gateway = createGateway({
    command: [process.execPath, FAKE],
    env: { PATH: process.env.PATH },
    policy: parsePolicy('deny: [secret_*]'),
    approvals: createApprovals({ dir }),
    adminToken: TOKEN,
    account: parseAccount(ACCOUNT),
    log: () => {},
    loginMs: 400,
  });
  const server = createServer((req, res) => gateway.admin(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const admin = async (path, method = 'GET') => (await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}` } })).json();
  try {
    const { pid } = JSON.parse((await admin('/account/login', 'POST')).text);
    assert.equal(JSON.parse((await admin('/account')).text).pid, pid);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.ok(!alive(pid), 'ended when its time was up');
    const later = JSON.parse((await admin('/account')).text);
    assert.notEqual(later.pid, pid);
    assert.equal(later.success, false, 'a fresh process knows only what was written down');
  } finally {
    await gateway.close();
    server.close();
  }
});
