// Web Push: a notification straight to the phone the app is installed on,
// with no app of its own in between. The browser hands over a subscription
// (a push service URL and two keys); the server encrypts each message for
// it (RFC 8291, the aes128gcm coding of RFC 8188) and signs its request
// with a VAPID key (RFC 8292). node:crypto does all of it, so nothing new
// is installed for it.
//
// The push service sees only that something was sent, never what: the
// title and text are encrypted for the browser.
import { createECDH, createPrivateKey, createPublicKey, hkdfSync, randomBytes, createCipheriv, sign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { writeJsonAtomic } from '../store/runs.mjs';

const b64url = buf => Buffer.from(buf).toString('base64url');
const fromB64url = text => Buffer.from(String(text), 'base64url');

// The push services of Chrome and Android, Firefox, Safari and Edge. A
// subscription names its own URL, and the server posts to it: only these
// hosts, so a forged subscription cannot point the server anywhere else.
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
const allowedHost = host => PUSH_HOSTS.some(h => host === h || host.endsWith(`.${h}`));

// Few devices: a phone or two and a laptop. A cap keeps a loop from
// filling the file.
const MAX_SUBSCRIPTIONS = 20;
// One record, as RFC 8291 says, so the text has to stay well under 4 KB:
// the record less the header, the delimiter and the tag, with room to spare.
const RECORD_SIZE = 4096;
const MAX_PAYLOAD = 3900;
const MAX_URL = 512;
// How long a push service keeps a message for a phone that is off.
const TTL_SECONDS = 24 * 3600;

/**
 * A subscription as the browser gives it (PushSubscription.toJSON()),
 * checked: an https URL at a known push service, a P-256 public key and a
 * 16-byte secret. Throws with the reason otherwise.
 */
export function checkSubscription(sub) {
  let url;
  try {
    url = new URL(sub?.endpoint);
  } catch {
    throw new Error('the subscription has no valid endpoint');
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowedHost(url.hostname)) {
    throw new Error(`${url.hostname} is not a push service this server sends to`);
  }
  const p256dh = fromB64url(sub.keys?.p256dh ?? '');
  const auth = fromB64url(sub.keys?.auth ?? '');
  if (p256dh.length !== 65 || p256dh[0] !== 4) throw new Error('the subscription key is not a P-256 public key');
  if (auth.length !== 16) throw new Error('the subscription secret is not 16 bytes');
  try {
    // An invalid point fails here rather than at the first message.
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(p256dh);
  } catch {
    throw new Error('the subscription key is not a point on P-256');
  }
  return { endpoint: url.href, keys: { p256dh: b64url(p256dh), auth: b64url(auth) } };
}

/**
 * The message body for one subscription: salt, record size, the server's
 * one-time public key, then the encrypted text with its 0x02 delimiter.
 * `local` and `salt` are fixed only by the tests (RFC 8291, appendix A).
 */
export function encrypt(plaintext, { p256dh, auth }, { local, salt = randomBytes(16) } = {}) {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const ecdh = createECDH('prime256v1');
  if (local) ecdh.setPrivateKey(fromB64url(local));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

/**
 * The VAPID key from a PEM file (`openssl ecparam -name prime256v1 -genkey
 * -noout`, or the same in PKCS #8), with its public half in the raw form a
 * browser takes as applicationServerKey.
 */
export function loadVapidKey(pem) {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('the VAPID key must be an EC key on P-256 (prime256v1)');
  }
  const { x, y } = createPublicKey(privateKey).export({ format: 'jwk' });
  return { privateKey, publicKey: b64url(Buffer.concat([Buffer.from([4]), fromB64url(x), fromB64url(y)])) };
}

/** The Authorization header for one push service: a signed JWT for its origin, and the key. */
export function vapidAuthorization(endpoint, { privateKey, publicKey }, subject, now = Date.now()) {
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  // Twelve hours, half of the most a push service accepts.
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64url(signature)}, k=${publicKey}`;
}

/**
 * The subscriptions kept in `file`, and a send to all of them. A push
 * service that says a subscription is gone (404, 410) has it removed.
 * `send` resolves to the number of devices that took the message; it never
 * throws.
 */
export function createWebPush({ vapid, subject, file, log = console.log, fetchImpl = fetch, now = () => Date.now() }) {
  if (!/^(mailto:|https:\/\/)/.test(subject ?? '')) throw new Error('VAPID needs a subject: a mailto: address or an https:// URL');
  let subs = [];
  if (existsSync(file)) {
    try {
      subs = JSON.parse(readFileSync(file, 'utf8')).flatMap(s => {
        try { return [{ ...checkSubscription(s), added: s.added }]; } catch { return []; }
      });
    } catch (err) {
      log(`the push subscriptions could not be read and start empty: ${err.message}`);
    }
  }
  const save = () => writeJsonAtomic(file, subs);

  async function deliver(sub, payload) {
    const res = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuthorization(sub.endpoint, vapid, subject, now()),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(TTL_SECONDS),
        // A phone in power saving delivers "high" at once, others later.
        urgency: 'high',
      },
      body: encrypt(payload, sub.keys),
      signal: AbortSignal.timeout(10_000),
    });
    return res.status;
  }

  return {
    publicKey: vapid.publicKey,
    count: () => subs.length,
    /** Keeps a subscription; the same endpoint again replaces the old one. */
    subscribe(sub) {
      const checked = checkSubscription(sub);
      subs = [...subs.filter(s => s.endpoint !== checked.endpoint), { ...checked, added: new Date(now()).toISOString() }].slice(-MAX_SUBSCRIPTIONS);
      save();
      return subs.length;
    },
    /** Forgets a subscription; true if there was one. */
    unsubscribe(endpoint) {
      const before = subs.length;
      subs = subs.filter(s => s.endpoint !== endpoint);
      if (subs.length === before) return false;
      save();
      return true;
    },
    /** One message to every device. `click` is the page a tap opens. */
    async send({ title, message, click }) {
      if (!subs.length) return 0;
      const fields = {
        title: String(title).replace(/\s+/g, ' ').slice(0, 120),
        body: String(message ?? '').slice(0, 1000),
        ...(click && String(click).length <= MAX_URL ? { url: String(click) } : {}),
      };
      // One record: what is encrypted has to stay under 4 KB in bytes, and
      // a character outside ASCII takes up to three of them, so the text is
      // cut until it fits.
      let payload = JSON.stringify(fields);
      while (Buffer.byteLength(payload) > MAX_PAYLOAD && fields.body) {
        fields.body = fields.body.slice(0, Math.floor(fields.body.length * 0.8));
        payload = JSON.stringify(fields);
      }
      let delivered = 0;
      const gone = [];
      await Promise.all(subs.map(async sub => {
        const host = new URL(sub.endpoint).hostname;
        try {
          const status = await deliver(sub, payload);
          if (status >= 200 && status < 300) delivered += 1;
          else if (status === 404 || status === 410) gone.push(sub.endpoint);
          else log(`push to ${host} answered ${status}`);
        } catch (err) {
          log(`could not push to ${host}: ${err.message}`);
        }
      }));
      if (gone.length) {
        subs = subs.filter(s => !gone.includes(s.endpoint));
        save();
        log(`dropped ${gone.length} push subscription(s) the push service no longer knows`);
      }
      return delivered;
    },
  };
}
