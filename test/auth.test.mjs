import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createAccessVerifier } from '../src/web/auth.mjs';

const TEAM = 'team.example.com';
const AUD = 'aud-tag-1';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** A token as Access would sign it, with overrides for the claim under test. */
function token(claims = {}, { key = privateKey, header = {} } = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header });
  const p = b64({ iss: `https://${TEAM}`, aud: [AUD], email: 'Owner@example.com', exp: nowS + 600, nbf: nowS - 5, ...claims });
  const s = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
  return `${h}.${p}.${s}`;
}

/** A verifier whose key fetches are counted. */
function verifier(opts = {}) {
  const calls = { n: 0 };
  const fetchImpl = async url => {
    calls.n += 1;
    assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  };
  return { verify: createAccessVerifier({ teamDomain: TEAM, audience: AUD, allowedEmails: ['owner@example.com'], fetchImpl, ...opts }), calls };
}

test('a token Access signed for this app and an allowed address passes', async () => {
  const { verify, calls } = verifier();
  assert.deepEqual(await verify(token()), { email: 'owner@example.com' });
  await verify(token());
  assert.equal(calls.n, 1, 'keys are cached');
});

test('every way a token can be wrong is refused', async () => {
  const { verify } = verifier();
  const nowS = Math.floor(Date.now() / 1000);
  const cases = [
    [undefined, /no Access token/],
    ['a.b', /no Access token/],
    [token({}, { header: { alg: 'none' } }), /alg none/],
    [token({}, { header: { alg: 'HS256' } }), /alg HS256/],
    [token({}, { key: other }), /bad signature/],
    [token({}, { header: { kid: 'k9' } }), /unknown key/],
    [token({ exp: nowS - 600 }), /expired/],
    [token({ exp: undefined }), /expired/],
    [token({ nbf: nowS + 600 }), /not yet valid/],
    [token({ iss: 'https://evil.example.com' }), /issuer/],
    [token({ aud: ['other-app'] }), /another application/],
    [token({ email: 'someone@example.com' }), /not allowed/],
    [token({ email: undefined }), /no email is not allowed/],
  ];
  for (const [t, re] of cases) await assert.rejects(verify(t), re, String(re));
});

test('a single string aud is accepted', async () => {
  const { verify } = verifier();
  assert.equal((await verify(token({ aud: AUD }))).email, 'owner@example.com');
});

test('an unknown kid refetches the keys, but not more than once a minute', async () => {
  let t = 1_000_000_000_000;
  const { verify, calls } = verifier({ now: () => t });
  await assert.rejects(verify(token({ exp: t / 1000 + 600, nbf: t / 1000 }, { header: { kid: 'new' } })), /unknown key/);
  await assert.rejects(verify(token({ exp: t / 1000 + 600, nbf: t / 1000 }, { header: { kid: 'new' } })), /unknown key/);
  assert.equal(calls.n, 1);
  t += 61_000;
  await assert.rejects(verify(token({ exp: t / 1000 + 600, nbf: t / 1000 }, { header: { kid: 'new' } })), /unknown key/);
  assert.equal(calls.n, 2);
});

test('a failing certs endpoint is an error, and setup needs all three settings', async () => {
  const verify = createAccessVerifier({ teamDomain: TEAM, audience: AUD, allowedEmails: ['a@example.com'], fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(verify(token()), /certs answered 503/);
  assert.throws(() => createAccessVerifier({ teamDomain: TEAM, audience: AUD, allowedEmails: [] }), /at least one/);
  assert.throws(() => createAccessVerifier({ teamDomain: '', audience: AUD, allowedEmails: ['a@example.com'] }));
});

test('a failed refresh keeps the keys already held, and one fetch serves concurrent callers', async () => {
  let t = 1_000_000_000_000;
  let fail = false;
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls += 1;
    assert.ok(opts.signal, 'the fetch has a timeout');
    if (fail) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  };
  const verify = createAccessVerifier({ teamDomain: TEAM, audience: AUD, allowedEmails: ['owner@example.com'], fetchImpl, now: () => t });
  const fresh = () => token({ exp: t / 1000 + 600, nbf: t / 1000 });
  await Promise.all([verify(fresh()), verify(fresh()), verify(fresh())]);
  assert.equal(calls, 1, 'one fetch for three concurrent first requests');
  t += 2 * 60 * 60_000;
  fail = true;
  assert.equal((await verify(fresh())).email, 'owner@example.com', 'stale keys still verify');
  assert.equal(calls, 2);
});
