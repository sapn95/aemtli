// The UI's side of the MCP gateways: it reads the calls they hold, passes on
// the owner's decision, and sends a push for each new one. Each
// gateway has a token of its own, which only the UI holds.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const NAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Reads GATEWAYS, a JSON list of {name, title, url}, and each gateway's
 * token from `<tokensDir>/<name>`, or from its own `tokenFile` when it has
 * one (a gateway added later, whose token is a Secret of its own). Throws on
 * anything malformed.
 */
export function parseGateways(spec, tokensDir, read = path => readFileSync(path, 'utf8')) {
  if (!spec) return [];
  let list;
  try {
    list = JSON.parse(spec);
  } catch {
    throw new Error('GATEWAYS must be JSON: [{"name":"epost","title":"ePost","url":"http://aemtli-mcp-epost:8081"}]');
  }
  if (!Array.isArray(list)) throw new Error('GATEWAYS must be a JSON list');
  if (list.some(g => !g?.tokenFile) && !tokensDir) throw new Error('GATEWAY_TOKENS_DIR is required with GATEWAYS');
  const seen = new Set();
  return list.map(g => {
    if (!g || !NAME.test(g.name ?? '') || seen.has(g.name)) throw new Error(`gateway names must be unique and lower case: ${JSON.stringify(g?.name)}`);
    seen.add(g.name);
    const url = new URL(g.url);
    const mcp = g.mcp ? new URL(g.mcp) : null;
    if (![url, mcp].every(u => !u || ['http:', 'https:'].includes(u.protocol))) throw new Error(`gateway ${g.name}: http or https only`);
    if (g.tokenFile !== undefined && !(typeof g.tokenFile === 'string' && g.tokenFile.startsWith('/'))) throw new Error(`gateway ${g.name}: tokenFile must be an absolute path`);
    return {
      name: g.name,
      title: String(g.title ?? g.name),
      url: url.origin,
      // Where agents reach the gateway; the chat hands it to goose per session.
      ...(mcp ? { mcp: mcp.href } : {}),
      token: read(g.tokenFile ?? `${tokensDir}/${g.name}`).trim(),
    };
  });
}

/**
 * What a gateway's status tool said about its login. ms-365-mcp-server's
 * verify-login answers {success, message, userData}; any other server's
 * text is shown as it is, and the login counts as fine when the call was.
 */
export function readAccount({ ok, text }) {
  let said = null;
  try {
    said = JSON.parse(text);
  } catch {
    // Plain text.
  }
  if (said && typeof said === 'object' && typeof said.success === 'boolean') {
    const who = said.userData?.userPrincipalName ?? said.userData?.displayName;
    return { loggedIn: said.success, who: typeof who === 'string' ? who.slice(0, 200) : null, message: String(said.message ?? '').slice(0, 500) };
  }
  return { loggedIn: Boolean(ok), who: null, message: String(text ?? '').slice(0, 500) };
}

/**
 * What a gateway's login tool said: for a device-code login, the page to
 * open and the code to enter there. ms-365-mcp-server answers
 * {error: "device_code_required", message}, with both in the message, and
 * {error: "Authentication failed: ..."} when it could not start.
 */
export function readLogin({ ok, text }) {
  let said = null;
  try {
    said = JSON.parse(text);
  } catch {
    // Plain text.
  }
  const fields = said && typeof said === 'object' ? said : {};
  const message = String(fields.message ?? fields.error ?? fields.status ?? text ?? '').slice(0, 500);
  const failed = !ok || (typeof fields.error === 'string' && fields.error !== 'device_code_required');
  return {
    ok: !failed,
    url: message.match(/https:\/\/[^\s"'<>]+?(?=[.,;:)]?(?:\s|$))/)?.[0] ?? null,
    code: message.match(/\bcode\s+([A-Z0-9-]{4,16})\b/i)?.[1] ?? null,
    message,
  };
}

// An approved call may take its 30-second start and its 120-second run; a
// login's status or start, a server's start and one call to its provider.
export function createGatewayClient({ gateways, fetchImpl = fetch, timeoutMs = 4000, decideTimeoutMs = 180_000, accountTimeoutMs = 45_000 }) {
  const byName = new Map(gateways.map(g => [g.name, g]));

  async function call(g, path, { method = 'GET', timeout = timeoutMs } = {}) {
    const res = await fetchImpl(`${g.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${g.token}` },
      signal: AbortSignal.timeout(timeout),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  /** Every gateway's requests, newest first, and the gateways that did not answer. */
  async function all() {
    const answers = await Promise.all(gateways.map(async g => {
      try {
        const { status, body } = await call(g, '/approvals');
        if (status !== 200 || !Array.isArray(body.approvals)) return { g, error: `answered ${status}` };
        return { g, items: body.approvals };
      } catch (err) {
        return { g, error: err.name === 'TimeoutError' ? 'did not answer in time' : err.message };
      }
    }));
    const items = answers.flatMap(a => (a.items ?? []).map(r => ({ ...r, gateway: a.g.name, gatewayTitle: a.g.title })))
      .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
    const unreachable = answers.filter(a => a.error).map(a => ({ name: a.g.name, title: a.g.title, error: a.error }));
    return { items, unreachable };
  }

  return {
    configured: gateways.length > 0,
    /** The gateways' MCP endpoints, as ACP's session/new takes them. */
    mcpServers: gateways.filter(g => g.mcp).map(g => ({ type: 'http', name: g.name, url: g.mcp, headers: [] })),
    all,
    /** Only what waits for a decision. */
    async pending() {
      const { items, unreachable } = await all();
      return { items: items.filter(r => r.status === 'pending'), unreachable };
    },
    /** Passes "approve" or "reject" on; resolves with the gateway's status and record. */
    decide(name, id, verb) {
      const g = byName.get(name);
      if (!g) return Promise.resolve({ status: 404, body: { error: 'no such gateway' } });
      return call(g, `/approvals/${encodeURIComponent(id)}/${verb}`, { method: 'POST', timeout: decideTimeoutMs });
    },
    /** Name and title of each gateway, in the order GATEWAYS lists them. */
    list: gateways.map(g => ({ name: g.name, title: g.title })),
    /** The login of the gateway's server; 404 where it has none to tell. */
    account(name) {
      const g = byName.get(name);
      if (!g) return Promise.resolve({ status: 404, body: { error: 'no such gateway' } });
      return call(g, '/account', { timeout: accountTimeoutMs });
    },
    /** Starts a new login at the gateway; 404 where it has none to renew. */
    login(name) {
      const g = byName.get(name);
      if (!g) return Promise.resolve({ status: 404, body: { error: 'no such gateway' } });
      return call(g, '/account/login', { method: 'POST', timeout: accountTimeoutMs });
    },
  };
}

/** "epost_send_letter" from the gateway "epost" reads "send letter". */
export function toolWords(tool, gateway) {
  const bare = tool.startsWith(`${gateway}_`) ? tool.slice(gateway.length + 1) : tool;
  return bare.replace(/[_-]+/g, ' ').trim();
}

/**
 * Sends one push per newly held call, through `push` (see notify.mjs),
 * which resolves to true when it went out. What was already sent is kept
 * in `stateFile`, so a restart does not send it again. The message names
 * the gateway and the tool, never the arguments: those stay on the Pi.
 */
export function createNotifier({ client, push, stateFile, clickUrl, log = console.log, perTick = 5 }) {
  let sent = new Set();
  try {
    sent = new Set(JSON.parse(readFileSync(stateFile, 'utf8')));
  } catch {
    // First start, or an unreadable file: nothing sent yet.
  }
  const save = () => {
    writeFileSync(`${stateFile}.tmp`, JSON.stringify([...sent]));
    renameSync(`${stateFile}.tmp`, stateFile);
  };

  async function tick() {
    const { items } = await client.pending();
    const keys = new Set(items.map(r => `${r.gateway}/${r.id}`));
    let changed = false;
    for (const key of sent) {
      if (!keys.has(key)) {
        sent.delete(key);
        changed = true;
      }
    }
    const send = async (title, message) => {
      if (!await push({ title, message, tags: 'raised_hand', ...(clickUrl ? { click: clickUrl } : {}) })) throw new Error('no push went out');
    };
    // A few pushes a minute at most; the rest go into one more that counts them.
    const fresh = items.filter(r => !sent.has(`${r.gateway}/${r.id}`));
    for (const [i, r] of fresh.entries()) {
      const key = `${r.gateway}/${r.id}`;
      try {
        if (i < perTick) await send(`${r.gatewayTitle}: ${toolWords(r.tool, r.gateway)}`, 'Waiting for your approval.');
        else if (i === perTick) await send(`${fresh.length - perTick} more calls`, 'Also waiting for your approval.');
        sent.add(key);
        changed = true;
        if (i < perTick) log(`notified ${key}`);
      } catch (err) {
        log(`could not notify ${key}: ${err.message}`);
        if (i >= perTick) break;
      }
    }
    if (changed) save();
  }

  return {
    tick,
    start(intervalMs = 60_000) {
      const run = () => tick().catch(err => log(`notifier: ${err.message}`));
      run();
      const timer = setInterval(run, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

/**
 * A push through ntfy, published as JSON so a title keeps its umlauts.
 * Resolves to true when it went out; never throws.
 */
export function createPush({ ntfyUrl, topic, token, log = console.log, fetchImpl = fetch }) {
  return async ({ title, message, click, tags = 'speech_balloon' }) => {
    try {
      const res = await fetchImpl(ntfyUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ topic, title: String(title).slice(0, 120), message: String(message).slice(0, 2000), tags: [tags], ...(click ? { click } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
      return true;
    } catch (err) {
      log(`could not push: ${err.message}`);
      return false;
    }
  };
}
