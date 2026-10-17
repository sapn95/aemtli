#!/usr/bin/env node
// A small MCP server over stdio for the gateway tests: two tools, one that
// reads and one that "sends", plus a way to make it slow or crash. And a
// login the way ms-365-mcp-server does it: the tool answers with a device
// code at once, and the login completes later in the same process.
import { createInterface } from 'node:readline';

const TOOLS = [
  { name: 'read_thing', description: 'Reads a thing.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, bytes: { type: 'number' } } } },
  { name: 'send_thing', description: 'Sends a thing.', inputSchema: { type: 'object', properties: { to: { type: 'string' } } } },
  { name: 'secret_thing', description: 'Never for agents.', inputSchema: { type: 'object' } },
  { name: 'secret_login', description: 'Logs in with a device code.', inputSchema: { type: 'object' } },
  { name: 'secret_status', description: 'Tells the login.', inputSchema: { type: 'object' } },
];
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let calls = 0;
let loggedIn = false;

createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const ok = result => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } });
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      calls += 1;
      const { name, arguments: args = {} } = msg.params;
      if (args.crash) process.exit(3);
      // A letter's PDF, as base64: megabytes on one line.
      if (args.bytes) return ok({ content: [{ type: 'text', text: 'x'.repeat(Number(args.bytes)) }] });
      if (args.fail) return ok({ content: [{ type: 'text', text: `could not ${name}` }], isError: true });
      if (name === 'secret_login') {
        setTimeout(() => { loggedIn = true; }, 100);
        const message = 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD1234 to authenticate.';
        return ok({ content: [{ type: 'text', text: JSON.stringify({ error: 'device_code_required', message, force: args.force ?? null, pid: process.pid }) }] });
      }
      if (name === 'secret_status') {
        const answer = loggedIn ? { success: true, message: 'Login successful', userData: { displayName: 'Example', userPrincipalName: 'example@example.com' } } : { success: false, message: 'Not logged in' };
        return ok({ content: [{ type: 'text', text: JSON.stringify({ ...answer, pid: process.pid }) }] });
      }
      // The environment is how a real server gets its credentials.
      return ok({ content: [{ type: 'text', text: `${name} ${JSON.stringify(args)} call ${calls} secret=${process.env.FAKE_MCP_SECRET ?? 'none'} admin=${process.env.ADMIN_TOKEN_FILE ?? 'none'} account=${process.env.GATEWAY_ACCOUNT ?? 'none'}` }] });
    }
    case 'ping':
      // Asks the client something back, which a gateway must refuse.
      send({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' });
      return ok({});
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no ${msg.method}` } });
  }
});
