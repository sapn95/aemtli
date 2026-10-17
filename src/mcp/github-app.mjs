// A GitHub App's installation token, for the servers that talk to GitHub.
//
// The App is its own identity with the permissions it was registered with,
// so what it may do is set in one place on GitHub and not by whose token a
// pod happens to hold. An owner's personal token would act as the owner, and
// an owner passes every branch protection that does not enforce admins: the
// App has write access, so a red check stops it like anyone else.
//
// The private key never leaves this process. It signs a JWT that lives nine
// minutes, the JWT buys an installation token that lives an hour, and the
// token is kept until five minutes before it runs out. A caller may ask for
// less than the App holds (fewer repositories, fewer permissions), and gets a
// token of its own for exactly that.

import { createPrivateKey, createSign } from 'node:crypto';

const b64url = value => Buffer.from(value).toString('base64url');
// GitHub accepts a JWT up to ten minutes; clocks drift, so one minute back.
const JWT_BACK = 60;
const JWT_LIFE = 9 * 60;
const RENEW_BEFORE = 5 * 60_000;

/** The App's JWT, signed RS256 with its private key. */
export function appJwt({ appId, key, now = () => new Date() }) {
  const at = Math.floor(now().getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: at - JWT_BACK, exp: at + JWT_LIFE, iss: String(appId) }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key, 'base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * `appId` the App's id, `privateKey` its PEM, `owner` the account it is
 * installed on. Returns `token(scope)`, where `scope` may name
 * `repositories` (names, not "owner/name") and `permissions` to narrow the
 * token to.
 */
export function createAppAuth({ appId, privateKey, owner, api = 'https://api.github.com', fetchImpl = fetch, now = () => new Date(), timeoutMs = 20_000 }) {
  if (!/^\d+$/.test(String(appId ?? ''))) throw new Error('GITHUB_APP_ID must be the App\'s numeric id');
  if (!/^[\w.-]+$/.test(String(owner ?? ''))) throw new Error('GITHUB_OWNER must name the account the App is installed on');
  let key;
  try {
    key = createPrivateKey(String(privateKey ?? ''));
  } catch {
    // Node's own message quotes nothing of the key, but says little either.
    throw new Error('GITHUB_APP_KEY_FILE must hold the App\'s private key (PEM)');
  }

  async function call(method, where, bearer, body) {
    const res = await fetchImpl(`${api}${where}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'aemtli',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // GitHub answers JSON; anything else is reported by its status.
    }
    if (!res.ok) throw Object.assign(new Error(`GitHub answered ${res.status}: ${json?.message ?? res.statusText}`), { status: res.status });
    return json;
  }

  let installation = null;
  const tokens = new Map();

  /** The installation on `owner`, looked up once. */
  async function installationId() {
    if (installation) return installation;
    const all = await call('GET', '/app/installations?per_page=100', appJwt({ appId, key, now }));
    const mine = (Array.isArray(all) ? all : []).find(i => i.account?.login?.toLowerCase() === owner.toLowerCase());
    if (!mine) throw new Error(`the App is not installed on ${owner}`);
    installation = mine.id;
    return installation;
  }

  return async function token(scope = {}) {
    const asked = {
      ...(scope.repositories ? { repositories: [...scope.repositories].sort() } : {}),
      ...(scope.permissions ? { permissions: scope.permissions } : {}),
    };
    const cacheKey = JSON.stringify(asked);
    const kept = tokens.get(cacheKey);
    if (kept && kept.until - now().getTime() > RENEW_BEFORE) return kept.token;
    const id = await installationId();
    const got = await call('POST', `/app/installations/${id}/access_tokens`, appJwt({ appId, key, now }), Object.keys(asked).length ? asked : undefined);
    tokens.set(cacheKey, { token: got.token, until: Date.parse(got.expires_at) });
    return got.token;
  };
}
