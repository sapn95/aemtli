// Who is asking? Cloudflare Access answers that before a request reaches the
// cluster, and hands the answer over as a signed JWT in the
// Cf-Access-Jwt-Assertion header. Checking that signature here means the UI
// does not rely on the tunnel being the only way in: a request that reaches
// the pod some other way (a port-forward, a NodePort somebody adds later)
// still has to carry a token Access signed, for this application, for an
// address on the list.
import { createPublicKey, verify } from 'node:crypto';

const SKEW_MS = 60_000;
const KEYS_TTL_MS = 60 * 60_000;

/** Decodes one base64url JWT segment as JSON. */
function segment(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * Creates a verifier for one Access application.
 *
 * `teamDomain` is `<team>.cloudflareaccess.com`, `audience` the application's
 * AUD tag, `allowedEmails` the addresses that may in (compared without case).
 * `fetchImpl` and `now` are injectable for tests.
 */
export function createAccessVerifier({ teamDomain, audience, allowedEmails, fetchImpl = fetch, now = Date.now }) {
  if (!teamDomain || !audience || !allowedEmails?.length) {
    throw new Error('Access verification needs a team domain, an audience and at least one allowed email');
  }
  const issuer = `https://${teamDomain}`;
  const allowed = new Set(allowedEmails.map(e => e.trim().toLowerCase()));
  let keys = new Map();
  let fetchedAt = 0;
  let attemptedAt = -Infinity;
  let inFlight = null;

  /** One fetch of the team's keys, with a timeout. Replaces the cache only on success. */
  async function fetchKeys() {
    attemptedAt = now();
    const res = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Access certs answered ${res.status}`);
    const body = await res.json();
    keys = new Map((body.keys ?? []).map(jwk => [jwk.kid, createPublicKey({ key: jwk, format: 'jwk' })]));
    fetchedAt = now();
  }

  /**
   * Loads the signing keys when they are older than an hour (or `force`, for
   * an unknown kid), at most once a minute and one fetch at a time. When the
   * fetch fails, the keys already held stay in use: Cloudflare being briefly
   * unreachable must not lock out a valid session.
   */
  async function loadKeys(force) {
    const stale = now() - fetchedAt >= KEYS_TTL_MS || !keys.size;
    if (!stale && !force) return;
    if (now() - attemptedAt < 60_000) {
      if (inFlight) await inFlight.catch(() => {});
      return;
    }
    inFlight = inFlight ?? fetchKeys().finally(() => { inFlight = null; });
    try {
      await inFlight;
    } catch (err) {
      if (!keys.size) throw err;
    }
  }

  /**
   * Verifies `token` and resolves with `{ email }`, or rejects with a reason
   * fit for a log line (never for the reply, which only says 403).
   */
  return async function verifyToken(token) {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3) throw new Error('no Access token');
    const header = segment(parts[0]);
    const claims = segment(parts[1]);
    // Only RS256 is acceptable. Taking `alg` from the token itself is how
    // "none" and HMAC-with-the-public-key forgeries get in.
    if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);
    await loadKeys(false);
    if (!keys.has(header.kid)) await loadKeys(true);
    const key = keys.get(header.kid);
    if (!key) throw new Error('token signed by an unknown key');
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) throw new Error('bad signature');

    const t = now();
    if (typeof claims.exp !== 'number' || claims.exp * 1000 + SKEW_MS < t) throw new Error('token expired');
    if (typeof claims.nbf === 'number' && claims.nbf * 1000 - SKEW_MS > t) throw new Error('token not yet valid');
    if (claims.iss !== issuer) throw new Error(`issuer ${claims.iss}`);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new Error('token is for another application');
    const email = String(claims.email ?? '').toLowerCase();
    if (!allowed.has(email)) throw new Error(`${email || 'no email'} is not allowed`);
    return { email };
  };
}
