// The cluster, for the watch job and for goose: what is broken, why, and the
// few handgrips that put most of it right again. It talks to the Kubernetes
// API with the gateway pod's own service account; the ClusterRole in the
// overlay grants the reads and exactly the writes below.
//
// What is broken comes from the API alone: Argo CD applications, workloads,
// pods, CronJobs and their Jobs, nodes and ExternalSecrets, plus a GET on the
// public addresses named in CLUSTER_PROBES. Each problem has a key that stays
// the same while it lasts, so the watch job can tell a new one from an old
// one, and the handgrip that may help, if there is one:
//
//   restart   a Deployment whose pods crash (rollout restart)
//   rerun     a CronJob whose last run failed (a Job from its template)
//   refresh   an Argo CD application that is out of sync or degraded
//   resync    an ExternalSecret that is not ready (ESO's force-sync)
//
// What may be read and touched is narrowed by namespace allow lists the
// deployment sets (CLUSTER_LOG_NAMESPACES, CLUSTER_HEAL_NAMESPACES,
// CLUSTER_RERUN_NAMESPACES); without one, that tool refuses. A log can hold a
// credential, and whoever reads it may be a model that was talked into
// sending it on, so the namespaces of the secret store, the GitOps controller
// and the tunnel are left out there, and what is read is cut and blanked
// before it leaves. The ClusterRole in the overlay is narrowed the same way,
// so the lists hold even if this code is bypassed.
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { runsBetween } from '../web/cron.mjs';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
// A pod that waits this long to be scheduled or started is a problem.
const PENDING_MS = 10 * 60_000;
// Waiting reasons that do not pass by themselves.
const STUCK = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'InvalidImageName']);

const bad = message => Object.assign(new Error(message), { status: 400 });

/** A Kubernetes name, checked before it goes into a path. */
function name(value, what) {
  if (typeof value !== 'string' || !NAME.test(value)) throw bad(`${what} is not a Kubernetes name`);
  return value;
}

/**
 * One call to the API with the service account: method, path, body, and the
 * content type a patch needs. Resolves with the parsed body, or the text for
 * a log; rejects with the API's message.
 */
export function createKubeApi({
  baseUrl = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`,
  token,
  ca,
} = {}) {
  const url = new URL(baseUrl);
  const tls = url.protocol === 'https:';
  const caCert = tls ? (ca ?? readFileSync(`${SA}/ca.crt`)) : undefined;
  return (method, path, body, contentType = 'application/json') => {
    // Read on every call: projected service account tokens are rotated.
    const bearer = token ?? readFileSync(`${SA}/token`, 'utf8').trim();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const send = tls ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = send({
        hostname: url.hostname, port: url.port, path, method, ca: caCert, timeout: 15_000,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: 'application/json, text/plain',
          ...(payload ? { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) } : {}),
        },
      }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => {
          let parsed = data;
          try { parsed = data ? JSON.parse(data) : {}; } catch { /* a log is text */ }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`${method} ${path.split('?')[0]}: ${res.statusCode} ${parsed?.message ?? String(data).slice(0, 200)}`));
        });
      });
      req.on('timeout', () => req.destroy(new Error(`${method} ${path.split('?')[0]}: timed out`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };
}

/** The condition of `type` on an object, or undefined. */
const condition = (obj, type) => (obj?.status?.conditions ?? []).find(c => c.type === type);

/** Whether a Job has finished, and how. */
function jobOutcome(job) {
  if (condition(job, 'Complete')?.status === 'True') return 'complete';
  if (condition(job, 'Failed')?.status === 'True') return 'failed';
  return 'running';
}

/** The Deployment, StatefulSet, DaemonSet or Job a pod belongs to, as kind/name. */
function ownerOf(pod, replicaSets) {
  const ref = (pod.metadata.ownerReferences ?? []).find(r => r.controller) ?? pod.metadata.ownerReferences?.[0];
  if (!ref) return { kind: 'Pod', name: pod.metadata.name };
  if (ref.kind === 'ReplicaSet') {
    const rs = replicaSets.find(r => r.metadata.namespace === pod.metadata.namespace && r.metadata.name === ref.name);
    const dep = (rs?.metadata.ownerReferences ?? []).find(r => r.kind === 'Deployment');
    if (dep) return { kind: 'Deployment', name: dep.name };
  }
  return { kind: ref.kind, name: ref.name };
}

/**
 * The problems in a snapshot of the cluster. Pure, so it is tested on its
 * own: `now` is a Date, the rest are the API's lists.
 */
export function findProblems({ apps = [], deployments = [], replicaSets = [], pods = [], cronJobs = [], jobs = [], nodes = [], externalSecrets = [], probes = [] }, now) {
  const problems = [];
  const add = p => problems.push(p);

  for (const app of apps) {
    const health = app.status?.health?.status ?? 'Unknown';
    const sync = app.status?.sync?.status ?? 'Unknown';
    // Progressing passes by itself; a sync in flight is not a problem yet.
    if (['Degraded', 'Missing', 'Unknown'].includes(health) || sync === 'OutOfSync') {
      add({
        key: `argo/${app.metadata.name}`, kind: 'Application', namespace: app.metadata.namespace, name: app.metadata.name,
        summary: `Argo CD app ${app.metadata.name}: ${health}, ${sync}`,
        remedy: { action: 'refresh', namespace: app.metadata.namespace, app: app.metadata.name },
      });
    }
  }

  // Pods that crash or cannot start, grouped by what owns them, so ten pods
  // of one Deployment are one problem.
  const byOwner = new Map();
  for (const pod of pods) {
    if (['Succeeded', 'Failed'].includes(pod.status?.phase)) continue;
    const owner = ownerOf(pod, replicaSets);
    // A Job's pods are judged by their CronJob below.
    if (owner.kind === 'Job') continue;
    const waiting = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]
      .map(c => c.state?.waiting?.reason).find(r => STUCK.has(r));
    const pendingFor = now - Date.parse(pod.metadata.creationTimestamp);
    const reason = waiting ?? (pod.status?.phase === 'Pending' && pendingFor > PENDING_MS ? 'Pending' : null);
    if (!reason) continue;
    const key = `pod/${pod.metadata.namespace}/${owner.kind}/${owner.name}`;
    if (byOwner.has(key)) continue;
    byOwner.set(key, true);
    add({
      key, kind: owner.kind, namespace: pod.metadata.namespace, name: owner.name, pod: pod.metadata.name,
      summary: `${owner.kind} ${pod.metadata.namespace}/${owner.name}: ${reason}`,
      // Restarting helps a crash that a fresh start clears; an image that
      // cannot be pulled or a pod with no room waits for a fix in git.
      ...(owner.kind === 'Deployment' && reason === 'CrashLoopBackOff' ? { remedy: { action: 'restart', namespace: pod.metadata.namespace, deployment: owner.name } } : {}),
    });
  }

  for (const dep of deployments) {
    const want = dep.spec?.replicas ?? 1;
    if (want === 0) continue;
    const available = condition(dep, 'Available');
    const key = `deployment/${dep.metadata.namespace}/${dep.metadata.name}`;
    if (available?.status === 'False' && ![...byOwner.keys()].some(k => k === `pod/${dep.metadata.namespace}/Deployment/${dep.metadata.name}`)) {
      add({ key, kind: 'Deployment', namespace: dep.metadata.namespace, name: dep.metadata.name, summary: `Deployment ${dep.metadata.namespace}/${dep.metadata.name}: ${dep.status?.readyReplicas ?? 0} of ${want} ready` });
    }
  }

  for (const cron of cronJobs) {
    if (cron.spec?.suspend) continue;
    const ns = cron.metadata.namespace;
    const mine = jobs
      .filter(j => j.metadata.namespace === ns && (j.metadata.ownerReferences ?? []).some(r => r.kind === 'CronJob' && r.name === cron.metadata.name))
      .sort((a, b) => Date.parse(b.metadata.creationTimestamp) - Date.parse(a.metadata.creationTimestamp));
    const finished = mine.filter(j => jobOutcome(j) !== 'running');
    const last = finished[0];
    const key = `cronjob/${ns}/${cron.metadata.name}`;
    const remedy = { action: 'rerun', namespace: ns, cronjob: cron.metadata.name };
    if (last && jobOutcome(last) === 'failed') {
      const failedInARow = finished.findIndex(j => jobOutcome(j) !== 'failed');
      const count = failedInARow === -1 ? finished.length : failedInARow;
      add({
        key, kind: 'CronJob', namespace: ns, name: cron.metadata.name, job: last.metadata.name,
        summary: `CronJob ${ns}/${cron.metadata.name}: the last ${count === 1 ? 'run' : `${count} runs`} failed${condition(last, 'Failed')?.message ? ` (${condition(last, 'Failed').message})` : ''}`,
        failedRuns: count, remedy,
      });
      continue;
    }
    // Missed: two or more slots went by since the last success, and nothing
    // is running now. A CronJob that never succeeded is judged from its birth.
    const since = Date.parse(cron.status?.lastSuccessfulTime ?? cron.metadata.creationTimestamp);
    let missed = [];
    try {
      missed = runsBetween(cron.spec.schedule, new Date(since), new Date(now - 60 * 60_000), cron.spec.timeZone || 'UTC', 3);
    } catch {
      // A schedule the parser does not know: not judged.
    }
    if (missed.length >= 2 && !mine.some(j => jobOutcome(j) === 'running')) {
      add({ key, kind: 'CronJob', namespace: ns, name: cron.metadata.name, summary: `CronJob ${ns}/${cron.metadata.name}: no successful run since ${new Date(since).toISOString().slice(0, 16)}Z`, remedy });
    }
  }

  for (const node of nodes) {
    const ready = condition(node, 'Ready');
    if (ready?.status !== 'True') add({ key: `node/${node.metadata.name}/Ready`, kind: 'Node', name: node.metadata.name, summary: `Node ${node.metadata.name} is not ready` });
    for (const type of ['DiskPressure', 'MemoryPressure', 'PIDPressure']) {
      if (condition(node, type)?.status === 'True') add({ key: `node/${node.metadata.name}/${type}`, kind: 'Node', name: node.metadata.name, summary: `Node ${node.metadata.name}: ${type}` });
    }
  }

  for (const es of externalSecrets) {
    const ready = condition(es, 'Ready');
    if (ready && ready.status !== 'True') {
      add({
        key: `externalsecret/${es.metadata.namespace}/${es.metadata.name}`, kind: 'ExternalSecret', namespace: es.metadata.namespace, name: es.metadata.name,
        summary: `ExternalSecret ${es.metadata.namespace}/${es.metadata.name}: ${ready.message ?? ready.reason ?? 'not ready'}`,
        remedy: { action: 'resync', namespace: es.metadata.namespace, externalsecret: es.metadata.name },
      });
    }
  }

  for (const probe of probes) {
    if (!probe.ok) add({ key: `probe/${probe.url}`, kind: 'Probe', name: probe.url, summary: `${probe.url}: ${probe.error ?? `answered ${probe.status}`}` });
  }
  return problems;
}

// What a credential looks like in a log line. Not a guarantee, a backstop:
// the namespace allow list is what keeps the secret stores' logs out.
const BLANK = [
  // Private keys, whole blocks.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[a private key, blanked]'],
  // Authorization and cookie headers, as text or as JSON.
  [/(["']?(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)?\s*)[^\s"',;]+/gi, '$1[blanked]'],
  [/(["']?(?:set-)?cookie["']?\s*[:=]\s*["']?)[^"'\n]+/gi, '$1[blanked]'],
  // Credentials in a URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[blanked]@'],
  // key=value and "key": "value" for names that hold secrets.
  [/((?:^|[\s"',;{(&?])["']?[\w.-]*(?:token|password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential|signature|code)["']?\s*[:=]\s*["']?)[^\s"',;&)}]+/gi, '$1[blanked]'],
  // --token x, --password=x.
  [/(--[\w-]*(?:token|password|secret|key)[\w-]*[=\s]+)\S+/gi, '$1[blanked]'],
  // Tokens that say what they are by their prefix.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[\w-]{20,}|sk-[A-Za-z0-9]{20,}|xox[abprs]-[\w-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|cfat_[\w-]{20,}|tk_[A-Za-z0-9]{20,})\b/g, '[a token, blanked]'],
  [/\b(eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})\b/g, '[a JWT, blanked]'],
];

/** A log with what looks like a credential blanked, at most `max` characters from the end. */
export function redact(text, max = 12_000) {
  let out = String(text);
  for (const [pattern, replacement] of BLANK) out = out.replace(pattern, replacement);
  return out.slice(-max);
}

/** A namespace allow list from its setting: comma-separated names. */
export function namespaces(setting) {
  return new Set(String(setting ?? '').split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * The cluster client: `api` is createKubeApi's function, `fetchImpl` and
 * `probes` the public addresses to look at, `now` the clock.
 */
export function createCluster({ api, probes = [], fetchImpl = fetch, now = () => new Date(), logNamespaces = new Set(), healNamespaces = new Set(), rerunNamespaces = new Set() }) {
  /** The namespace, if `allowed` names it; an error that says which list it is missing from otherwise. */
  const within = (allowed, namespace, what) => {
    name(namespace, 'namespace');
    if (!allowed.has(namespace)) throw Object.assign(new Error(`${what} is not allowed in namespace ${namespace} (allowed: ${[...allowed].join(', ') || 'none'})`), { status: 403 });
    return namespace;
  };
  const list = async path => (await api('GET', path)).items ?? [];
  // A kind that is not installed (no Argo CD, no ESO) is no error: it has none.
  const optional = path => list(path).catch(err => (/: 404 /.test(err.message) ? [] : Promise.reject(err)));

  async function probe(url) {
    try {
      const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      // A redirect to a sign-in is the tunnel answering; 5xx is it, or the app, not.
      return { url, status: res.status, ok: res.status < 500 };
    } catch (err) {
      return { url, ok: false, error: err.cause?.code ?? err.message };
    }
  }

  async function rerun(namespace, cronjob) {
    const cron = await api('GET', `/apis/batch/v1/namespaces/${namespace}/cronjobs/${cronjob}`);
    // Someone switched it off; running it anyway is not a repair.
    if (cron.spec?.suspend) throw Object.assign(new Error(`${namespace}/${cronjob} is suspended`), { status: 409 });
    const spec = structuredClone(cron.spec.jobTemplate.spec);
    const job = {
      apiVersion: 'batch/v1', kind: 'Job',
      metadata: {
        generateName: `${cronjob}-heal-`.slice(0, 57),
        labels: { ...(cron.spec.jobTemplate.metadata?.labels ?? {}), 'aemtli.sapn.ch/trigger': 'manual' },
        annotations: { 'cronjob.kubernetes.io/instantiate': 'manual', 'aemtli.sapn.ch/healed-by': 'cluster-watch' },
        ownerReferences: [{ apiVersion: 'batch/v1', kind: 'CronJob', name: cron.metadata.name, uid: cron.metadata.uid, controller: true, blockOwnerDeletion: true }],
      },
      spec,
    };
    const made = await api('POST', `/apis/batch/v1/namespaces/${namespace}/jobs`, job);
    return { started: made.metadata?.name ?? null };
  }

  return {
    /** Everything that is wrong now, each with its key and the handgrip that may help. */
    async health() {
      const [apps, deployments, replicaSets, pods, cronJobs, jobs, nodes, externalSecrets, looked] = await Promise.all([
        optional('/apis/argoproj.io/v1alpha1/applications'),
        list('/apis/apps/v1/deployments'),
        list('/apis/apps/v1/replicasets'),
        list('/api/v1/pods'),
        list('/apis/batch/v1/cronjobs'),
        list('/apis/batch/v1/jobs'),
        list('/api/v1/nodes'),
        optional('/apis/external-secrets.io/v1/externalsecrets'),
        Promise.all(probes.map(probe)),
      ]);
      const problems = findProblems({ apps, deployments, replicaSets, pods, cronJobs, jobs, nodes, externalSecrets, probes: looked }, now().getTime());
      return {
        problems,
        looked: { apps: apps.length, deployments: deployments.length, pods: pods.length, cronJobs: cronJobs.length, nodes: nodes.length, externalSecrets: externalSecrets.length, probes: looked.length },
      };
    },

    /** The last lines a pod wrote, or a Job's or Deployment's newest pod. */
    async logs({ namespace, pod, job, deployment, container, previous = false, lines = 100 }) {
      within(logNamespaces, namespace, 'reading logs');
      if (!Number.isInteger(lines) || lines < 1 || lines > 500) throw bad('lines is a whole number from 1 to 500');
      let target = pod && name(pod, 'pod');
      if (!target) {
        const selector = job ? `job-name=${name(job, 'job')}` : deployment ? null : undefined;
        if (selector === undefined) throw bad('name a pod, a job or a deployment');
        let pods;
        if (selector) pods = await list(`/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(selector)}`);
        else {
          const dep = await api('GET', `/apis/apps/v1/namespaces/${namespace}/deployments/${name(deployment, 'deployment')}`);
          const labels = Object.entries(dep.spec?.selector?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(',');
          pods = await list(`/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(labels)}`);
        }
        pods.sort((a, b) => Date.parse(b.metadata.creationTimestamp) - Date.parse(a.metadata.creationTimestamp));
        target = pods[0]?.metadata.name;
        if (!target) throw bad('no pod found for that');
      }
      const params = new URLSearchParams({ tailLines: String(lines), ...(previous ? { previous: 'true' } : {}), ...(container ? { container: name(container, 'container') } : {}) });
      const text = await api('GET', `/api/v1/namespaces/${namespace}/pods/${target}/log?${params}`);
      return { pod: target, log: redact(typeof text === 'string' ? text : JSON.stringify(text)) };
    },

    /** The warnings Kubernetes noted in a namespace, newest first, at most 30. */
    async events({ namespace, name: object }) {
      within(logNamespaces, namespace, 'reading events');
      const field = ['type=Warning', ...(object ? [`involvedObject.name=${name(object, 'name')}`] : [])].join(',');
      const items = await list(`/api/v1/namespaces/${namespace}/events?fieldSelector=${encodeURIComponent(field)}`);
      return {
        events: items
          .sort((a, b) => Date.parse(b.lastTimestamp ?? b.eventTime ?? 0) - Date.parse(a.lastTimestamp ?? a.eventTime ?? 0))
          .slice(0, 30)
          .map(e => ({ at: e.lastTimestamp ?? e.eventTime ?? null, object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`, reason: e.reason, message: redact(e.message ?? '', 500), count: e.count ?? 1 })),
      };
    },

    /** kubectl rollout restart: a new pod template annotation, so the pods are replaced one by one. */
    async restart({ namespace, deployment }) {
      const path = `/apis/apps/v1/namespaces/${within(healNamespaces, namespace, 'a restart')}/deployments/${name(deployment, 'deployment')}`;
      await api('PATCH', path, { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': now().toISOString() } } } } }, 'application/strategic-merge-patch+json');
      return { restarted: `${namespace}/${deployment}` };
    },

    /** A Job from a CronJob's template now, like kubectl create job --from. */
    async rerun({ namespace, cronjob }) {
      // async, so a bad name is a rejection like every other error here.
      const started = await rerun(within(rerunNamespaces, namespace, 'a rerun'), name(cronjob, 'cronjob'));
      return started;
    },

    /** Asks Argo CD to compare an application with git again (a hard refresh). */
    async refresh({ namespace = 'argocd', app }) {
      await api('PATCH', `/apis/argoproj.io/v1alpha1/namespaces/${name(namespace, 'namespace')}/applications/${name(app, 'app')}`, { metadata: { annotations: { 'argocd.argoproj.io/refresh': 'hard' } } }, 'application/merge-patch+json');
      return { refreshed: `${namespace}/${app}` };
    },

    /** Asks ESO to fetch an ExternalSecret again. */
    async resync({ namespace, externalsecret }) {
      await api('PATCH', `/apis/external-secrets.io/v1/namespaces/${within(healNamespaces, namespace, 'a resync')}/externalsecrets/${name(externalsecret, 'externalsecret')}`, { metadata: { annotations: { 'force-sync': String(now().getTime()) } } }, 'application/merge-patch+json');
      return { resynced: `${namespace}/${externalsecret}` };
    },
  };
}

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const NS = { type: 'string', description: 'The namespace.' };

/** The tools, for an MCP server. */
export function clusterTools(cluster) {
  const read = { readOnlyHint: true };
  const heal = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
  return [
    { name: 'cluster_health', description: 'What is wrong in the cluster now: Argo CD apps degraded or out of sync, pods that crash or cannot start, CronJobs whose last run failed or that missed their runs, nodes under pressure, ExternalSecrets not ready, public addresses that do not answer. Each problem has a stable key and, where one may help, a remedy (restart, rerun, refresh, resync).', inputSchema: obj({}), annotations: read, run: () => cluster.health() },
    { name: 'cluster_logs', description: 'The last lines of a pod\'s log, or of the newest pod of a Job or Deployment. previous: the container before its last restart. Tokens and passwords are blanked.', inputSchema: obj({ namespace: NS, pod: { type: 'string' }, job: { type: 'string' }, deployment: { type: 'string' }, container: { type: 'string' }, previous: { type: 'boolean' }, lines: { type: 'integer', minimum: 1, maximum: 500 } }, ['namespace']), annotations: read, run: a => cluster.logs(a) },
    { name: 'cluster_events', description: 'The warnings Kubernetes noted in a namespace, newest first, optionally for one object by name.', inputSchema: obj({ namespace: NS, name: { type: 'string' } }, ['namespace']), annotations: read, run: a => cluster.events(a) },
    { name: 'cluster_restart', description: 'Restarts a Deployment\'s pods one by one (kubectl rollout restart).', inputSchema: obj({ namespace: NS, deployment: { type: 'string' } }, ['namespace', 'deployment']), annotations: heal, run: a => cluster.restart(a) },
    { name: 'cluster_rerun', description: 'Starts a CronJob\'s Job now, from its template.', inputSchema: obj({ namespace: NS, cronjob: { type: 'string' } }, ['namespace', 'cronjob']), annotations: heal, run: a => cluster.rerun(a) },
    { name: 'cluster_refresh', description: 'Asks Argo CD to compare an application with git again.', inputSchema: obj({ namespace: { type: 'string', description: 'Where the Application lives; argocd when left out.' }, app: { type: 'string' } }, ['app']), annotations: heal, run: a => cluster.refresh(a) },
    { name: 'cluster_resync', description: 'Asks the External Secrets Operator to fetch an ExternalSecret again.', inputSchema: obj({ namespace: NS, externalsecret: { type: 'string' } }, ['namespace', 'externalsecret']), annotations: heal, run: a => cluster.resync(a) },
  ];
}
