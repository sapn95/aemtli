// The MCP gateway: one pod per MCP server, and the only place that server's
// credentials live. Agents reach it over MCP's Streamable HTTP transport and
// it speaks stdio to the server, one process per client session. On the way
// it applies the policy: a tool on the approve list does not run, it is held
// until the owner decides in the ämtli UI. The UI reaches the held calls
// through a second port, with a token the agents never get.
//
// The same port lets the owner see and renew the server's own login, where
// the server has one (GATEWAY_ACCOUNT names its tools). Agents are denied
// those tools by the policy; the owner reaches them here, around it.
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnChild } from './child.mjs';
import { parsePolicy } from './policy.mjs';
import { createApprovals, APPROVAL_ID } from './approvals.mjs';

const MAX_BODY = 1024 * 1024;
const PROTOCOL = '2025-06-18';
// What passes to the server. Resources, prompts, completions and the rest are
// not policed, so they are not forwarded either.
const REQUESTS = new Set(['initialize', 'ping', 'tools/list', 'tools/call']);
const NOTIFICATIONS = new Set(['notifications/initialized', 'notifications/cancelled']);

/**
 * Reads a request body up to `max` bytes; rejects beyond that. An oversized
 * body is read to its end first (up to eight times the limit), so the client
 * gets its 413 instead of a closed socket.
 */
function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 8 * max) req.destroy();
      else if (size <= max) chunks.push(chunk);
    });
    req.on('end', () => (size > max ? reject(new Error('too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/** What the agent is told when its call is held. */
function heldText(tool, id) {
  return `Not done yet: ${tool} needs the owner's approval. The call is waiting as request ${id} and runs when they approve it. `
    + 'Do not call it again. Say in your answer that it is waiting for approval.';
}

/** The text of a tools/call result. */
function resultText(result) {
  const parts = (result?.content ?? []).map(c => (c.type === 'text' ? c.text : `[${c.type}]`));
  return parts.join('\n') || JSON.stringify(result ?? null);
}

/**
 * Reads GATEWAY_ACCOUNT: the tools that tell and renew the server's login,
 * as {"status":{"tool":"verify-login"},"login":{"tool":"login","arguments":{"force":true}}}.
 * Either may be missing. Null when unset.
 */
export function parseAccount(spec) {
  if (!spec) return null;
  let account;
  try {
    account = JSON.parse(spec);
  } catch {
    account = null;
  }
  const valid = step => step === undefined || (step && typeof step.tool === 'string' && step.tool
    && (step.arguments === undefined || (step.arguments && typeof step.arguments === 'object' && !Array.isArray(step.arguments))));
  if (!account || typeof account !== 'object' || !valid(account.status) || !valid(account.login) || !(account.status || account.login)) {
    throw new Error('GATEWAY_ACCOUNT must be JSON: {"status":{"tool":"verify-login"},"login":{"tool":"login"}}');
  }
  return { status: account.status ?? null, login: account.login ?? null };
}

/**
 * Builds the two handlers. `command` is the MCP server's argv, `env` its
 * environment, `policy` from parsePolicy, `approvals` from createApprovals,
 * `account` from parseAccount. A login's process lives `loginMs` at most.
 */
export function createGateway({ command, env = process.env, policy, approvals, adminToken, account = null, version = '0', log = console.log, idleMs = 15 * 60_000, maxSessions = 8, timeoutMs = 120_000, loginMs = 15 * 60_000 }) {
  if (!adminToken || adminToken.length < 16) throw new Error('the admin token must be at least 16 characters');
  const sessions = new Map();
  const childOptions = { env, timeoutMs, log };

  // Sessions nobody used for a while are closed; their process with them.
  const reaper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, s] of sessions) if (s.last < cutoff) close(id);
  }, Math.min(idleMs, 60_000));
  reaper.unref();

  function close(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.child.close();
  }

  function filterTools(tools) {
    return tools.filter(t => policy.decide(t.name) !== 'deny').map(t => {
      if (policy.decide(t.name) === 'approve') {
        return { ...t, description: `${t.description ?? ''}\n\nNeeds the owner's approval: the call waits until they decide.`.trim() };
      }
      const holds = policy.holdsWhen(t.name);
      return holds.length
        ? { ...t, description: `${t.description ?? ''}\n\nWith ${holds.join(' or ')} filled in, it needs the owner's approval: the call waits until they decide.`.trim() }
        : t;
    });
  }

  /** The names the server itself lists, asked once per session. */
  async function listed(session) {
    if (!session.tools) {
      const response = await session.child.request('tools/list', {});
      session.tools = new Set((response.result?.tools ?? []).map(t => t.name));
    }
    return session.tools;
  }

  async function handle(session, message) {
    const reply = r => ({ jsonrpc: '2.0', id: message.id, ...(r.error ? { error: r.error } : { result: r.result }) });
    const fail = (code, text) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
    if (!REQUESTS.has(message.method)) return fail(-32601, `${message.method} is not available through the gateway`);
    try {
      if (message.method === 'tools/call') {
        const name = message.params?.name;
        // Only a name the server lists can be held or run: no variant spelling
        // reaches the owner's screen or the server.
        if (typeof name !== 'string' || !(await listed(session)).has(name)) return fail(-32602, `Unknown tool: ${name}`);
        const decision = policy.decide(name, message.params?.arguments ?? {});
        if (decision === 'deny') return fail(-32602, `Unknown tool: ${name}`);
        if (decision === 'approve') {
          const held = approvals.hold(name, message.params?.arguments ?? {});
          log(`held ${name} as ${held.id}`);
          return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: heldText(name, held.id) }] } };
        }
        log(`call ${name}`);
      }
      const response = await session.child.request(message.method, message.params);
      if (message.method === 'tools/list' && Array.isArray(response.result?.tools)) {
        response.result.tools = filterTools(response.result.tools);
      }
      return reply(response);
    } catch (err) {
      return { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: err.message } };
    }
  }

  /** The Streamable HTTP endpoint, for agents. */
  async function mcp(req, res) {
    const path = req.url.split('?')[0];
    if (path === '/healthz') return json(res, 200, { ok: true });
    if (path !== '/mcp') return json(res, 404, { error: 'not found' });
    // No browser has any business here; refusing an Origin keeps a web page
    // from reaching the gateway through DNS rebinding.
    if (req.headers.origin) return json(res, 403, { error: 'no browsers' });
    const sid = req.headers['mcp-session-id'];
    if (req.method === 'DELETE') {
      if (!sid || !sessions.has(sid)) return json(res, 404, { error: 'no such session' });
      close(sid);
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'POST or DELETE' }, { allow: 'POST, DELETE' });

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return json(res, err.message === 'too large' ? 413 : 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    const messages = Array.isArray(body) ? body : [body];
    if (!messages.length || !messages.every(m => m && typeof m === 'object' && m.jsonrpc === '2.0')) {
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
    }

    let session;
    let created = null;
    if (messages.some(m => m.method === 'initialize')) {
      if (messages.length !== 1) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'initialize comes alone' } });
      if (sessions.size >= maxSessions) {
        const [oldest] = [...sessions.entries()].sort((a, b) => a[1].last - b[1].last);
        close(oldest[0]);
      }
      created = randomUUID();
      session = { child: spawnChild(command, childOptions), last: Date.now() };
      sessions.set(created, session);
      session.child.exited.then(() => sessions.delete(created));
    } else {
      if (!sid) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Mcp-Session-Id is missing' } });
      session = sessions.get(sid);
      if (!session) return json(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'no such session' } });
    }
    session.last = Date.now();

    const replies = [];
    for (const message of messages) {
      if (message.method && message.id !== undefined && message.id !== null) replies.push(await handle(session, message));
      // A notification gets no answer, so only the harmless ones pass. A
      // tools/call without an id would otherwise reach the server unpoliced.
      else if (NOTIFICATIONS.has(message.method)) session.child.notify(message.method, message.params);
      else if (message.method) log(`dropped notification ${String(message.method).slice(0, 60)}`);
      // A response from the client would answer a request of ours; we send none.
    }
    // A session whose initialize failed is gone before the client learns its id.
    if (created && replies[0]?.error) close(created);
    const headers = created && sessions.has(created) ? { 'mcp-session-id': created } : {};
    if (!replies.length) {
      res.writeHead(202, headers);
      return res.end();
    }
    return json(res, 200, Array.isArray(body) ? replies : replies[0], headers);
  }

  /** Calls one tool in `child`, whose MCP conversation has begun. */
  async function toolCall(child, tool, args) {
    const response = await child.request('tools/call', { name: tool, arguments: args });
    if (response.error) return { ok: false, text: response.error.message };
    return { ok: !response.result?.isError, text: resultText(response.result) };
  }

  /** Begins the MCP conversation with `child` and calls one tool in it. */
  async function callIn(child, tool, args) {
    const init = await child.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'aemtli-gateway', version } }, 30_000);
    if (init.error) throw new Error(`initialize: ${init.error.message}`);
    child.notify('notifications/initialized');
    return toolCall(child, tool, args);
  }

  /** Runs an approved call in a process of its own. */
  async function execute(record) {
    const child = spawnChild(command, childOptions);
    try {
      return await callIn(child, record.tool, record.arguments);
    } catch (err) {
      return { ok: false, text: err.message };
    } finally {
      await child.close();
    }
  }

  // A device-code login goes on after its tool has answered: the server
  // waits for the owner to enter the code, then writes its token cache. So
  // its process stays up for as long as a code is good, and a new login
  // ends the one before. While it is up, the status is asked there: that
  // process knows first, and no second one reads a cache it is writing.
  let login = null;
  function endLogin() {
    if (!login) return Promise.resolve();
    const { child, timer } = login;
    login = null;
    clearTimeout(timer);
    return child.close();
  }

  async function startLogin() {
    await endLogin();
    const child = spawnChild(command, childOptions);
    const timer = setTimeout(() => { if (login?.child === child) endLogin(); }, loginMs);
    timer.unref();
    login = { child, timer, ready: false };
    child.exited.then(() => { if (login?.child === child) endLogin(); });
    try {
      const outcome = await callIn(child, account.login.tool, account.login.arguments ?? {});
      if (login?.child === child) login.ready = true;
      return outcome;
    } catch (err) {
      if (login?.child === child) await endLogin();
      return { ok: false, text: err.message };
    }
  }

  const expected = Buffer.from(`Bearer ${adminToken}`);
  const authorised = req => {
    const given = Buffer.from(String(req.headers.authorization ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  /** The approvals API, for the ämtli UI only. */
  async function admin(req, res) {
    const path = req.url.split('?')[0];
    if (path === '/healthz') return json(res, 200, { ok: true });
    if (!authorised(req)) return json(res, 401, { error: 'unauthorised' });
    if (req.method === 'GET' && path === '/approvals') return json(res, 200, { approvals: approvals.list() });
    if (req.method === 'GET' && path === '/account') {
      if (!account?.status) return json(res, 404, { error: 'no login to tell' });
      const { tool, arguments: args = {} } = account.status;
      if (login?.ready) {
        try {
          return json(res, 200, await toolCall(login.child, tool, args));
        } catch {
          // It ended in between; a process of its own answers instead.
        }
      }
      return json(res, 200, await execute({ tool, arguments: args }));
    }
    if (req.method === 'POST' && path === '/account/login') {
      if (!account?.login) return json(res, 404, { error: 'no login to renew' });
      log(`login with ${account.login.tool}`);
      return json(res, 200, await startLogin());
    }
    const action = path.match(/^\/approvals\/([^/]+)\/(approve|reject)$/);
    if (req.method === 'POST' && action && APPROVAL_ID.test(action[1])) {
      const [, id, verb] = action;
      const record = approvals.claim(id, verb === 'approve' ? 'running' : 'rejected');
      if (!record) return json(res, 409, { error: 'not pending' });
      log(`${verb === 'approve' ? 'approved' : 'rejected'} ${record.tool} ${id}`);
      if (verb === 'reject') return json(res, 200, record);
      const outcome = await execute(record);
      log(`${record.tool} ${id}: ${outcome.ok ? 'done' : 'failed'}`);
      return json(res, 200, approvals.finish(id, outcome));
    }
    return json(res, 404, { error: 'not found' });
  }

  return {
    mcp,
    admin,
    sessions,
    async close() {
      clearInterval(reaper);
      await endLogin();
      await Promise.all([...sessions.keys()].map(id => {
        const s = sessions.get(id);
        sessions.delete(id);
        return s.child.close();
      }));
    },
  };
}

/** Reads the configuration from `env` and listens on both ports. */
export async function startGateway(env = process.env, { version = '0', log = console.log } = {}) {
  let command;
  try {
    command = JSON.parse(env.MCP_COMMAND ?? '');
  } catch {
    command = null;
  }
  if (!Array.isArray(command) || !command.length || !command.every(a => typeof a === 'string')) {
    throw new Error('MCP_COMMAND must be a JSON array, e.g. ["node","/opt/mcp/server.js"]');
  }
  if (!env.POLICY_FILE) throw new Error('POLICY_FILE is required');
  if (!env.ADMIN_TOKEN_FILE) throw new Error('ADMIN_TOKEN_FILE is required');
  const policy = parsePolicy(readFileSync(env.POLICY_FILE, 'utf8'));
  const adminToken = readFileSync(env.ADMIN_TOKEN_FILE, 'utf8').trim();
  const account = parseAccount(env.GATEWAY_ACCOUNT);
  const approvals = createApprovals({ dir: `${env.STATE_DIR ?? '/state'}/approvals` });
  // The server gets the gateway's environment minus the gateway's own settings.
  const own = new Set(['MCP_COMMAND', 'POLICY_FILE', 'ADMIN_TOKEN_FILE', 'STATE_DIR', 'PORT', 'ADMIN_PORT', 'HOST', 'GATEWAY_ACCOUNT']);
  const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !own.has(k)));
  const gateway = createGateway({ command, env: childEnv, policy, approvals, adminToken, account, version, log });
  const host = env.HOST ?? '0.0.0.0';
  const listen = (handler, port) => new Promise((resolve, reject) => {
    const server = createServer((req, res) => handler(req, res).catch(err => {
      log(`error: ${err.message}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }));
    server.on('error', reject);
    server.listen(port, host, () => resolve(server));
  });
  const servers = [await listen(gateway.mcp, Number(env.PORT ?? 8080)), await listen(gateway.admin, Number(env.ADMIN_PORT ?? 8081))];
  log(`gateway for ${command.join(' ')} on :${servers[0].address().port}, approvals on :${servers[1].address().port}`);
  return { gateway, servers };
}
