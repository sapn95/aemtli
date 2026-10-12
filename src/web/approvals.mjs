// The UI's side of the MCP gateways: it reads the calls they hold, passes on
// the owner's decision, and sends a push through ntfy for each new one. Each
// gateway has a token of its own, which only the UI holds.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const NAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Reads GATEWAYS, a JSON list of {name, title, url}, and each gateway's
 * token from `<tokensDir>/<name>`. Throws on anything malformed.
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
  if (list.length && !tokensDir) throw new Error('GATEWAY_TOKENS_DIR is required with GATEWAYS');
  const seen = new Set();
  return list.map(g => {
    if (!g || !NAME.test(g.name ?? '') || seen.has(g.name)) throw new Error(`gateway names must be unique and lower case: ${JSON.stringify(g?.name)}`);
    seen.add(g.name);
    const url = new URL(g.url);
    const mcp = g.mcp ? new URL(g.mcp) : null;
    if (![url, mcp].every(u => !u || ['http:', 'https:'].includes(u.protocol))) throw new Error(`gateway ${g.name}: http or https only`);
    return {
      name: g.name,
      title: String(g.title ?? g.name),
      url: url.origin,
      // Where agents reach the gateway; the chat hands it to goose per session.
      ...(mcp ? { mcp: mcp.href } : {}),
      token: read(`${tokensDir}/${g.name}`).trim(),
    };
  });
}

// An approved call may take its 30-second start and its 120-second run.
export function createGatewayClient({ gateways, fetchImpl = fetch, timeoutMs = 4000, decideTimeoutMs = 180_000 }) {
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
  };
}

/** "epost_send_letter" from the gateway "epost" reads "send letter". */
export function toolWords(tool, gateway) {
  const bare = tool.startsWith(`${gateway}_`) ? tool.slice(gateway.length + 1) : tool;
  return bare.replace(/[_-]+/g, ' ').trim();
}

/**
 * Sends one ntfy message per newly held call. What was already sent is kept
 * in `stateFile`, so a restart does not send it again. The message names the
 * gateway and the tool, never the arguments: those stay on the Pi.
 */
/** Printable ASCII only: a header cannot carry more, and an agent picks none of it. */
const ascii = text => String(text).replace(/[^\x20-\x7e]/g, '?').slice(0, 120);

export function createNotifier({ client, ntfyUrl, topic, token, stateFile, clickUrl, log = console.log, fetchImpl = fetch, perTick = 5 }) {
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
    const push = async (title, body) => {
      const res = await fetchImpl(`${ntfyUrl}/${topic}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          title: ascii(title),
          tags: 'raised_hand',
          ...(clickUrl ? { click: clickUrl } : {}),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
    };
    // A few pushes a minute at most; the rest go into one more that counts them.
    const fresh = items.filter(r => !sent.has(`${r.gateway}/${r.id}`));
    for (const [i, r] of fresh.entries()) {
      const key = `${r.gateway}/${r.id}`;
      try {
        if (i < perTick) await push(`${r.gatewayTitle}: ${toolWords(r.tool, r.gateway)}`, 'Waiting for your approval.');
        else if (i === perTick) await push(`${fresh.length - perTick} more calls`, 'Also waiting for your approval.');
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
