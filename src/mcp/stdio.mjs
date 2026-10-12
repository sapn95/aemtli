// A small MCP server over stdio: newline-delimited JSON-RPC, as the MCP stdio
// transport defines it. Tools only, which is all the gateways ask of one.
// stdout is the protocol, so anything to log goes to stderr.
import { createInterface } from 'node:readline';

const PROTOCOL = '2025-06-18';
// Versions this server speaks; a client asking for another gets PROTOCOL.
const SUPPORTED = new Set([PROTOCOL, '2025-03-26', '2024-11-05']);

/**
 * Serves `tools` ({ name, description, inputSchema, annotations, run }) on
 * `input` and `output`. A tool's result goes back as JSON text; a thrown
 * error goes back as a tool error with its message, so the agent reads why.
 */
export function serveStdio({ name, version, tools, input = process.stdin, output = process.stdout, log = m => process.stderr.write(`${m}\n`) }) {
  const byName = new Map(tools.map(t => [t.name, t]));
  const send = message => output.write(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(m) {
    switch (m.method) {
      case 'initialize':
        return reply(m.id, { protocolVersion: SUPPORTED.has(m.params?.protocolVersion) ? m.params.protocolVersion : PROTOCOL, capabilities: { tools: {} }, serverInfo: { name, version } });
      case 'ping':
        return reply(m.id, {});
      case 'tools/list':
        return reply(m.id, { tools: tools.map(({ name: n, description, inputSchema, annotations }) => ({ name: n, description, inputSchema, annotations })) });
      case 'tools/call': {
        const tool = byName.get(m.params?.name);
        if (!tool) return fail(m.id, -32602, `no tool ${m.params?.name}`);
        try {
          const result = await tool.run(m.params.arguments ?? {});
          return reply(m.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        } catch (err) {
          log(`${tool.name}: ${err.message}`);
          return reply(m.id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
      }
      default:
        return m.id === undefined ? undefined : fail(m.id, -32601, `${m.method} is not supported`);
    }
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  const done = new Promise(resolve => lines.on('close', resolve));
  lines.on('line', line => {
    if (!line.trim()) return;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      fail(null, -32700, 'not JSON');
      return;
    }
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      fail(null, -32600, 'a request is a JSON object');
      return;
    }
    handle(m).catch(err => fail(m.id ?? null, -32603, err.message));
  });
  return done;
}
