import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createModelProxy } from '../src/proxy/model-proxy.mjs';

/** A fake provider that records what reached it and streams two chunks back. */
async function fakeProvider() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'x=1', connection: 'keep-alive' });
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: two\n\n'), 20);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise(r => server.close(r)) };
}

/** Starts the proxy in front of `upstream`; returns a small client. */
async function proxyFor(upstream, opts = {}) {
  const lines = [];
  const server = createServer(createModelProxy({ upstream, header: 'x-api-key', key: () => 'real-key', log: l => lines.push(l), ...opts }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (path, { method = 'POST', headers = {}, body = '{}' } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (method === 'POST') req.write(body);
    req.end();
  });
  return { call, lines, close: () => new Promise(r => server.close(r)) };
}

test('puts the real key on, takes the caller\'s credentials off, streams the answer', async () => {
  const provider = await fakeProvider();
  const proxy = await proxyFor(provider.url);
  try {
    const res = await proxy.call('/v1/messages', { headers: { 'x-api-key': 'placeholder', authorization: 'Bearer stolen', cookie: 'a=b' }, body: '{"model":"m"}' });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'data: one\n\ndata: two\n\n');
    const got = provider.seen[0];
    assert.equal(got.headers['x-api-key'], 'real-key');
    assert.equal(got.headers.authorization, undefined);
    assert.equal(got.headers.cookie, undefined);
    assert.equal(got.body, '{"model":"m"}');
    assert.equal(got.url, '/v1/messages');
  } finally { await proxy.close(); await provider.close(); }
});

test('only the allowed paths and methods pass', async () => {
  const provider = await fakeProvider();
  const proxy = await proxyFor(provider.url);
  try {
    assert.equal((await proxy.call('/admin')).status, 403);
    assert.equal((await proxy.call('/v1/../admin')).status, 403);
    assert.equal((await proxy.call('/v1/messages', { method: 'DELETE' })).status, 403);
    assert.equal((await proxy.call('/healthz', { method: 'GET' })).status, 200);
    assert.equal(provider.seen.length, 0);
  } finally { await proxy.close(); await provider.close(); }
});

test('a bearer-style provider and a base path work too', async () => {
  const provider = await fakeProvider();
  const proxy = await proxyFor(`${provider.url}/openai/`, { header: 'authorization', prefix: 'Bearer ' });
  try {
    await proxy.call('/v1/chat/completions', { headers: { authorization: 'Bearer placeholder' } });
    assert.equal(provider.seen[0].headers.authorization, 'Bearer real-key');
    assert.equal(provider.seen[0].url, '/openai/v1/chat/completions');
  } finally { await proxy.close(); await provider.close(); }
});

test('no key is a 503, a dead provider a 502, both logged', async () => {
  const noKey = await proxyFor('http://127.0.0.1:1', { key: () => { throw new Error('/secrets/model/key is empty'); } });
  const dead = await proxyFor('http://127.0.0.1:1');
  try {
    assert.equal((await noKey.call('/v1/messages')).status, 503);
    assert.ok(noKey.lines.some(l => /is empty/.test(l)));
    assert.equal((await dead.call('/v1/messages')).status, 502);
    assert.ok(dead.lines.some(l => /upstream error/.test(l)));
  } finally { await noKey.close(); await dead.close(); }
});
