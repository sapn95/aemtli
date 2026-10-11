// The four Kubernetes calls the UI makes, with the pod's own service account:
// list the recipe CronJobs, list their Jobs, read one CronJob, and create a
// Job from it. The Role in deploy/kubernetes grants exactly these.
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

export const LABEL_PART_OF = 'app.kubernetes.io/part-of=aemtli';
export const LABEL_RECIPE = 'aemtli.sapn.ch/recipe';
export const LABEL_TRIGGER = 'aemtli.sapn.ch/trigger';

/**
 * Whether a Job is still going. `status.active` stays empty for the first
 * second or so of a new Job, so "not finished" is the safer reading: no
 * completion time and no Complete or Failed condition.
 */
export function jobRunning(job) {
  if ((job.status?.active ?? 0) > 0) return true;
  if (job.status?.completionTime) return false;
  return !(job.status?.conditions ?? []).some(c => ['Complete', 'Failed'].includes(c.type) && c.status === 'True');
}

/**
 * Creates the client. In the cluster it needs nothing: address, CA, token
 * and namespace come from the service account mount. Tests pass `baseUrl`
 * (plain HTTP), `token` and `namespace`.
 */
export function createK8s({
  baseUrl = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`,
  namespace = readFileSync(`${SA}/namespace`, 'utf8').trim(),
  token,
  ca,
} = {}) {
  const url = new URL(baseUrl);
  const tls = url.protocol === 'https:';
  const caCert = tls ? (ca ?? readFileSync(`${SA}/ca.crt`)) : undefined;

  /** One API call; resolves with the parsed body, rejects with the API's message. */
  function call(method, path, body) {
    // Read on every call: projected service account tokens are rotated.
    const bearer = token ?? readFileSync(`${SA}/token`, 'utf8').trim();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const send = tls ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = send({
        hostname: url.hostname,
        port: url.port,
        path,
        method,
        ca: caCert,
        timeout: 10_000,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => {
          let parsed = {};
          try { parsed = data ? JSON.parse(data) : {}; } catch { /* not JSON */ }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`${method} ${path}: ${res.statusCode} ${parsed.message ?? data.slice(0, 200)}`));
        });
      });
      req.on('timeout', () => req.destroy(new Error(`${method} ${path}: timed out`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const batch = `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}`;
  const selector = s => `labelSelector=${encodeURIComponent(s)}`;

  return {
    namespace,

    /** The CronJobs that are recipes. */
    async listCronJobs() {
      return (await call('GET', `${batch}/cronjobs?${selector(LABEL_PART_OF)}`)).items ?? [];
    },

    /** The Jobs those CronJobs (or the UI) started. */
    async listJobs() {
      return (await call('GET', `${batch}/jobs?${selector(LABEL_PART_OF)}`)).items ?? [];
    },

    /** One CronJob by name. */
    getCronJob(name) {
      return call('GET', `${batch}/cronjobs/${encodeURIComponent(name)}`);
    },

    /**
     * Starts a Job from a CronJob's template now, like `kubectl create job
     * --from=cronjob/<name>`, marked as a manual run.
     */
    async runNow(name) {
      const cron = await this.getCronJob(name);
      const spec = structuredClone(cron.spec.jobTemplate.spec);
      const labels = { ...(cron.spec.jobTemplate.metadata?.labels ?? {}), [LABEL_TRIGGER]: 'manual' };
      spec.template.metadata = spec.template.metadata ?? {};
      spec.template.metadata.labels = { ...(spec.template.metadata.labels ?? {}), [LABEL_TRIGGER]: 'manual' };
      const job = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          generateName: `${name}-manual-`,
          labels,
          annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' },
          // Owned by the CronJob, so its history limits clean manual runs up too.
          // controller: true is what makes the CronJob controller count this
          // Job: its concurrencyPolicy and history limits only look at Jobs it
          // controls. `kubectl create job --from` sets the same.
          ownerReferences: [{
            apiVersion: 'batch/v1', kind: 'CronJob', name: cron.metadata.name, uid: cron.metadata.uid,
            controller: true, blockOwnerDeletion: true,
          }],
        },
        spec,
      };
      return call('POST', `${batch}/jobs`, job);
    },
  };
}
