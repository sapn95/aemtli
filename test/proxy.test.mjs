import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createAcpProxy } from '../src/web/acp-proxy.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Closes a server and every socket it ever accepted, upgraded ones included. */
function closer(server) {
  const sockets = new Set();
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(r); });
}

/** A fake goose serve: completes the handshake if the secret is right, then sends one text frame. */
async function fakeGoose(secret) {
  const seen = [];
  const server = createServer((req, res) => { res.writeHead(426); res.end(); });
  const close = closer(server);
  server.on('upgrade', (req, socket) => {
    seen.push(req.headers);
    if (req.headers['x-secret-key'] !== secret) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const payload = Buffer.from('{"hello":true}');
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    socket.on('data', d => socket.write(d)); // echo whatever comes
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close };
}

/** A server that only proxies upgrades. */
async function proxyServer(opts) {
  const server = createServer((req, res) => { res.writeHead(404); res.end(); });
  const close = closer(server);
  server.on('upgrade', createAcpProxy(opts));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close };
}

/** Opens a raw WebSocket handshake; resolves with { status, socket, first } (first chunk after the headers). */
function handshake(port, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/acp', headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': randomBytes(16).toString('base64'), ...headers,
    } });
    req.on('upgrade', (res, socket, head) => {
      if (head.length) return resolve({ status: 101, socket, first: head });
      socket.once('data', first => resolve({ status: 101, socket, first }));
    });
    req.on('response', res => resolve({ status: res.statusCode }));
    req.on('error', reject);
    req.end();
  });
}

test('upgrades through to goose with the secret, and pipes both ways', async () => {
  const goose = await fakeGoose('s3cret');
  const proxy = await proxyServer({ target: { host: '127.0.0.1', port: goose.port }, secret: 's3cret', allowedOrigin: 'https://ui.example' });
  try {
    const { status, socket, first } = await handshake(proxy.port, { origin: 'https://ui.example' });
    assert.equal(status, 101);
    assert.equal(first.subarray(2).toString(), '{"hello":true}');
    assert.equal(goose.seen[0]['x-secret-key'], 's3cret');
    assert.equal(goose.seen[0].origin, undefined, 'the browser origin is not passed on');
    const echoed = new Promise(r => socket.once('data', r));
    socket.write(Buffer.from('ping'));
    assert.equal((await echoed).toString(), 'ping');
    socket.destroy();
  } finally { await proxy.close(); await goose.close(); }
});

test('another origin is refused before goose is asked', async () => {
  const goose = await fakeGoose('s3cret');
  const proxy = await proxyServer({ target: { host: '127.0.0.1', port: goose.port }, secret: 's3cret', allowedOrigin: 'https://ui.example' });
  try {
    assert.equal((await handshake(proxy.port, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await handshake(proxy.port, {})).status, 403);
    assert.equal(goose.seen.length, 0);
  } finally { await proxy.close(); await goose.close(); }
});

test('a wrong secret or a dead goose is a 502', async () => {
  const goose = await fakeGoose('right');
  const wrong = await proxyServer({ target: { host: '127.0.0.1', port: goose.port }, secret: 'wrong' });
  const dead = await proxyServer({ target: { host: '127.0.0.1', port: 1 }, secret: 'x' });
  try {
    assert.equal((await handshake(wrong.port, {})).status, 502);
    assert.equal((await handshake(dead.port, {})).status, 502);
  } finally { await wrong.close(); await dead.close(); await goose.close(); }
});
