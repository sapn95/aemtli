import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createK8s, LABEL_TRIGGER, jobRunning } from '../src/web/k8s.mjs';

const CRON = {
  metadata: { name: 'hello', uid: 'uid-1', labels: { 'aemtli.sapn.ch/recipe': 'hello' } },
  spec: {
    schedule: '13 8 * * 1',
    jobTemplate: {
      metadata: { labels: { 'app.kubernetes.io/part-of': 'aemtli', 'aemtli.sapn.ch/recipe': 'hello' } },
      spec: { template: { metadata: { labels: { [LABEL_TRIGGER]: 'schedule' } }, spec: { containers: [{ name: 'run' }] } } },
    },
  },
};

/** A fake API server recording requests; `routes` maps "METHOD path" to a body or status. */
async function fakeApi() {
  const seen = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: data ? JSON.parse(data) : null });
      const path = req.url.split('?')[0];
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'GET' && path === '/apis/batch/v1/namespaces/chores/cronjobs') return send(200, { items: [CRON] });
      if (req.method === 'GET' && path === '/apis/batch/v1/namespaces/chores/jobs') return send(200, { items: [] });
      if (req.method === 'GET' && path === '/apis/batch/v1/namespaces/chores/cronjobs/hello') return send(200, CRON);
      if (req.method === 'POST' && path === '/apis/batch/v1/namespaces/chores/jobs') return send(201, { metadata: { name: 'hello-manual-abc' } });
      return send(404, { message: 'not found here' });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const k8s = createK8s({ baseUrl: `http://127.0.0.1:${server.address().port}`, namespace: 'chores', token: 'sa-token' });
  return { k8s, seen, close: () => new Promise(r => server.close(r)) };
}

test('lists CronJobs and Jobs by the part-of label, with the token', async () => {
  const api = await fakeApi();
  try {
    assert.equal((await api.k8s.listCronJobs())[0].metadata.name, 'hello');
    assert.deepEqual(await api.k8s.listJobs(), []);
    assert.match(api.seen[0].url, /labelSelector=app.kubernetes.io%2Fpart-of%3Daemtli/);
    assert.equal(api.seen[0].auth, 'Bearer sa-token');
  } finally { await api.close(); }
});

test('runNow creates a Job from the template, owned by the CronJob, marked manual', async () => {
  const api = await fakeApi();
  try {
    const job = await api.k8s.runNow('hello');
    assert.equal(job.metadata.name, 'hello-manual-abc');
    const posted = api.seen.find(s => s.method === 'POST').body;
    assert.equal(posted.metadata.generateName, 'hello-manual-');
    assert.equal(posted.metadata.labels[LABEL_TRIGGER], 'manual');
    assert.equal(posted.metadata.labels['aemtli.sapn.ch/recipe'], 'hello');
    assert.equal(posted.spec.template.metadata.labels[LABEL_TRIGGER], 'manual');
    assert.deepEqual(posted.metadata.ownerReferences, [{ apiVersion: 'batch/v1', kind: 'CronJob', name: 'hello', uid: 'uid-1', controller: true, blockOwnerDeletion: true }]);
    assert.equal(CRON.spec.jobTemplate.spec.template.metadata.labels[LABEL_TRIGGER], 'schedule', 'the CronJob object is not modified');
  } finally { await api.close(); }
});

test('an API error carries its status and message', async () => {
  const api = await fakeApi();
  try {
    await assert.rejects(api.k8s.getCronJob('missing'), /404 not found here/);
  } finally { await api.close(); }
});

test('an unreachable API rejects', async () => {
  const k8s = createK8s({ baseUrl: 'http://127.0.0.1:1', namespace: 'x', token: 't' });
  await assert.rejects(k8s.listJobs());
});

test('a Job counts as running until it has finished, not only while pods are active', () => {
  assert.equal(jobRunning({ status: {} }), true, 'just created, no pod yet');
  assert.equal(jobRunning({ status: { active: 1 } }), true);
  assert.equal(jobRunning({ status: { completionTime: '2026-10-11T10:00:00Z' } }), false);
  assert.equal(jobRunning({ status: { conditions: [{ type: 'Failed', status: 'True' }] } }), false);
  assert.equal(jobRunning({ status: { conditions: [{ type: 'Complete', status: 'True' }] } }), false);
  assert.equal(jobRunning({ status: { conditions: [{ type: 'Suspended', status: 'True' }] } }), true);
});
