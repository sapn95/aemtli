#!/usr/bin/env node
// ämtli: `aemtli run <recipe>` in a CronJob, `aemtli web` for the UI.
import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runRecipe } from '../src/run/runner.mjs';
import { runJob } from '../src/run/job.mjs';
import { startServer } from '../src/web/server.mjs';
import { createK8s } from '../src/web/k8s.mjs';
import { createAccessVerifier } from '../src/web/auth.mjs';
import { createChatBroker } from '../src/web/chats.mjs';
import { renderMarkdown } from '../src/web/markdown.mjs';
import { startModelProxy } from '../src/proxy/model-proxy.mjs';
import { startGateway } from '../src/gateway/server.mjs';
import { createKanban, kanbanTools } from '../src/mcp/kanban.mjs';
import { createRecipes, recipeTools } from '../src/mcp/recipes.mjs';
import { createGitHub, githubTools } from '../src/mcp/github.mjs';
import { createAppAuth } from '../src/mcp/github-app.mjs';
import { createTransport, transportTools } from '../src/mcp/transport.mjs';
import { createCluster, createKubeApi, clusterTools, namespaces } from '../src/mcp/cluster.mjs';
import { serveStdio } from '../src/mcp/stdio.mjs';
import { parseGateways, createGatewayClient, createNotifier, createPush } from '../src/web/approvals.mjs';
import { createWebPush, loadVapidKey } from '../src/web/webpush.mjs';
import { createNotify, startNotifyServer } from '../src/web/notify.mjs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const env = process.env;

/** One timestamped line to stdout, where a pod's log goes. */
function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

/** The run statuses that are not a failure of the run itself. */
const DONE = new Set(['succeeded', 'degraded']);

/** Reads a required setting or stops with a message naming it. */
function required(name) {
  if (!env[name]) {
    console.error(`${name} must be set`);
    process.exit(2);
  }
  return env[name];
}

/** AEMTLI_KEEP_RUNS as a count of at least 1; anything else keeps 50. */
const keepRuns = () => {
  const n = Number(env.AEMTLI_KEEP_RUNS);
  return Number.isInteger(n) && n >= 1 ? n : 50;
};

const USAGE = `ämtli ${version}

  aemtli run <recipe> [--param key=value]...   run one recipe with goose, record the result
  aemtli job <name> [--param key=value]...     run one job (code, the model only where needed)
  aemtli web                                   serve the dashboard and the chat
  aemtli model-proxy                           put the model key on requests goose makes
  aemtli mcp-gateway                           serve one MCP server to the agents, holding calls for approval
  aemtli mcp-kanban                            the kanban board as an MCP server on stdio, for a gateway
  aemtli mcp-recipes                           the chores in git as an MCP server on stdio, for a gateway
  aemtli mcp-github                            the owner's repositories as an MCP server on stdio, for a gateway
  aemtli mcp-transport                         Swiss public transport timetables as an MCP server on stdio, for a gateway
  aemtli mcp-cluster                           the cluster's health and a few handgrips as an MCP server on stdio, for a gateway

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
    keep: keepRuns(),
    trigger: env.AEMTLI_TRIGGER || 'manual',
    signal: controller.signal,
    });
  } catch (err) {
    // A missing recipe file or a bad name: nothing ran, so nothing is recorded.
    console.error(err.message);
    process.exit(2);
  }
  log(`${record.recipe} ${record.id}: ${record.status}${record.error ? ` (${record.error.split('\n')[0]})` : ''}`);
  // "degraded" is a run that did its work and said what it could not do: the
  // report carries that and the status word on the page is amber. A failing
  // pod would claim the run never happened, and with backoffLimit 0 the
  // CronJob would stand at Failed whenever one feed was down.
  process.exit(DONE.has(record.status) ? 0 : 1);
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
  // A misspelt zone would turn every dashboard request into a 500.
  const timeZone = env.DISPLAY_TIME_ZONE || 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
  } catch {
    console.error('DISPLAY_TIME_ZONE must be an IANA zone such as Europe/Zurich');
    process.exit(2);
  }
  const verify = authMode === 'none' ? null : createAccessVerifier({
    teamDomain: required('CF_ACCESS_TEAM_DOMAIN') && teamDomain,
    audience: required('CF_ACCESS_AUD'),
    allowedEmails: required('ALLOWED_EMAILS').split(',').map(s => s.trim()).filter(Boolean),
  });

  let gateways;
  try {
    gateways = createGatewayClient({ gateways: parseGateways(env.GATEWAYS, env.GATEWAY_TOKENS_DIR) });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  // The ways a push goes out: Web Push to the devices that turned it on,
  // and ntfy where it is set up. Either is optional.
  const channels = [];
  if (env.NTFY_URL) {
    const ntfy = new URL(env.NTFY_URL);
    channels.push(createPush({
      ntfyUrl: ntfy.origin + ntfy.pathname.replace(/\/$/, ''),
      topic: required('NTFY_TOPIC'),
      token: readFileSync(required('NTFY_TOKEN_FILE'), 'utf8').trim(),
      log,
    }));
  }
  // Web Push is on when its key is there: the secret is optional, like ntfy's.
  let webPush = null;
  if (env.VAPID_PRIVATE_KEY_FILE && !existsSync(env.VAPID_PRIVATE_KEY_FILE)) log(`no VAPID key at ${env.VAPID_PRIVATE_KEY_FILE}: Web Push is off`);
  else if (env.VAPID_PRIVATE_KEY_FILE) {
    try {
      webPush = createWebPush({
        vapid: loadVapidKey(readFileSync(env.VAPID_PRIVATE_KEY_FILE, 'utf8')),
        subject: env.VAPID_SUBJECT || publicOrigin,
        file: env.PUSH_FILE ?? `${env.STATE_DIR || env.DATA_DIR || '/data'}/push-subscriptions.json`,
        log,
      });
    } catch (err) {
      console.error(`Web Push: ${err.message}`);
      process.exit(2);
    }
    channels.push(async message => (await webPush.send(message)) > 0);
  }
  const push = createNotify(channels, log);
  // The chat broker holds the conversation with goose serve, so a turn goes
  // on when the browser goes away. goose takes the secret as ?token=.
  const secret = env.GOOSE_SERVER__SECRET_KEY;
  const goose = `ws://${env.GOOSE_SERVE_HOST ?? '127.0.0.1'}:${Number(env.GOOSE_SERVE_PORT ?? 3284)}/acp?token=${encodeURIComponent(secret ?? '')}`;
  const chats = secret ? createChatBroker({
    connect: () => new WebSocket(goose),
    cwd: env.CHAT_CWD ?? '/data/workspace',
    mcpServers: gateways.mcpServers,
    notify: push,
    link: id => (publicOrigin ? `${publicOrigin}/chat#${encodeURIComponent(id)}` : undefined),
    log,
    render: renderMarkdown,
  }) : null;
  if (channels.length && gateways.configured) {
    createNotifier({
      client: gateways,
      push,
      stateFile: env.NOTIFY_STATE_FILE ?? `${env.DATA_DIR ?? '/data'}/notified.json`,
      clickUrl: publicOrigin ? `${publicOrigin}/#needs` : undefined,
      log,
    }).start();
  }
  // The jobs' way to push: they run in pods of their own (see notify.mjs).
  if (env.NOTIFY_PORT && !existsSync(required('NOTIFY_TOKEN_FILE'))) log(`no token at ${env.NOTIFY_TOKEN_FILE}: the notify port stays closed`);
  else if (env.NOTIFY_PORT) {
    const notifyServer = await startNotifyServer({
      notify: push,
      origin: publicOrigin,
      token: readFileSync(required('NOTIFY_TOKEN_FILE'), 'utf8').trim(),
      port: Number(env.NOTIFY_PORT),
      log,
    });
    log(`notify port on ${notifyServer.address().port}`);
  }
  const server = await startServer({
    k8s: createK8s(env.K8S_BASE_URL ? { baseUrl: env.K8S_BASE_URL, namespace: env.K8S_NAMESPACE, token: env.K8S_TOKEN } : undefined),
    dataDir: env.DATA_DIR ?? '/data',
    recipesDir: env.RECIPES_DIR ?? '/recipes',
    stateDir: env.STATE_DIR || null,
    timeZone,
    gateways,
    allowedOrigin: publicOrigin,
    verify,
    chats,
    webPush,
    version,
    log,
  }, { port: Number(env.PORT ?? 8080), host: env.HOST ?? '0.0.0.0' });
  const address = server.address();
  log(`ämtli ${version} on ${address.address}:${address.port}, auth ${authMode}, chat ${chats ? 'on' : 'off'}, web push ${webPush ? `on (${webPush.count()} devices)` : 'off'}, ntfy ${env.NTFY_URL ? 'on' : 'off'}`);
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

/** `aemtli job`: one job, exit 0 if it succeeded. */
async function job(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { param: { type: 'string', multiple: true } } });
  if (positionals.length !== 1) {
    console.error('usage: aemtli job <name> [--param key=value]...');
    process.exit(2);
  }
  let gateways;
  try {
    gateways = JSON.parse(env.MCP_GATEWAYS ?? '{}');
  } catch {
    console.error('MCP_GATEWAYS must be JSON: {"epost":"http://aemtli-mcp-epost:8080/mcp"}');
    process.exit(2);
  }
  const params = Object.fromEntries((values.param ?? []).map(p => {
    const at = p.indexOf('=');
    return at < 0 ? [p, ''] : [p.slice(0, at), p.slice(at + 1)];
  }));
  const record = await runJob({
    name: positionals[0],
    recipesDir: env.RECIPES_DIR ?? '/recipes',
    dataDir: env.DATA_DIR ?? '/data',
    trigger: env.AEMTLI_TRIGGER === 'schedule' ? 'schedule' : 'manual',
    keep: keepRuns(),
    params,
    gateways,
  }).catch(err => {
    console.error(err.message);
    process.exit(2);
  });
  log(`${record.recipe} ${record.id}: ${record.status}${record.error ? ` (${record.error})` : ''}, ${record.tokens.total} tokens`);
  // "degraded" is a run that did its work and said what it could not do: the
  // report carries that and the status word on the page is amber. A failing
  // pod would claim the run never happened, and with backoffLimit 0 the
  // CronJob would stand at Failed whenever one feed was down.
  process.exit(DONE.has(record.status) ? 0 : 1);
}

/** `aemtli mcp-gateway`: one MCP server, its credentials, and the approval gate. */
async function mcpGateway() {
  let started;
  try {
    started = await startGateway(env, { version, log });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      await started.gateway.close();
      for (const server of started.servers) server.close();
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

/**
 * `aemtli mcp-kanban`: the board at KANBAN_URL as MCP tools on stdio. A
 * gateway runs it; stdout is the protocol, so nothing else may go there.
 */
async function mcpKanban() {
  let kanban;
  try {
    kanban = createKanban({ baseUrl: required('KANBAN_URL'), as: env.KANBAN_AS, userHeader: env.KANBAN_USER_HEADER });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  await serveStdio({ name: 'aemtli-kanban', version, tools: kanbanTools(kanban) });
}

/**
 * `aemtli mcp-recipes`: the chores in the GitOps repository as MCP tools on
 * stdio, so the agent can read a chore and propose a change to it. A gateway
 * runs it; stdout is the protocol, so nothing else may go there.
 */
async function mcpRecipes() {
  let recipes;
  try {
    const repo = required('RECIPES_REPO');
    // A fine-grained token in a file, or the GitHub App's token narrowed to
    // this repository and the two permissions a proposal needs.
    let token;
    if (env.RECIPES_TOKEN_FILE) {
      token = readFileSync(env.RECIPES_TOKEN_FILE, 'utf8').trim();
    } else {
      const [owner, name] = repo.split('/');
      const auth = appAuth(owner);
      token = () => auth({ repositories: [name], permissions: { contents: 'write', pull_requests: 'write' } });
    }
    recipes = createRecipes({
      repo,
      path: required('RECIPES_REPO_PATH'),
      base: env.RECIPES_REPO_BRANCH || 'main',
      token,
      api: env.GITHUB_API || undefined,
      branchPrefix: env.RECIPES_BRANCH_PREFIX || undefined,
    });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  await serveStdio({ name: 'aemtli-recipes', version, tools: recipeTools(recipes) });
}

/**
 * The GitHub App's installation tokens for `owner`: GITHUB_APP_ID and the
 * private key in GITHUB_APP_KEY_FILE.
 */
function appAuth(owner) {
  return createAppAuth({
    appId: required('GITHUB_APP_ID'),
    privateKey: readFileSync(required('GITHUB_APP_KEY_FILE'), 'utf8'),
    owner,
    api: env.GITHUB_API || undefined,
  });
}

/**
 * `aemtli mcp-github`: the repositories of GITHUB_OWNER as MCP tools on
 * stdio, through the GitHub App. A gateway runs it; stdout is the protocol,
 * so nothing else may go there.
 */
async function mcpGitHub() {
  let github;
  try {
    const owner = required('GITHUB_OWNER');
    github = createGitHub({ owner, token: appAuth(owner), api: env.GITHUB_API || undefined });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  await serveStdio({ name: 'aemtli-github', version, tools: githubTools(github) });
}

/**
 * `aemtli mcp-transport`: stations, connections and departure boards from
 * transport.opendata.ch as MCP tools on stdio. It needs no key; TRANSPORT_API
 * points it at another address of the same API. A gateway runs it; stdout is
 * the protocol, so nothing else may go there.
 */
async function mcpTransport() {
  await serveStdio({ name: 'aemtli-transport', version, tools: transportTools(createTransport({ baseUrl: env.TRANSPORT_API || undefined })) });
}

/**
 * `aemtli mcp-cluster`: what is wrong in the cluster and the handgrips that
 * put most of it right, as MCP tools on stdio, with the pod's own service
 * account. CLUSTER_PROBES lists public addresses to look at; the three
 * CLUSTER_*_NAMESPACES settings say where logs may be read, Deployments
 * restarted and ExternalSecrets resynced, and CronJobs run again. All are
 * comma-separated; a list left out allows nothing.
 */
async function mcpCluster() {
  const probes = (env.CLUSTER_PROBES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  await serveStdio({
    name: 'aemtli-cluster',
    version,
    tools: clusterTools(createCluster({
      api: createKubeApi(),
      probes,
      logNamespaces: namespaces(env.CLUSTER_LOG_NAMESPACES),
      healNamespaces: namespaces(env.CLUSTER_HEAL_NAMESPACES),
      rerunNamespaces: namespaces(env.CLUSTER_RERUN_NAMESPACES),
    })),
  });
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'run') await run(rest);
else if (command === 'job') await job(rest);
else if (command === 'web') await web();
else if (command === 'model-proxy') await modelProxy();
else if (command === 'mcp-gateway') await mcpGateway();
else if (command === 'mcp-kanban') await mcpKanban();
else if (command === 'mcp-recipes') await mcpRecipes();
else if (command === 'mcp-github') await mcpGitHub();
else if (command === 'mcp-transport') await mcpTransport();
else if (command === 'mcp-cluster') await mcpCluster();
else {
  console.log(USAGE);
  process.exit(command === '--help' || command === undefined ? 0 : 2);
}
