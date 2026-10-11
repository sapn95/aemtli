// The chat page speaks ACP to `goose serve` over a WebSocket, but never
// directly: the browser connects to /acp here, and this forwards the upgrade
// to goose with the server's secret attached. The secret stays in the pod,
// and goose's port is reachable from this pod only (see the NetworkPolicy).
//
// It is a byte pipe after the handshake. Nothing here parses WebSocket
// frames, so nothing here can get them wrong.
import { request } from 'node:http';

// Headers that belong to the WebSocket handshake and travel on as they are.
const PASS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'];

/** Writes a plain HTTP error onto a raw socket and closes it. */
function refuse(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Creates the 'upgrade' handler. `target` is `{ host, port }` of goose
 * serve, `secret` its GOOSE_SERVER__SECRET_KEY. `allowedOrigin` is the one
 * origin the page is served from; a browser always sends Origin on a
 * WebSocket, and checking it is what stops another site's page from opening
 * one with the user's Access cookie.
 */
export function createAcpProxy({ target, secret, allowedOrigin }) {
  return function proxy(req, socket, head) {
    socket.on('error', () => socket.destroy());
    if (allowedOrigin && req.headers.origin !== allowedOrigin) return refuse(socket, 403, 'Forbidden');

    const headers = { connection: 'Upgrade', upgrade: 'websocket', host: `${target.host}:${target.port}`, 'x-secret-key': secret };
    for (const name of PASS) if (req.headers[name]) headers[name] = req.headers[name];

    const upstream = request({ host: target.host, port: target.port, path: '/acp', method: 'GET', headers, timeout: 10_000 });
    // A browser that leaves before goose answers must not leave the
    // half-open upstream connection behind.
    const abandon = () => upstream.destroy();
    socket.once('close', abandon);
    upstream.on('timeout', () => upstream.destroy(new Error('goose did not answer the upgrade')));

    upstream.on('upgrade', (res, upSocket, upHead) => {
      socket.removeListener('close', abandon);
      upSocket.setTimeout(0);
      const lines = ['HTTP/1.1 101 Switching Protocols'];
      for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      upSocket.on('error', () => socket.destroy());
      socket.on('close', () => upSocket.destroy());
      upSocket.on('close', () => socket.destroy());
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });

    // goose answered without upgrading: a 401 means the secret is wrong,
    // which is this pod's problem, not the browser's.
    upstream.on('response', res => {
      res.resume();
      refuse(socket, 502, 'Bad Gateway');
    });
    upstream.on('error', () => refuse(socket, 502, 'Bad Gateway'));
    upstream.end();
  };
}
