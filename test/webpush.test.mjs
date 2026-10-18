import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, createDecipheriv, hkdfSync, generateKeyPairSync, verify, createPublicKey } from 'node:crypto';
import { encrypt, checkSubscription, loadVapidKey, vapidAuthorization, createWebPush } from '../src/web/webpush.mjs';

const b64 = text => Buffer.from(text, 'base64url');

// RFC 8291, appendix A: published example values, not secrets.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg', // gitleaks:allow (the RFC's example)
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** A browser's side: a key pair and a secret, and the decryption it does. */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const decrypt = body => {
    const salt = body.subarray(0, 16);
    assert.equal(body.readUInt32BE(16), 4096, 'record size');
    const keyLength = body[20];
    const asPublic = body.subarray(21, 21 + keyLength);
    const sealed = body.subarray(21 + keyLength);
    const shared = ecdh.computeSecret(asPublic);
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(sealed.subarray(-16));
    const padded = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
    assert.equal(padded.at(-1), 2, 'the last record ends with 0x02');
    return padded.subarray(0, -1).toString('utf8');
  };
  return { keys, decrypt };
}

const pem = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };

test('the message body is the one RFC 8291 gives for its example', () => {
  const body = encrypt(b64(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { local: RFC.asPrivate, salt: b64(RFC.salt) });
  assert.equal(body.toString('base64url'), RFC.body);
});

test('a browser can read what is encrypted for it, and a fresh key and salt go into each message', () => {
  const { keys, decrypt } = browser();
  const a = encrypt('{"title":"Grüessech"}', keys);
  const b = encrypt('{"title":"Grüessech"}', keys);
  assert.equal(decrypt(a), '{"title":"Grüessech"}');
  assert.notDeepEqual(a.subarray(0, 86), b.subarray(0, 86));
});

test('only an https URL at a known push service, with a P-256 key and a 16-byte secret, is a subscription', () => {
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://db5p.notify.windows.com/w/?token=x']) {
    assert.equal(checkSubscription({ ...SUB, endpoint }).endpoint, new URL(endpoint).href);
  }
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x', 'https://evilfcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', Object.assign(new URL('https://fcm.googleapis.com/x'), { username: 'u', password: 'p' }).href, 'https://127.0.0.1/x', 'not a url', undefined]) {
    assert.throws(() => checkSubscription({ ...SUB, endpoint }), /push service|endpoint/, String(endpoint));
  }
  assert.throws(() => checkSubscription({ ...SUB, keys: { ...SUB.keys, p256dh: b64(RFC.uaPublic).subarray(1).toString('base64url') } }), /P-256 public key/);
  const offCurve = Buffer.from(b64(RFC.uaPublic));
  offCurve[64] ^= 1;
  assert.throws(() => checkSubscription({ ...SUB, keys: { ...SUB.keys, p256dh: offCurve.toString('base64url') } }), /point on P-256/);
  assert.throws(() => checkSubscription({ ...SUB, keys: { ...SUB.keys, auth: 'AAAA' } }), /16 bytes/);
  assert.throws(() => checkSubscription(null), /endpoint/);
});

test('the VAPID key is a P-256 key, and its header is a JWT for the push service it goes to', () => {
  const vapid = loadVapidKey(pem());
  assert.equal(b64(vapid.publicKey).length, 65);
  const now = Date.UTC(2026, 9, 18, 12);
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, 'https://chores.example', now);
  const [, jwt, key] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(key, vapid.publicKey);
  const [head, claims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(b64(head)), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(b64(claims)), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://chores.example' });
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(vapid.publicKey).subarray(1, 33).toString('base64url'), y: b64(vapid.publicKey).subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64(signature)));

  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => loadVapidKey(rsa), /P-256/);
  const other = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => loadVapidKey(other), /P-256/);
});

test('subscriptions are kept on disk, replaced by endpoint, capped, and a gone one is dropped when a push says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aemtli-push-'));
  const file = join(dir, 'subs.json');
  const vapid = loadVapidKey(pem());
  const sent = [];
  const answers = {};
  const fetchImpl = async (url, init) => {
    sent.push({ url, init });
    if (answers[url] instanceof Error) throw answers[url];
    return { status: answers[url] ?? 201 };
  };
  const lines = [];
  const make = () => createWebPush({ vapid, subject: 'mailto:owner@example.com', file, fetchImpl, log: l => lines.push(l), now: () => Date.UTC(2026, 9, 18) });
  const push = make();
  assert.equal(await push.send({ title: 'x', message: 'y' }), 0, 'nobody to send to');
  assert.equal(sent.length, 0);

  const phone = browser();
  const laptop = browser();
  push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/phone', keys: phone.keys });
  push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/phone', keys: phone.keys });
  assert.equal(push.subscribe({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/laptop', keys: laptop.keys }), 2, 'the same endpoint again replaces it');
  assert.throws(() => push.subscribe({ endpoint: 'https://example.com/x', keys: phone.keys }), /not a push service/);
  assert.equal(make().count(), 2, 'kept on disk');

  assert.equal(await push.send({ title: 'Fake:\n send   thing', message: 'Waiting.', click: 'https://chores.example/#needs' }), 2);
  const [toPhone] = sent.filter(s => s.url.endsWith('/phone'));
  assert.equal(toPhone.init.method, 'POST');
  assert.equal(toPhone.init.headers['content-encoding'], 'aes128gcm');
  assert.equal(toPhone.init.headers.ttl, '86400');
  assert.equal(toPhone.init.headers.urgency, 'high');
  assert.match(toPhone.init.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.deepEqual(JSON.parse(phone.decrypt(toPhone.init.body)), { title: 'Fake: send thing', body: 'Waiting.', url: 'https://chores.example/#needs' });
  assert.ok(!toPhone.init.body.includes(Buffer.from('Waiting')), 'the push service never sees the text');

  answers['https://fcm.googleapis.com/fcm/send/phone'] = 410;
  answers['https://updates.push.services.mozilla.com/wpush/v2/laptop'] = 500;
  assert.equal(await push.send({ title: 'x', message: 'y' }), 0);
  assert.equal(push.count(), 1, 'the gone one is dropped, the failing one kept');
  assert.ok(lines.some(l => /push to updates\.push\.services\.mozilla\.com answered 500/.test(l)));
  assert.ok(lines.some(l => /dropped 1 push subscription/.test(l)));
  answers['https://updates.push.services.mozilla.com/wpush/v2/laptop'] = new Error('socket hang up');
  assert.equal(await push.send({ title: 'x', message: 'y' }), 0);
  assert.ok(lines.some(l => /could not push to updates\.push\.services\.mozilla\.com: socket hang up/.test(l)));

  assert.equal(push.unsubscribe('https://updates.push.services.mozilla.com/wpush/v2/laptop'), true);
  assert.equal(push.unsubscribe('https://updates.push.services.mozilla.com/wpush/v2/laptop'), false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);

  for (let i = 0; i < 25; i++) push.subscribe({ endpoint: `https://fcm.googleapis.com/fcm/send/${i}`, keys: phone.keys });
  assert.equal(push.count(), 20, 'at most twenty devices, the newest kept');
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].endpoint, 'https://fcm.googleapis.com/fcm/send/5');
});

test('a file that cannot be read starts empty, one that holds a bad entry loses only that, and a subject is required', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aemtli-push-'));
  const vapid = loadVapidKey(pem());
  const lines = [];
  writeFileSync(join(dir, 'broken.json'), '{');
  assert.equal(createWebPush({ vapid, subject: 'https://chores.example', file: join(dir, 'broken.json'), log: l => lines.push(l) }).count(), 0);
  assert.match(lines[0], /could not be read and start empty/);
  writeFileSync(join(dir, 'mixed.json'), JSON.stringify([SUB, { endpoint: 'https://evil.example/x', keys: SUB.keys }]));
  assert.equal(createWebPush({ vapid, subject: 'https://chores.example', file: join(dir, 'mixed.json') }).count(), 1);
  for (const subject of [undefined, '', 'chores.example', 'http://chores.example']) {
    assert.throws(() => createWebPush({ vapid, subject, file: join(dir, 'x.json') }), /subject/, String(subject));
  }
});

test('a long text in many bytes is cut to fit one record, and a long link is left out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aemtli-push-'));
  const vapid = loadVapidKey(pem());
  const sent = [];
  const push = createWebPush({ vapid, subject: 'https://chores.example', file: join(dir, 's.json'), fetchImpl: async (url, init) => { sent.push(init.body); return { status: 201 }; } });
  const phone = browser();
  push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/p', keys: phone.keys });
  await push.send({ title: 'Frist', message: '€\u0001'.repeat(500), click: `https://chores.example/${'x'.repeat(600)}` });
  await push.send({ title: 'Kurz', message: 'Bis Freitag.', click: 'https://chores.example/x' });
  const [long, short] = sent.map(body => JSON.parse(phone.decrypt(body)));
  assert.ok(Buffer.byteLength(JSON.stringify(long)) <= 3900, 'fits one record');
  assert.ok(long.body.length > 100 && long.body.length < 1000, 'cut, not dropped');
  assert.equal(long.url, undefined, 'a link that long is left out');
  assert.deepEqual(short, { title: 'Kurz', body: 'Bis Freitag.', url: 'https://chores.example/x' });
});
