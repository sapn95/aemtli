#!/usr/bin/env node
// ämtli: `aemtli run <recipe>` in a CronJob, `aemtli web` for the UI.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runRecipe } from '../src/run/runner.mjs';
import { startServer } from '../src/web/server.mjs';
import { createK8s } from '../src/web/k8s.mjs';
import { createAccessVerifier } from '../src/web/auth.mjs';
import { createAcpProxy } from '../src/web/acp-proxy.mjs';
import { startModelProxy } from '../src/proxy/model-proxy.mjs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const env = process.env;

/** One timestamped line to stdout, where a pod's log goes. */
function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

/** Reads a required setting or stops with a message naming it. */
function required(name) {
  if (!env[name]) {
    console.error(`${name} must be set`);
    process.exit(2);
  }
  return env[name];
}

const USAGE = `ämtli ${version}

  aemtli run <recipe> [--param key=value]...   run one recipe with goose, record the result
  aemtli web                                   serve the dashboard and the chat
  aemtli model-proxy                           put the model key on requests goose makes

Settings come from the environment; see the README.`;

/** `aemtli run`: one recipe, exit 0 if it succeeded. */
async function run(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { param: { type: 'string', multiple: true } } });
  if (positionals.length !== 1) {
    console.error(USAGE);
    process.exit(2);
  }
  // A CronJob being stopped sends SIGTERM; goose gets it passed on, and the
  // run is recorded as cancelled instead of left at "running".
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  let record;
  try {
    record = await runRecipe({
    recipe: positionals[0],
    recipesDir: env.RECIPES_DIR ?? '/recipes',
    dataDir: env.DATA_DIR ?? '/data',
    goose: env.GOOSE_BIN ?? 'goose',
    params: values.param ?? [],
    maxTurns: env.AEMTLI_MAX_TURNS ? Number(env.AEMTLI_MAX_TURNS) : undefined,
    keep: env.AEMTLI_KEEP_RUNS ? Number(env.AEMTLI_KEEP_RUNS) : 50,
    trigger: env.AEMTLI_TRIGGER || 'manual',
    signal: controller.signal,
    });
  } catch (err) {
    // A missing recipe file or a bad name: nothing ran, so nothing is recorded.
    console.error(err.message);
    process.exit(2);
  }
  log(`${record.recipe} ${record.id}: ${record.status}${record.error ? ` (${record.error.split('\n')[0]})` : ''}`);
  process.exit(record.status === 'succeeded' ? 0 : 1);
}

/** `aemtli web`: the UI. */
async function web() {
  const authMode = env.AUTH_MODE ?? 'access';
  if (!['access', 'none'].includes(authMode)) {
    console.error('AUTH_MODE must be "access" or "none"');
    process.exit(2);
  }
  // The origin checks on "Run now" and on the chat WebSocket are what stop
  // another site from using the owner's Access cookie. Without an origin to
  // compare against they would let everything through, so with Access on the
  // setting is required rather than optional.
  if (authMode === 'access') required('PUBLIC_ORIGIN');
  // A trailing slash or a path would never equal a browser's Origin header,
  // and a scheme on the team domain would never equal a token's issuer; both
  // would turn into a 403 for everyone with nothing in the log saying why.
  let publicOrigin;
  try {
    publicOrigin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : undefined;
  } catch {
    console.error('PUBLIC_ORIGIN must be a URL such as https://chores.example.com');
    process.exit(2);
  }
  const teamDomain = (env.CF_ACCESS_TEAM_DOMAIN ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (env.K8S_BASE_URL && !(env.K8S_NAMESPACE && env.K8S_TOKEN)) {
    console.error('K8S_BASE_URL needs K8S_NAMESPACE and K8S_TOKEN as well');
    process.exit(2);
  }
  const verify = authMode === 'none' ? null : createAccessVerifier({
    teamDomain: required('CF_ACCESS_TEAM_DOMAIN') && teamDomain,
    audience: required('CF_ACCESS_AUD'),
    allowedEmails: required('ALLOWED_EMAILS').split(',').map(s => s.trim()).filter(Boolean),
  });
  const secret = env.GOOSE_SERVER__SECRET_KEY;
  const proxy = secret ? createAcpProxy({
    target: { host: env.GOOSE_SERVE_HOST ?? '127.0.0.1', port: Number(env.GOOSE_SERVE_PORT ?? 3284) },
    secret,
    allowedOrigin: publicOrigin,
  }) : null;
  const server = await startServer({
    k8s: createK8s(env.K8S_BASE_URL ? { baseUrl: env.K8S_BASE_URL, namespace: env.K8S_NAMESPACE, token: env.K8S_TOKEN } : undefined),
    dataDir: env.DATA_DIR ?? '/data',
    recipesDir: env.RECIPES_DIR ?? '/recipes',
    chatCwd: env.CHAT_CWD ?? '/data/workspace',
    allowedOrigin: publicOrigin,
    verify,
    proxy,
    version,
    log,
  }, { port: Number(env.PORT ?? 8080), host: env.HOST ?? '0.0.0.0' });
  const address = server.address();
  log(`ämtli ${version} on ${address.address}:${address.port}, auth ${authMode}, chat ${proxy ? 'on' : 'off'}`);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

/** `aemtli model-proxy`: the one place the model key lives. */
async function modelProxy() {
  const server = await startModelProxy(env, log);
  const address = server.address();
  log(`model proxy on ${address.address}:${address.port} to ${env.MODEL_UPSTREAM ?? 'https://api.anthropic.com'}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'run') await run(rest);
else if (command === 'web') await web();
else if (command === 'model-proxy') await modelProxy();
else {
  console.log(USAGE);
  process.exit(command === '--help' || command === undefined ? 0 : 2);
}
