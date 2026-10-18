import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotify, startNotifyServer } from '../src/web/notify.mjs';
import { createPush } from '../src/web/approvals.mjs';

test('a push goes down every channel, and counts as sent if any took it', async () => {
  const seen = [];
  const lines = [];
  const take = name => async message => { seen.push([name, message.title]); return name === 'web'; };
  const broken = async () => { throw new Error('ntfy is down'); };
  assert.equal(await createNotify([take('ntfy'), take('web')])({ title: 'a', message: 'b' }), true);
  assert.deepEqual(seen, [['ntfy', 'a'], ['web', 'a']]);
  assert.equal(await createNotify([take('ntfy')])({ title: 'c' }), false, 'none took it');
  assert.equal(await createNotify([broken, take('web')], l => lines.push(l))({ title: 'd' }), true, 'a channel that throws stops no other');
  assert.deepEqual(lines, ['could not push: ntfy is down']);
  assert.equal(await createNotify([])({ title: 'e' }), false, 'no channel at all');
});

test('the notify port takes a push from a job with the token, and nothing else', async () => {
  const pushed = [];
  let deliver = true;
  const server = await startNotifyServer({ notify: async m => { pushed.push(m); return deliver; }, token: 'job-token', port: 0, host: '127.0.0.1', log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = { authorization: 'Bearer job-token' }, path = '/notify') =>
    fetch(`${base}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    assert.equal((await post({ title: 'x' }, {})).status, 401, 'no token');
    assert.equal((await post({ title: 'x' }, { authorization: 'Bearer job-tokeN' })).status, 401, 'a wrong one');
    assert.equal((await post({ title: 'x' }, { authorization: 'job-token' })).status, 401, 'not as a bearer');
    assert.equal((await fetch(`${base}/notify`)).status, 405);
    assert.equal((await post({ title: 'x' }, undefined, '/other')).status, 404);
    for (const bad of ['{', JSON.stringify({ message: 'no title' }), JSON.stringify({ title: '  ' }), JSON.stringify({ title: 3 }), `{"title":"${'x'.repeat(20000)}"}`]) {
      assert.equal((await post(bad)).status, 400, bad.slice(0, 30));
    }
    assert.equal(pushed.length, 0, 'nothing went out yet');

    const res = await post({ title: 'Frist: Prämie', message: 'Bis Freitag.', click: 'https://chores.example/x', tags: 'bell', extra: 'dropped' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { delivered: true });
    deliver = false;
    assert.deepEqual(await (await post({ title: 'y', click: 7 })).json(), { delivered: false });
    assert.deepEqual(pushed, [
      { title: 'Frist: Prämie', message: 'Bis Freitag.', click: 'https://chores.example/x', tags: 'bell' },
      { title: 'y', message: '' },
    ]);
  } finally {
    server.close();
  }
  await assert.rejects(() => startNotifyServer({ notify: async () => true, token: '', port: 0 }), /needs a token/);
});

test('ntfy gets the tags one by one, whichever way the push came', async () => {
  const bodies = [];
  const lines = [];
  const push = createPush({ ntfyUrl: 'http://ntfy.test', topic: 'chores', token: 't', log: l => lines.push(l), fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: bodies.length === 1, status: 503 }; } });
  assert.equal(await push({ title: 'Frist', message: 'Bis Freitag', tags: 'warning, bell', click: 'https://chores.example' }), true);
  assert.deepEqual(bodies[0], { topic: 'chores', title: 'Frist', message: 'Bis Freitag', tags: ['warning', 'bell'], click: 'https://chores.example' });
  assert.equal(await push({ title: 'x', message: 'y' }), false);
  assert.deepEqual(bodies[1].tags, ['speech_balloon']);
  assert.deepEqual(lines, ['could not push: ntfy answered 503']);
});
