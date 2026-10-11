// The model API key never enters an agent's environment. goose's developer
// extension runs shell commands with goose's own environment, so a key in it
// is one prompt injection away from a `curl` to somewhere else. Instead goose
// talks to this proxy with a placeholder key, and the proxy, in a pod of its
// own, puts the real key on the way out.
//
// What an agent can still do is spend: it can call the model through here.
// It cannot take the key with it.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';

// Never forwarded: hop-by-hop headers, and every way a caller could bring
// credentials of its own.
const DROP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'authorization', 'x-api-key', 'cookie', 'x-goog-api-key',
]);

/** Copies headers, leaving out the dropped ones. */
function pass(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !DROP.has(name.toLowerCase())));
}

/**
 * Creates the request handler. `upstream` is the provider's base URL,
 * `header` and `prefix` say how the key is sent (`x-api-key` for Anthropic,
 * `authorization` with "Bearer " for OpenAI), `key()` returns it (read from a
 * file each time, so a rotated Secret is picked up), `allow` lists the path
 * prefixes that may pass.
 */
export function createModelProxy({ upstream, header, prefix = '', key, allow = ['/v1/'], log = console.log }) {
  const base = new URL(upstream);
  const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
  const basePath = base.pathname.replace(/\/$/, '');

  return function handle(req, res) {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    let path;
    try {
      path = new URL(req.url, 'http://proxy').pathname;
    } catch {
      res.writeHead(400);
      return res.end();
    }
    // Only the API's own paths, and no dot segments to walk out of them.
    if (!['GET', 'POST'].includes(req.method) || !allow.some(p => path.startsWith(p)) || path.includes('..')) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('not allowed through this proxy');
    }
    let secret;
    try {
      secret = key();
    } catch (err) {
      log(`no model key: ${err.message}`);
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('the model key is not configured');
    }
    const out = send({
      hostname: base.hostname,
      port: base.port || undefined,
      path: basePath + req.url,
      method: req.method,
      headers: { ...pass(req.headers), host: base.host, [header]: `${prefix}${secret}` },
      // Long generations stream for minutes; this bounds a silent connection.
      timeout: 600_000,
    }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode, pass(upstreamRes.headers));
      upstreamRes.pipe(res);
    });
    out.on('timeout', () => out.destroy(new Error('upstream timed out')));
    out.on('error', err => {
      log(`upstream error on ${req.method} ${path}: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
    });
    req.pipe(out);
    return undefined;
  };
}

/** Reads the proxy's settings from the environment and starts it. */
export function startModelProxy(env = process.env, log = console.log) {
  const keyFile = env.MODEL_KEY_FILE ?? '/secrets/model/key';
  const handle = createModelProxy({
    upstream: env.MODEL_UPSTREAM ?? 'https://api.anthropic.com',
    header: (env.MODEL_AUTH_HEADER ?? 'x-api-key').toLowerCase(),
    prefix: env.MODEL_AUTH_PREFIX ?? '',
    key: () => {
      const value = readFileSync(keyFile, 'utf8').trim();
      if (!value) throw new Error(`${keyFile} is empty`);
      return value;
    },
    allow: (env.MODEL_ALLOW_PATHS ?? '/v1/').split(',').map(s => s.trim()).filter(Boolean),
    log,
  });
  const server = createServer(handle);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(env.PORT ?? 8080), env.HOST ?? '0.0.0.0', () => resolve(server));
  });
}
