import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { findProblems, redact, createCluster, createKubeApi, clusterTools, namespaces } from '../src/mcp/cluster.mjs';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const ago = minutes => new Date(NOW - minutes * 60_000).toISOString();
const meta = (name, namespace = 'aemtli', extra = {}) => ({ metadata: { name, namespace, creationTimestamp: ago(600), ...extra } });
const cond = (type, status, message) => ({ type, status, ...(message ? { message } : {}) });

const pod = (name, { phase = 'Running', waiting, owner, created = ago(600), init } = {}) => ({
  ...meta(name, 'apps', { creationTimestamp: created, ownerReferences: owner ? [{ kind: owner.kind, name: owner.name, controller: true }] : undefined }),
  status: {
    phase,
    containerStatuses: [{ name: 'c', state: waiting ? { waiting: { reason: waiting } } : { running: {} } }],
    ...(init ? { initContainerStatuses: [{ name: 'i', state: { waiting: { reason: init } } }] } : {}),
  },
});
const job = (name, cron, outcome, minutesAgo, ns = 'backup', message) => ({
  ...meta(name, ns, { creationTimestamp: ago(minutesAgo), ownerReferences: [{ kind: 'CronJob', name: cron }] }),
  status: { conditions: outcome === 'running' ? [] : [cond(outcome === 'failed' ? 'Failed' : 'Complete', 'True', message)] },
});

test('every kind of problem is found once, with a key that stays, and the handgrip that may help', () => {
  const problems = findProblems({
    apps: [
      { ...meta('pi-backup', 'argocd'), status: { health: { status: 'Degraded' }, sync: { status: 'Synced' } } },
      { ...meta('aemtli', 'argocd'), status: { health: { status: 'Healthy' }, sync: { status: 'OutOfSync' } } },
      { ...meta('fine', 'argocd'), status: { health: { status: 'Progressing' }, sync: { status: 'Synced' } } },
    ],
    replicaSets: [{ metadata: { name: 'web-abc', namespace: 'apps', ownerReferences: [{ kind: 'Deployment', name: 'web' }] } }],
    pods: [
      pod('web-abc-1', { waiting: 'CrashLoopBackOff', owner: { kind: 'ReplicaSet', name: 'web-abc' } }),
      pod('web-abc-2', { waiting: 'CrashLoopBackOff', owner: { kind: 'ReplicaSet', name: 'web-abc' } }),
      pod('db-0', { init: 'ImagePullBackOff', owner: { kind: 'StatefulSet', name: 'db' } }),
      pod('new', { phase: 'Pending', created: ago(2) }),
      pod('stuck', { phase: 'Pending', created: ago(30) }),
      pod('job-pod', { waiting: 'CrashLoopBackOff', owner: { kind: 'Job', name: 'x' } }),
      pod('done', { phase: 'Succeeded' }),
    ],
    deployments: [
      { ...meta('web', 'apps'), spec: { replicas: 2 }, status: { readyReplicas: 0, conditions: [cond('Available', 'False')] } },
      { ...meta('api', 'apps'), spec: { replicas: 1 }, status: { readyReplicas: 0, conditions: [cond('Available', 'False')] } },
      { ...meta('off', 'apps'), spec: { replicas: 0 }, status: { conditions: [cond('Available', 'False')] } },
    ],
    cronJobs: [
      { ...meta('pi-backup', 'backup'), spec: { schedule: '17 2 * * *' }, status: { lastSuccessfulTime: ago(60 * 24 * 6) } },
      { ...meta('fine', 'backup'), spec: { schedule: '17 2 * * *' }, status: { lastSuccessfulTime: ago(60 * 10) } },
      { ...meta('late', 'backup'), spec: { schedule: '0 * * * *' }, status: { lastSuccessfulTime: ago(60 * 5) } },
      { ...meta('busy', 'backup'), spec: { schedule: '0 * * * *' }, status: { lastSuccessfulTime: ago(60 * 5) } },
      { ...meta('paused', 'backup'), spec: { schedule: '0 * * * *', suspend: true } },
      { ...meta('odd', 'backup'), spec: { schedule: 'not a schedule' } },
    ],
    jobs: [
      job('pi-backup-3', 'pi-backup', 'failed', 60 * 10, 'backup', 'BackoffLimitExceeded'),
      job('pi-backup-2', 'pi-backup', 'failed', 60 * 34),
      job('pi-backup-1', 'pi-backup', 'complete', 60 * 24 * 6),
      job('fine-1', 'fine', 'complete', 60 * 10),
      job('busy-1', 'busy', 'running', 3),
    ],
    nodes: [
      { ...meta('pi', undefined), status: { conditions: [cond('Ready', 'True'), cond('DiskPressure', 'True'), cond('MemoryPressure', 'False')] } },
      { ...meta('gone', undefined), status: { conditions: [cond('Ready', 'Unknown')] } },
    ],
    externalSecrets: [
      { ...meta('aemtli-vapid'), status: { conditions: [cond('Ready', 'False', 'could not get secret data from provider')] } },
      { ...meta('fine'), status: { conditions: [cond('Ready', 'True')] } },
      { ...meta('new') },
    ],
    probes: [{ url: 'https://goose.example', ok: true, status: 302 }, { url: 'https://board.example', ok: false, status: 530 }, { url: 'https://down.example', ok: false, error: 'ENOTFOUND' }],
  }, NOW);

  assert.deepEqual(problems.map(p => p.key), [
    'argo/pi-backup', 'argo/aemtli',
    'pod/apps/Deployment/web', 'pod/apps/StatefulSet/db', 'pod/apps/Pod/stuck',
    'deployment/apps/api',
    'cronjob/backup/pi-backup', 'cronjob/backup/late',
    'node/pi/DiskPressure', 'node/gone/Ready',
    'externalsecret/aemtli/aemtli-vapid',
    'probe/https://board.example', 'probe/https://down.example',
  ]);
  const by = Object.fromEntries(problems.map(p => [p.key, p]));
  assert.deepEqual(by['argo/pi-backup'].remedy, { action: 'refresh', namespace: 'argocd', app: 'pi-backup' });
  assert.deepEqual(by['pod/apps/Deployment/web'].remedy, { action: 'restart', namespace: 'apps', deployment: 'web' });
  assert.equal(by['pod/apps/StatefulSet/db'].remedy, undefined, 'an image that cannot be pulled waits for a fix in git');
  assert.equal(by['pod/apps/StatefulSet/db'].summary, 'StatefulSet apps/db: ImagePullBackOff');
  assert.equal(by['cronjob/backup/pi-backup'].summary, 'CronJob backup/pi-backup: the last 2 runs failed (BackoffLimitExceeded)');
  assert.equal(by['cronjob/backup/pi-backup'].failedRuns, 2);
  assert.deepEqual(by['cronjob/backup/pi-backup'].remedy, { action: 'rerun', namespace: 'backup', cronjob: 'pi-backup' });
  assert.match(by['cronjob/backup/late'].summary, /no successful run since 2026-10-18T07:00Z/);
  assert.equal(by['node/pi/DiskPressure'].remedy, undefined);
  assert.deepEqual(by['externalsecret/aemtli/aemtli-vapid'].remedy, { action: 'resync', namespace: 'aemtli', externalsecret: 'aemtli-vapid' });
  assert.equal(by['probe/https://board.example'].summary, 'https://board.example: answered 530');
  assert.equal(by['probe/https://down.example'].summary, 'https://down.example: ENOTFOUND');
});

test('a CronJob that never succeeded is judged from its birth, and one failed run reads as one', () => {
  const [p] = findProblems({
    cronJobs: [{ ...meta('fresh', 'x', { creationTimestamp: ago(60 * 30) }), spec: { schedule: '*/5 * * * *' }, status: {} }],
  }, NOW);
  assert.match(p.summary, /no successful run since/);
  const [q] = findProblems({
    cronJobs: [{ ...meta('once', 'x'), spec: { schedule: '0 3 * * *' }, status: {} }],
    jobs: [job('once-1', 'once', 'failed', 60, 'x')],
  }, NOW);
  assert.equal(q.summary, 'CronJob x/once: the last run failed');
});

test('a log loses what looks like a credential, in the forms logs write them', () => {
  // Built at run time, so the repository's own secret scans do not take
  // these made-up tokens for real ones.
  const GHP = `ghp_${'a1'.repeat(18)}`;
  const PAT = `github_pat_${'11ABCDEFG0'.repeat(3)}`;
  const AKIA = `AKIA${'X'.repeat(16)}`;
  const GHS = `ghs_${'b2'.repeat(18)}`;
  const ANT = `sk-ant-api03-${'c3'.repeat(14)}`;
  const AWS = `${'wJalr'.repeat(8)}`;
  const CFAT = `cfat_${'d4'.repeat(14)}`;
  const lines = {
    '"Authorization":"Bearer abc.def"': 'abc.def',
    [`Authorization: token ${GHS}`]: GHS,
    [`using ${GHP} now`]: GHP,
    [PAT]: PAT,
    [`key ${ANT} here`]: ANT,
    [`AWS_SECRET_ACCESS_KEY=${AWS}`]: AWS,
    [`id ${AKIA}`]: AKIA,
    'connecting to postgres://kanban:s3cr3t@db:5432/kanban': 's3cr3t',
    'GET https://user:pw123@example.com/x': 'pw123',
    'Set-Cookie: session=abcdef123; Path=/': 'abcdef123',
    'run --token xyz987 --verbose': 'xyz987',
    'GET /callback?code=oauthcode123&state=1': 'oauthcode123',
    'url ?X-Amz-Signature=deadbeef42 ok': 'deadbeef42',
    [CFAT]: CFAT,
  };
  for (const [line, secret] of Object.entries(lines)) assert.ok(!redact(line).includes(secret), `${line} -> ${redact(line)}`);
  // Built from parts, so neither this file nor the secret scans hold a key header.
  const [begin, end] = ['BEGIN', 'END'].map(w => `-----${w} PRIVATE ${'KEY'}-----`);
  const pem = [begin, 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', end].join('\n');
  assert.equal(redact(`before\n${pem}\nafter`), 'before\n[a private key, blanked]\nafter');
  for (const harmless of ['GET /healthz 200 3ms', 'restic: snapshot a7c7a6d3 saved', 'tokens used: 120']) assert.equal(redact(harmless), harmless);
});

test('a log loses its tokens and passwords, and keeps its end', () => {
  const text = [
    'Authorization: Bearer abc.def.ghi',
    'password=hunter2 user=me',
    '{"api_key": "sk-123", "token":"t0k"}',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U here', // gitleaks:allow (jwt.io's published example token)
  ].join('\n');
  const out = redact(text);
  for (const secret of ['abc.def.ghi', 'hunter2', 'sk-123', 't0k', 'eyJhbGciOiJIUzI1NiJ9']) assert.ok(!out.includes(secret), secret);
  assert.match(out, /user=me/);
  assert.equal(redact('x'.repeat(50) + 'END', 10), 'xxxxxxxEND');
});

/** An API that answers from a table, and keeps what it was asked. */
function fakeApi(table) {
  const asked = [];
  const api = async (method, path, body, contentType) => {
    asked.push({ method, path, body, contentType });
    const key = `${method} ${path.split('?')[0]}`;
    const answer = table[key] ?? table[`${method} ${path}`];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new Error(`${key}: 404 not found`);
    return typeof answer === 'function' ? answer(body, path) : answer;
  };
  return { api, asked };
}

test('health reads every list, takes a missing kind as none, and looks at the public addresses', async () => {
  const { api } = fakeApi({
    'GET /apis/apps/v1/deployments': { items: [] },
    'GET /apis/apps/v1/replicasets': { items: [] },
    'GET /api/v1/pods': { items: [] },
    'GET /apis/batch/v1/cronjobs': { items: [] },
    'GET /apis/batch/v1/jobs': { items: [] },
    'GET /api/v1/nodes': { items: [meta('pi', undefined)] },
    // No Argo CD and no ESO in this cluster: 404 from the fake for both.
  });
  const fetchImpl = async url => {
    if (url.includes('down')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return { status: url.includes('bad') ? 502 : 200 };
  };
  const cluster = createCluster({ api, probes: ['https://up.example/healthz', 'https://bad.example', 'https://down.example'], fetchImpl, now: () => new Date(NOW) });
  const { problems, looked } = await cluster.health();
  assert.deepEqual(looked, { apps: 0, deployments: 0, pods: 0, cronJobs: 0, nodes: 1, externalSecrets: 0, probes: 3 });
  assert.deepEqual(problems.map(p => p.summary), ['Node pi is not ready', 'https://bad.example: answered 502', 'https://down.example: ECONNREFUSED']);

  const broken = createCluster({ api: async () => { throw new Error('GET /api/v1/pods: 403 forbidden'); }, now: () => new Date(NOW) });
  await assert.rejects(() => broken.health(), /403 forbidden/, 'a refusal is not taken for an empty cluster');
});

test('logs come from a pod, a Job\'s newest pod or a Deployment\'s, blanked; events newest first', async () => {
  const { api, asked } = fakeApi({
    'GET /api/v1/namespaces/backup/pods': (b, path) => ({ items: path.includes('job-name') ? [meta('pb-old', 'backup', { creationTimestamp: ago(90) }), meta('pb-new', 'backup', { creationTimestamp: ago(10) })] : [meta('web-1', 'backup')] }),
    'GET /apis/apps/v1/namespaces/backup/deployments/web': { spec: { selector: { matchLabels: { app: 'web', tier: 'front' } } } },
    'GET /api/v1/namespaces/backup/pods/pb-new/log': 'Fatal: nothing to backup\npassword=hunter2\n',
    'GET /api/v1/namespaces/backup/pods/web-1/log': 'listening\n',
    'GET /api/v1/namespaces/backup/pods/x/log': 'x\n',
    'GET /api/v1/namespaces/backup/events': { items: [
      { lastTimestamp: ago(30), involvedObject: { kind: 'Pod', name: 'a' }, reason: 'BackOff', message: 'Back-off restarting', count: 4 },
      { lastTimestamp: ago(5), involvedObject: { kind: 'Job', name: 'b' }, reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' },
    ] },
  });
  const cluster = createCluster({ api, logNamespaces: namespaces('backup, kanban') });
  const fromJob = await cluster.logs({ namespace: 'backup', job: 'pi-backup-1', lines: 50 });
  assert.equal(fromJob.pod, 'pb-new');
  assert.equal(fromJob.log, 'Fatal: nothing to backup\npassword=[blanked]\n');
  assert.ok(asked.some(a => a.path === '/api/v1/namespaces/backup/pods?labelSelector=job-name%3Dpi-backup-1'));
  assert.ok(asked.some(a => a.path === '/api/v1/namespaces/backup/pods/pb-new/log?tailLines=50'));
  assert.equal((await cluster.logs({ namespace: 'backup', deployment: 'web' })).pod, 'web-1');
  assert.ok(asked.some(a => a.path === '/api/v1/namespaces/backup/pods?labelSelector=app%3Dweb%2Ctier%3Dfront'));
  await cluster.logs({ namespace: 'backup', pod: 'x', previous: true, container: 'restic' });
  assert.ok(asked.some(a => a.path === '/api/v1/namespaces/backup/pods/x/log?tailLines=100&previous=true&container=restic'));

  await assert.rejects(() => cluster.logs({ namespace: 'backup' }), /name a pod, a job or a deployment/);
  await assert.rejects(() => cluster.logs({ namespace: 'Backup!', pod: 'x' }), /namespace is not a Kubernetes name/);
  await assert.rejects(() => cluster.logs({ namespace: 'external-secrets', pod: 'x' }), /reading logs is not allowed in namespace external-secrets \(allowed: backup, kanban\)/);
  await assert.rejects(() => cluster.events({ namespace: 'argocd' }), /reading events is not allowed in namespace argocd/);
  await assert.rejects(() => createCluster({ api }).logs({ namespace: 'backup', pod: 'x' }), /allowed: none/, 'no list, no logs');
  await assert.rejects(() => cluster.logs({ namespace: 'backup', pod: '../x' }), /pod is not a Kubernetes name/);
  await assert.rejects(() => cluster.logs({ namespace: 'backup', pod: 'x', lines: 5000 }), /lines is a whole number/);

  const { events } = await cluster.events({ namespace: 'backup', name: 'b' });
  assert.deepEqual(events.map(e => e.reason), ['BackoffLimitExceeded', 'BackOff']);
  assert.ok(asked.some(a => a.path === '/api/v1/namespaces/backup/events?fieldSelector=type%3DWarning%2CinvolvedObject.name%3Db'));
});

test('the handgrips: restart, rerun, refresh and resync, each the patch or the Job kubectl would make', async () => {
  const cron = { metadata: { name: 'pi-backup', uid: 'u-1' }, spec: { jobTemplate: { metadata: { labels: { app: 'backup' } }, spec: { backoffLimit: 2, template: { spec: { containers: [] } } } } } };
  const { api, asked } = fakeApi({
    'PATCH /apis/apps/v1/namespaces/apps/deployments/web': {},
    'GET /apis/batch/v1/namespaces/backup/cronjobs/pi-backup': cron,
    'POST /apis/batch/v1/namespaces/backup/jobs': body => ({ metadata: { name: `${body.metadata.generateName}x1` } }),
    'PATCH /apis/argoproj.io/v1alpha1/namespaces/argocd/applications/pi-backup': {},
    'PATCH /apis/argoproj.io/v1alpha1/namespaces/argo-cd/applications/web': {},
    'PATCH /apis/external-secrets.io/v1/namespaces/aemtli/externalsecrets/aemtli-vapid': {},
  });
  const cluster = createCluster({ api, now: () => new Date(NOW), healNamespaces: namespaces('apps,aemtli'), rerunNamespaces: namespaces('backup') });
  assert.deepEqual(await cluster.restart({ namespace: 'apps', deployment: 'web' }), { restarted: 'apps/web' });
  assert.deepEqual(await cluster.rerun({ namespace: 'backup', cronjob: 'pi-backup' }), { started: 'pi-backup-heal-x1' });
  assert.deepEqual(await cluster.refresh({ app: 'pi-backup' }), { refreshed: 'argocd/pi-backup' });
  assert.deepEqual(await cluster.refresh({ namespace: 'argo-cd', app: 'web' }), { refreshed: 'argo-cd/web' });
  assert.deepEqual(await cluster.resync({ namespace: 'aemtli', externalsecret: 'aemtli-vapid' }), { resynced: 'aemtli/aemtli-vapid' });

  const [restart, , made, refresh, , resync] = asked;
  assert.equal(restart.contentType, 'application/strategic-merge-patch+json');
  assert.deepEqual(restart.body, { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': '2026-10-18T12:00:00.000Z' } } } } });
  assert.equal(made.body.metadata.generateName, 'pi-backup-heal-');
  assert.deepEqual(made.body.metadata.ownerReferences, [{ apiVersion: 'batch/v1', kind: 'CronJob', name: 'pi-backup', uid: 'u-1', controller: true, blockOwnerDeletion: true }]);
  assert.equal(made.body.metadata.annotations['aemtli.sapn.ch/healed-by'], 'cluster-watch');
  assert.deepEqual(made.body.spec, cron.spec.jobTemplate.spec);
  assert.deepEqual([refresh.contentType, refresh.body], ['application/merge-patch+json', { metadata: { annotations: { 'argocd.argoproj.io/refresh': 'hard' } } }]);
  assert.deepEqual(resync.body, { metadata: { annotations: { 'force-sync': String(NOW) } } });

  await assert.rejects(() => cluster.restart({ namespace: 'apps', deployment: 'a/b' }), /deployment is not a Kubernetes name/);
  await assert.rejects(() => cluster.restart({ namespace: 'kube-system', deployment: 'coredns' }), /a restart is not allowed in namespace kube-system/);
  await assert.rejects(() => cluster.resync({ namespace: 'external-secrets', externalsecret: 'x' }), /a resync is not allowed in namespace external-secrets/);
  await assert.rejects(() => cluster.rerun({ namespace: 'aemtli', cronjob: 'aemtli-zahlungen' }), /a rerun is not allowed in namespace aemtli \(allowed: backup\)/);
  const before = asked.length;
  await assert.rejects(() => cluster.refresh({ app: '' }), /app is not a Kubernetes name/);
  await assert.rejects(() => cluster.rerun({ namespace: 'backup', cronjob: 'UPPER' }), /cronjob is not a Kubernetes name/);
  assert.equal(asked.length, before, 'nothing refused reached the API');

  const off = fakeApi({ 'GET /apis/batch/v1/namespaces/backup/cronjobs/paused': { ...cron, spec: { ...cron.spec, suspend: true } } });
  await assert.rejects(() => createCluster({ api: off.api, rerunNamespaces: namespaces('backup') }).rerun({ namespace: 'backup', cronjob: 'paused' }), /backup\/paused is suspended/);
  assert.ok(!off.asked.some(a => a.method === 'POST'), 'and no Job was made');
});

test('the tools: names, which only read, and that each calls its method', async () => {
  const seen = [];
  const cluster = new Proxy({}, { get: (_, m) => async a => { seen.push([m, a]); return { m }; } });
  const tools = clusterTools(cluster);
  assert.deepEqual(tools.map(t => t.name), ['cluster_health', 'cluster_logs', 'cluster_events', 'cluster_restart', 'cluster_rerun', 'cluster_refresh', 'cluster_resync']);
  assert.deepEqual(tools.filter(t => t.annotations.readOnlyHint).map(t => t.name), ['cluster_health', 'cluster_logs', 'cluster_events']);
  for (const t of tools) await t.run({ namespace: 'n' });
  assert.deepEqual(seen.map(([m]) => m), ['health', 'logs', 'events', 'restart', 'rerun', 'refresh', 'resync']);
});

test('the API client sends the token and the patch type, and says what the API refused', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body });
      if (req.url.startsWith('/log')) return res.writeHead(200, { 'content-type': 'text/plain' }).end('line one\n');
      if (req.url === '/nope') return res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'forbidden: cannot list nodes' }));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const api = createKubeApi({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'sa-token' });
    assert.deepEqual(await api('GET', '/x'), { ok: true });
    assert.equal(await api('GET', '/log?tailLines=1'), 'line one\n');
    await api('PATCH', '/p', { a: 1 }, 'application/merge-patch+json');
    await assert.rejects(() => api('GET', '/nope'), /GET \/nope: 403 forbidden: cannot list nodes/);
    assert.deepEqual(seen.map(s => [s.method, s.auth, s.type ?? null]), [['GET', 'Bearer sa-token', null], ['GET', 'Bearer sa-token', null], ['PATCH', 'Bearer sa-token', 'application/merge-patch+json'], ['GET', 'Bearer sa-token', null]]);
    assert.equal(seen[2].body, '{"a":1}');
  } finally {
    server.close();
  }
});
