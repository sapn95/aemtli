// One MCP server process, spoken to over stdio: newline-delimited JSON-RPC,
// as the MCP stdio transport defines it. The gateway starts one per client
// session and one per approved call, so sessions never share state.
import { spawn } from 'node:child_process';

// The longest line a server may answer with. It is a guard against a server
// that never stops talking, not a size for the answers themselves: a letter's
// PDF comes back as base64 (epost_letter_pdf hands back up to 10 MB, which is
// 13.4 MB encoded), and at 4 MB the gateway killed the server in the middle of
// a backup run, which the job then read as "the MCP server exited (0)". The
// line is held in memory once here and once in the server, so the gateway's
// own memory limit is what this has to fit under.
const MAX_LINE = 24 * 1024 * 1024;
const MB = Math.round(MAX_LINE / 1024 / 1024);

/**
 * Starts `command` (an argv array) with `env`. Returns `request`, which
 * resolves with the JSON-RPC response object (result or error), `notify`,
 * `close`, and `exited`, a promise for the exit code.
 */
export function spawnChild(command, { env = process.env, timeoutMs = 120_000, log = () => {} } = {}) {
  const child = spawn(command[0], command.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let closed = false;

  // A process that never started emits "error" and no "exit"; both end
  // everything that waits on it, whichever comes first.
  let finish;
  const exited = new Promise(resolve => { finish = resolve; });
  const end = (code, why) => {
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(why));
    }
    pending.clear();
    finish(code);
  };
  child.on('exit', code => end(code, `the MCP server exited (${code ?? 'signal'})`));
  child.on('error', err => {
    log(`MCP server did not start: ${err.message}`);
    end(null, `the MCP server did not start: ${err.message}`);
  });
  // Writing to a process that is gone is an EPIPE on stdin, not a crash.
  child.stdin.on('error', () => {});
  // stderr is the server's own log. Kept short: it can echo what it handles.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    for (const line of chunk.split('\n')) if (line.trim()) log(`mcp: ${line.slice(0, 300)}`);
  });

  const write = message => {
    if (!closed) child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_LINE) {
      log(`MCP server sent a line over ${MB} MB; stopping it`);
      child.kill();
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
    }
  });

  function onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log('MCP server wrote a line that is not JSON');
      return;
    }
    if (message.id !== undefined && !message.method) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      waiting.resolve(message);
      return;
    }
    // The server asking something of us (sampling, roots, elicitation):
    // there is no one to ask, so it gets a refusal instead of silence.
    if (message.id !== undefined) write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not supported by the gateway' } });
  }

  return {
    request(method, params, timeout = timeoutMs) {
      if (closed) return Promise.reject(new Error('the MCP server is not running'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`the MCP server did not answer ${method} within ${Math.round(timeout / 1000)}s`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    notify(method, params) {
      write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
    close() {
      if (closed) return exited;
      child.stdin.end();
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.kill('SIGTERM');
      return exited.finally(() => clearTimeout(kill));
    },
    exited,
  };
}
