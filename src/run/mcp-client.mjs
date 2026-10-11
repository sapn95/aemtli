// A small MCP client for jobs: Streamable HTTP to a gateway, JSON responses,
// one session per client. Enough to call tools; nothing else.

const PROTOCOL = '2025-06-18';

/** The text of a tool result, joined. */
function textOf(result) {
  return (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
}

export function createMcpClient(url, { fetchImpl = fetch, timeoutMs = 130_000, clientName = 'aemtli-job' } = {}) {
  let sessionId = null;
  let nextId = 1;

  async function post(message) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 202) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok && !body?.error) throw new Error(`${url} answered ${res.status}`);
    return { body, session: res.headers.get('mcp-session-id') };
  }

  async function request(method, params) {
    const answer = await post({ jsonrpc: '2.0', id: nextId++, method, params });
    if (answer?.body?.error) throw new Error(`${method}: ${answer.body.error.message}`);
    return answer;
  }

  async function open() {
    if (sessionId) return;
    const { session } = await request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: clientName, version: '1' } });
    if (!session) throw new Error(`${url} gave no session`);
    sessionId = session;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  return {
    /** The server's tools. */
    async tools() {
      await open();
      return (await request('tools/list', {})).body.result.tools;
    },
    /**
     * Calls a tool. Resolves with { text, isError, result }; a held call is
     * not an error, its text says it waits.
     */
    async call(name, args = {}) {
      await open();
      const { result } = (await request('tools/call', { name, arguments: args })).body;
      return { text: textOf(result), isError: Boolean(result?.isError), result };
    },
    /** Calls a tool whose answer is JSON, and parses it. Throws on an error result. */
    async json(name, args = {}) {
      const { text, isError } = await this.call(name, args);
      if (isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${name} did not answer JSON: ${text.slice(0, 200)}`);
      }
    },
    async close() {
      if (!sessionId) return;
      await fetchImpl(url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } }).catch(() => {});
      sessionId = null;
    },
  };
}
