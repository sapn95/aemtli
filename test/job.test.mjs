import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJob } from '../src/run/job.mjs';
import { jobMeta } from '../src/run/meta.mjs';
import { startGateway } from '../src/gateway/server.mjs';

const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const EXAMPLE_JOB = fileURLToPath(new URL('../deploy/kubernetes/example/recipes/release-watch.mjs', import.meta.url));

/** A temp recipes dir with the given job files, and a data dir. */
function dirs(jobs) {
  const root = mkdtempSync(join(tmpdir(), 'aemtli-job-'));
  const recipesDir = join(root, 'recipes');
  mkdirSync(recipesDir);
  for (const [name, source] of Object.entries(jobs)) writeFileSync(join(recipesDir, `${name}.mjs`), source);
  return { recipesDir, dataDir: join(root, 'data') };
}

const read = (dataDir, name, id, file) => readFileSync(join(dataDir, 'runs', name, id, file), 'utf8');

/** The fake model as a real HTTP server, reached through the real SDK. */
async function withFakeModel(body) {
  const child = spawn(process.execPath, [fixture('fake-llm.mjs')], { env: { ...process.env, FAKE_LLM_PORT: '0', FAKE_LLM_REPLY: 'Kurz gesagt: alles gut.', FAKE_LLM_REQUIRE_KEY: '' } });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { const m = String(d).match(/listening on (\d+)/); if (m) resolve(Number(m[1])); });
    child.on('error', reject);
  });
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
  }
}

test('a job asks the model through the SDK, keeps state, and is recorded like a run', () =>
  withFakeModel(async host => {
    const { recipesDir, dataDir } = dirs({ digest: `// title: Digest
// description: Says something short
export default async function (ctx) {
  ctx.state.runs = (ctx.state.runs ?? 0) + 1;
  ctx.saveState();
  const said = await ctx.ask({ prompt: 'Sag etwas.' });
  ctx.log('asked once');
  return \`## Run \${ctx.state.runs}\\n\\n\${said} \${ctx.params.who ?? ''}\`;
}
` });
    const env = { ANTHROPIC_HOST: host, ANTHROPIC_API_KEY: 'placeholder' };
    const first = await runJob({ name: 'digest', recipesDir, dataDir, env, trigger: 'schedule', params: { who: 'Sebi' } });
    assert.equal(first.status, 'succeeded');
    assert.equal(first.kind, 'job');
    assert.equal(first.trigger, 'schedule');
    assert.equal(first.model, 'claude-haiku-5-5');
    assert.deepEqual(first.tokens, { input: 10, output: 5, total: 15 });
    assert.equal(read(dataDir, 'digest', first.id, 'result.md'), '## Run 1\n\nKurz gesagt: alles gut. Sebi\n');
    assert.match(read(dataDir, 'digest', first.id, 'run.log'), /asked claude-haiku-5-5: 10 in, 5 out\n.*asked once/);
    const second = await runJob({ name: 'digest', recipesDir, dataDir, env });
    assert.match(read(dataDir, 'digest', second.id, 'result.md'), /^## Run 2/, 'the state came back');
  }));

test('a job calls a gateway like an agent does, approvals included', async () => {
  const gw = mkdtempSync(join(tmpdir(), 'aemtli-jobgw-'));
  writeFileSync(join(gw, 'policy.yaml'), 'allow: [read_*]\napprove: [send_*]\n');
  writeFileSync(join(gw, 'token'), 'gateway-token-for-the-tests-0123456789');
  const { gateway, servers } = await startGateway({
    MCP_COMMAND: JSON.stringify([process.execPath, fixture('fake-mcp.mjs')]), POLICY_FILE: join(gw, 'policy.yaml'),
    ADMIN_TOKEN_FILE: join(gw, 'token'), STATE_DIR: join(gw, 'state'), PORT: '0', ADMIN_PORT: '0', HOST: '127.0.0.1', PATH: process.env.PATH,
  }, { log: () => {} });
  try {
    const { recipesDir, dataDir } = dirs({ post: `export default async function (ctx) {
  const box = ctx.mcp('fake');
  const tools = (await box.tools()).map(t => t.name).join(',');
  const read = await box.call('read_thing', { id: '1' });
  const send = await box.call('send_thing', { to: 'x' });
  return [tools, read.text, send.text].join('\\n');
}
` });
    const run = await runJob({ name: 'post', recipesDir, dataDir, gateways: { fake: `http://127.0.0.1:${servers[0].address().port}/mcp` }, anthropic: null });
    assert.equal(run.status, 'succeeded', run.error);
    const [tools, readText, sendText] = read(dataDir, 'post', run.id, 'result.md').trim().split('\n');
    assert.equal(tools, 'read_thing,send_thing,secret_thing');
    assert.match(readText, /^read_thing \{"id":"1"\} call 1/);
    assert.match(sendText, /^Not done yet: send_thing needs the owner's approval/);
    assert.equal(run.tokens.total, 0, 'no model, no tokens');
    assert.equal(gateway.sessions.size, 0, 'the session was closed');
  } finally {
    await gateway.close();
    for (const s of servers) s.close();
  }
});

test('a job that throws, has no default export, or names an unknown gateway has failed, with the reason', async () => {
  const { recipesDir, dataDir } = dirs({
    boom: 'export default async () => { throw new Error("the feed is gone"); }\n',
    empty: 'export const x = 1;\n',
    lost: 'export default async ctx => ctx.mcp("nowhere");\n',
  });
  const runs = await Promise.all(['boom', 'empty', 'lost'].map(name => runJob({ name, recipesDir, dataDir, anthropic: null })));
  assert.deepEqual(runs.map(r => [r.status, r.error]), [
    ['failed', 'the feed is gone'],
    ['failed', 'empty.mjs has no default export to run'],
    ['failed', 'no gateway "nowhere" in MCP_GATEWAYS'],
  ]);
  await assert.rejects(runJob({ name: '../x', recipesDir, dataDir }), /not a job name/);
  await assert.rejects(runJob({ name: 'missing', recipesDir, dataDir }), /no job file/);
});

test('a job file names itself in its first comment lines', () => {
  assert.deepEqual(jobMeta('// title: Release watch\n// description: What changed\nexport default 1;\n'), { title: 'Release watch', description: 'What changed' });
  assert.deepEqual(jobMeta('export default 1;\n// title: too late, but within twenty lines\n'), { title: 'too late, but within twenty lines', description: undefined });
  assert.deepEqual(jobMeta('export default 1;\n'), { title: undefined, description: undefined });
});

/** An Atom feed with the given entries. */
const feed = entries => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.map(([tag, updated, notes]) => `<entry><title>${tag}</title><updated>${updated}</updated><content type="html">${notes}</content></entry>`).join('')}</feed>`;

test('release-watch: code reads and filters the feeds, the model only sums up what is new', async () => {
  const { recipesDir, dataDir } = dirs({});
  copyFileSync(EXAMPLE_JOB, join(recipesDir, 'release-watch.mjs'));
  const feeds = {
    'a/one': feed([
      ['v2.0.0', '2026-10-10T10:00:00Z', '&lt;p&gt;Breaking: config &amp;amp; flags renamed&lt;/p&gt;'],
      ['v2.1.0-rc1', '2026-10-10T11:00:00Z', 'a release candidate'],
      ['v1.9.0', '2026-09-01T10:00:00Z', 'too old'],
    ]),
    'b/two': feed([['2026.10.0b2', '2026-10-09T10:00:00Z', 'beta'], ['2026.10.0', '2026-10-08T10:00:00Z', 'Fixes']]),
  };
  const fetched = [];
  const fetchImpl = async url => {
    fetched.push(url);
    const repo = url.match(/github\.com\/(.+)\/releases\.atom/)[1];
    return feeds[repo] ? new Response(feeds[repo]) : new Response('no', { status: 404 });
  };
  const prompts = [];
  const anthropic = { messages: { create: async req => {
    prompts.push(req);
    return { content: [{ type: 'text', text: '- **a/one v2.0.0** (2026-10-10): flags renamed' }], usage: { input_tokens: 300, output_tokens: 40 } };
  } } };
  const now = () => new Date('2026-10-11T12:00:00Z');
  const params = { repos: 'a/one, b/two, c/gone' };

  const first = await runJob({ name: 'release-watch', recipesDir, dataDir, params, anthropic, fetchImpl, now });
  assert.equal(first.status, 'succeeded', first.error);
  assert.deepEqual(fetched, ['https://github.com/a/one/releases.atom', 'https://github.com/b/two/releases.atom', 'https://github.com/c/gone/releases.atom']);
  assert.equal(prompts.length, 1, 'one model call for all new releases');
  const asked = prompts[0].messages[0].content;
  assert.match(asked, /a\/one v2\.0\.0 \(2026-10-10\):\nBreaking: config & flags renamed\n/, 'entities decoded, tags gone');
  assert.match(asked, /b\/two 2026\.10\.0 \(2026-10-08\):\nFixes/);
  assert.doesNotMatch(asked, /rc1|2026\.10\.0b2|v1\.9\.0/, 'no pre-releases, nothing older than a week');
  assert.equal(prompts[0].model, 'claude-haiku-5-5');
  assert.deepEqual(first.tokens, { input: 300, output: 40, total: 340 });
  const result = read(dataDir, 'release-watch', first.id, 'result.md');
  assert.match(result, /^- \*\*a\/one v2\.0\.0\*\*/);
  assert.match(result, /\*\*Not read:\*\*\n- c\/gone: the feed answered 404/);

  // The same feeds again: nothing new, so no model call and no tokens.
  const second = await runJob({ name: 'release-watch', recipesDir, dataDir, params, anthropic, fetchImpl, now });
  assert.equal(prompts.length, 1);
  assert.equal(second.tokens.total, 0);
  assert.match(read(dataDir, 'release-watch', second.id, 'result.md'), /^Nothing new since the last report\./);
});
