import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { appJwt, createAppAuth } from '../src/mcp/github-app.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const NOW = new Date('2026-10-17T10:00:00Z');
const AT = NOW.getTime() / 1000;

const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** GitHub's App endpoints behind a fetch, with every call written down. */
function fakeGitHub({ installations = [{ id: 7, account: { login: 'sapn95' } }], fail = {} } = {}) {
  const seen = [];
  let issued = 0;
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    seen.push({ method: init.method, path: pathname, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : null });
    const answer = (status, value) => new Response(value === undefined ? '' : JSON.stringify(value), { status });
    if (fail[pathname]) return answer(fail[pathname], { message: 'Bad credentials' });
    if (pathname === '/app/installations') return answer(200, installations);
    if (pathname === '/app/installations/7/access_tokens') {
      issued += 1;
      return answer(201, { token: `ghs_${issued}`, expires_at: new Date(seen.clock + 3600_000).toISOString() });
    }
    return answer(404, { message: 'Not Found' });
  };
  seen.clock = NOW.getTime();
  return { seen, fetchImpl };
}

test('the JWT is RS256, signed with the key, issued by the App, and lives nine minutes from a minute back', () => {
  const jwt = appJwt({ appId: 123, key: privateKey, now: () => NOW });
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decode(payload), { iat: AT - 60, exp: AT + 540, iss: '123' });
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature, 'base64url'));
});

test('the settings are checked, and a bad key is named without being quoted', () => {
  assert.throws(() => createAppAuth({ appId: 'x', privateKey: PEM, owner: 'o' }), /GITHUB_APP_ID/);
  assert.throws(() => createAppAuth({ appId: 1, privateKey: PEM, owner: 'a/b' }), /GITHUB_OWNER/);
  assert.throws(() => createAppAuth({ appId: 1, privateKey: 'not a key', owner: 'o' }), err => /GITHUB_APP_KEY_FILE/.test(err.message) && !/not a key/.test(err.message));
});

test('a token is bought once for the installation on the owner, and kept until five minutes before it runs out', async () => {
  const gh = fakeGitHub({ installations: [{ id: 3, account: { login: 'someone' } }, { id: 7, account: { login: 'SAPN95' } }] });
  let clock = NOW.getTime();
  const token = createAppAuth({ appId: 123, privateKey: PEM, owner: 'sapn95', fetchImpl: gh.fetchImpl, now: () => new Date(clock) });
  assert.equal(await token(), 'ghs_1');
  assert.equal(await token(), 'ghs_1');
  assert.deepEqual(gh.seen.map(s => `${s.method} ${s.path}`), ['GET /app/installations', 'POST /app/installations/7/access_tokens']);
  assert.match(gh.seen[1].auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, 'bought with the JWT');
  assert.equal(gh.seen[1].body, null, 'no scope asked: everything the App holds');

  clock += 56 * 60_000;
  assert.equal(await token(), 'ghs_2', 'four minutes left is too little');
  assert.equal(gh.seen.filter(s => s.path === '/app/installations').length, 1, 'the installation is looked up once');
});

test('a narrower token is a token of its own', async () => {
  const gh = fakeGitHub();
  const token = createAppAuth({ appId: 123, privateKey: PEM, owner: 'sapn95', fetchImpl: gh.fetchImpl, now: () => NOW });
  const scope = { repositories: ['homelab-gitops'], permissions: { contents: 'write', pull_requests: 'write' } };
  assert.equal(await token(scope), 'ghs_1');
  assert.equal(await token(), 'ghs_2');
  assert.equal(await token(scope), 'ghs_1', 'and kept as such');
  const bought = gh.seen.filter(s => s.method === 'POST');
  assert.deepEqual(bought.map(s => s.body), [scope, null]);
});

test('an App that is not installed on the owner, and GitHub saying no, are told', async () => {
  const none = fakeGitHub({ installations: [] });
  await assert.rejects(createAppAuth({ appId: 1, privateKey: PEM, owner: 'sapn95', fetchImpl: none.fetchImpl })(), /not installed on sapn95/);
  const refused = fakeGitHub({ fail: { '/app/installations': 401 } });
  await assert.rejects(createAppAuth({ appId: 1, privateKey: PEM, owner: 'sapn95', fetchImpl: refused.fetchImpl })(), err => err.status === 401 && /GitHub answered 401: Bad credentials/.test(err.message));
});
