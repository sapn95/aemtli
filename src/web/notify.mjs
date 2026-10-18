// Where a push goes. The web pod knows the ways out: Web Push to the
// devices that turned it on, and ntfy where that is set up. Either may be
// missing, so ntfy is optional once Web Push is there.
//
// A job runs in a pod of its own and has neither the VAPID key nor the
// subscriptions, so it hands its push to the web pod over an internal port
// (NOTIFY_PORT), with a token. That port is not the page's: the tunnel never
// reaches it, and the network policy lets only the job pods in.
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';

/**
 * One function that sends a message ({ title, message, click, tags }) down
 * every channel. Each channel resolves to true when it delivered. The
 * result is true if any did; with no channel at all it is false.
 */
export function createNotify(channels, log = console.log) {
  return async message => {
    const results = await Promise.all(channels.map(channel => channel(message).catch(err => {
      log(`could not push: ${err.message}`);
      return false;
    })));
    return results.some(Boolean);
  };
}

const digest = text => createHash('sha256').update(String(text)).digest();

/**
 * The internal port: POST /notify with `Authorization: Bearer <token>` and
 * a JSON body { title, message, click?, tags? }. Answers 200 { delivered }.
 * `click` is kept only when it is a page of `origin`. Resolves once it
 * listens.
 */
export function startNotifyServer({ notify, token, port, host = '0.0.0.0', origin, log = console.log }) {
  // A tap on the push opens `click`. Web Push's worker opens only this site,
  // but ntfy opens whatever it is given, so a link elsewhere is dropped here.
  const ours = click => typeof click === 'string' && Boolean(origin) && (click === origin || click.startsWith(`${origin}/`));
  if (!token) return Promise.reject(new Error('the notify port needs a token (NOTIFY_TOKEN_FILE)'));
  const want = digest(`Bearer ${token}`);
  const answer = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const server = createServer((req, res) => {
    if (req.url !== '/notify') return answer(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return answer(res, 405, { error: 'POST only' });
    // Compared as digests, so the time taken says nothing about the token.
    if (!timingSafeEqual(digest(req.headers.authorization ?? ''), want)) return answer(res, 401, { error: 'no or wrong token' });
    let size = 0;
    const chunks = [];
    req.on('data', c => { size += c.length; if (size <= 16384) chunks.push(c); });
    req.on('end', async () => {
      let body;
      try {
        body = size <= 16384 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      } catch {
        body = null;
      }
      if (!body || typeof body.title !== 'string' || !body.title.trim()) return answer(res, 400, { error: 'a JSON body with a title' });
      const { title, message = '', click, tags } = body;
      const delivered = await notify({ title, message: String(message), ...(ours(click) ? { click } : {}), ...(typeof tags === 'string' ? { tags } : {}) });
      log(`notify from a job: ${delivered ? 'sent' : 'not sent'}`);
      answer(res, 200, { delivered });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
