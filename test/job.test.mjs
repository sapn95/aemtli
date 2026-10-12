import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJob } from '../src/run/job.mjs';
import { jobMeta } from '../src/run/meta.mjs';
import { startGateway } from '../src/gateway/server.mjs';
import { createMcpClient } from '../src/run/mcp-client.mjs';
import { pruneRuns, createRunDir, writeJsonAtomic, listRuns } from '../src/store/runs.mjs';
import { parseFeed, isRelease } from '../deploy/kubernetes/example/recipes/release-watch.mjs';

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

    // One session for calls made at once, and a new one when the gateway
    // dropped the old.
    const client = createMcpClient(`http://127.0.0.1:${servers[0].address().port}/mcp`);
    await Promise.all([client.call('read_thing', {}), client.call('read_thing', {}), client.tools()]);
    assert.equal(gateway.sessions.size, 1);
    for (const [id, s] of gateway.sessions) { gateway.sessions.delete(id); await s.child.close(); }
    assert.match((await client.call('read_thing', { again: true })).text, /call 1 /, 'a fresh session, a fresh server');
    await client.close();
    assert.equal(gateway.sessions.size, 0);
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
    // Taken off ctx, as a recipe might: it still finds its gateway.
    board: 'export default async ({ cards }) => cards().ensure("x", { title: "t" });\n',
  });
  const runs = await Promise.all(['boom', 'empty', 'lost', 'board'].map(name => runJob({ name, recipesDir, dataDir, anthropic: null })));
  assert.deepEqual(runs.map(r => [r.status, r.error]), [
    ['failed', 'the feed is gone'],
    ['failed', 'empty.mjs has no default export to run'],
    ['failed', 'no gateway "nowhere" in MCP_GATEWAYS'],
    ['failed', 'no gateway "kanban" in MCP_GATEWAYS'],
  ]);
  await assert.rejects(runJob({ name: '../x', recipesDir, dataDir }), /not a job name/);
  await assert.rejects(runJob({ name: 'missing', recipesDir, dataDir }), /no job file/);
});

test('an answer cut at its length limit says so', async () => {
  const { recipesDir, dataDir } = dirs({ cut: 'export default async ctx => ctx.ask({ prompt: "long", maxTokens: 5 });\n' });
  const anthropic = { messages: { create: async () => ({ content: [{ type: 'text', text: 'half a sen' }], stop_reason: 'max_tokens', usage: { input_tokens: 3, output_tokens: 5 } }) } };
  const run = await runJob({ name: 'cut', recipesDir, dataDir, anthropic });
  assert.equal(read(dataDir, 'cut', run.id, 'result.md'), 'half a sen\n\n*The answer was cut at its length limit.*\n');
  assert.match(read(dataDir, 'cut', run.id, 'run.log'), /cut at 2053 tokens/);
});

test('ask leaves room for thinking, keeps it short, and fails when only thinking came back', async () => {
  const seen = [];
  const { recipesDir, dataDir } = dirs({ think: 'export default async ctx => ctx.ask({ prompt: "x", maxTokens: 100 });\n' });
  const anthropic = { messages: { create: async req => {
    seen.push(req);
    return { content: [{ type: 'thinking', thinking: '', signature: 's' }], stop_reason: 'max_tokens', usage: { input_tokens: 3, output_tokens: 2148 } };
  } } };
  const run = await runJob({ name: 'think', recipesDir, dataDir, anthropic });
  assert.equal(seen[0].max_tokens, 2148);
  assert.deepEqual(seen[0].output_config, { effort: 'low' });
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'the model used its 2148 tokens before it answered');
  assert.equal(run.tokens.total, 2151, 'what it cost is still counted');
});

test('a state that cannot be read starts empty, and the log says so', async () => {
  const { recipesDir, dataDir } = dirs({ s: 'export default async ctx => JSON.stringify(ctx.state);\n' });
  mkdirSync(join(dataDir, 'runs', 's'), { recursive: true });
  writeFileSync(join(dataDir, 'runs', 's', 'state.json'), '{broken');
  const run = await runJob({ name: 's', recipesDir, dataDir, anthropic: null });
  assert.equal(read(dataDir, 's', run.id, 'result.md'), '{}\n');
  assert.match(read(dataDir, 's', run.id, 'run.log'), /could not be read and starts empty/);
});

test('a keep count that is not a positive whole number prunes nothing', () => {
  const { dataDir } = dirs({});
  for (const id of ['20261011T120000Z-0001', '20261011T120001Z-0002']) writeJsonAtomic(join(createRunDir(dataDir, 'x', id), 'run.json'), { id, recipe: 'x' });
  for (const keep of [NaN, 0, -1, 1.5, undefined]) assert.equal(pruneRuns(dataDir, 'x', keep), 0, String(keep));
  assert.equal(listRuns(dataDir, 'x').length, 2);
  assert.equal(pruneRuns(dataDir, 'x', 1), 1);
});

test('a job can push once through ntfy, and a run without the settings says so', async () => {
  const pushes = [];
  const ntfy = createServer((req, res) => {
    let text = '';
    req.on('data', c => { text += c; });
    req.on('end', () => { pushes.push({ path: req.url, headers: req.headers, text }); res.writeHead(pushes.length > 1 ? 503 : 200).end('{}'); });
  });
  await new Promise(r => ntfy.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${ntfy.address().port}/`;
  const { recipesDir, dataDir } = dirs({ push: `export default async function (ctx) {
  const first = await ctx.notify({ title: 'Heute: 3 Termine', message: 'Grüessech' });
  const second = await ctx.notify({ title: 'again', message: 'x' });
  return \`\${first} \${second}\`;
}
` });
  const tokenFile = join(dataDir, 'ntfy-token');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(tokenFile, 'tk_secret\n');
  try {
    const env = { NTFY_URL: url, NTFY_TOPIC: 'chores', NTFY_TOKEN_FILE: tokenFile, PUBLIC_ORIGIN: 'https://chores.example' };
    const run = await runJob({ name: 'push', recipesDir, dataDir, env, anthropic: null });
    assert.equal(read(dataDir, 'push', run.id, 'result.md'), 'true false\n', 'a refused push is false, not a failure');
    assert.equal(run.status, 'succeeded');
    assert.equal(pushes.length, 2);
    assert.equal(pushes[0].path, '/', 'published as JSON to the server, the topic inside');
    assert.equal(pushes[0].headers.authorization, 'Bearer tk_secret');
    assert.equal(pushes[0].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(pushes[0].text), { topic: 'chores', title: 'Heute: 3 Termine', message: 'Grüessech', tags: ['bell'], click: 'https://chores.example' });
    assert.match(read(dataDir, 'push', run.id, 'run.log'), /could not notify: ntfy answered 503/);

    const without = await runJob({ name: 'push', recipesDir, dataDir, anthropic: null });
    assert.equal(read(dataDir, 'push', without.id, 'result.md'), 'false false\n');
    assert.match(read(dataDir, 'push', without.id, 'run.log'), /NTFY_URL, NTFY_TOPIC and NTFY_TOKEN_FILE are not all set/);
  } finally {
    ntfy.close();
  }
});

test('a title keeps its umlauts and is cut to one line a phone can show', async () => {
  const seen = [];
  const ntfy = createServer((req, res) => { let t = ''; req.on('data', c => { t += c; }); req.on('end', () => { seen.push(JSON.parse(t).title); res.writeHead(200).end('{}'); }); });
  await new Promise(r => ntfy.listen(0, '127.0.0.1', r));
  const { recipesDir, dataDir } = dirs({ odd: "export default async ctx => ctx.notify({ title: 'Grüessech ✓ ' + 'x'.repeat(200), message: 'y' });\n" });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 't'), 'tk');
  try {
    await runJob({ name: 'odd', recipesDir, dataDir, anthropic: null, env: { NTFY_URL: `http://127.0.0.1:${ntfy.address().port}`, NTFY_TOPIC: 'c', NTFY_TOKEN_FILE: join(dataDir, 't') } });
    assert.equal(seen[0].length, 120);
    assert.match(seen[0], /^Grüessech ✓ x+$/);
  } finally {
    ntfy.close();
  }
});

/** A one-page PDF with the given lines of text, built by hand. */
function pdf(lines) {
  const text = lines.map((l, i) => `BT /F1 11 Tf 40 ${780 - i * 16} Td (${l.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('a job reads a PDF as text, with the layout kept', async () => {
  const { recipesDir, dataDir } = dirs({ pdf: 'export default async ctx => ctx.pdfText(Buffer.from(ctx.params.pdf, "base64"));\n' });
  const bytes = pdf(['Montag, 5. Oktober 2026', '09:30   11:00   Behandlung   Raum 2', 'Grüessech']);
  const run = await runJob({ name: 'pdf', recipesDir, dataDir, anthropic: null, params: { pdf: bytes.toString('base64') } });
  assert.equal(run.status, 'succeeded', run.error);
  const text = read(dataDir, 'pdf', run.id, 'result.md');
  assert.match(text, /Montag, 5\. Oktober 2026/);
  assert.match(text, /09:30\s+11:00\s+Behandlung\s+Raum 2/);
  assert.match(text, /Grüessech/, 'decoded as UTF-8');
  const bad = await runJob({ name: 'pdf', recipesDir, dataDir, anthropic: null, params: { pdf: Buffer.from('not a pdf').toString('base64') } });
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /^pdftotext: /);
});

test('a job file names itself in its first comment lines', () => {
  assert.deepEqual(jobMeta('// title: Release watch\n// description: What changed\nexport default 1;\n'), { title: 'Release watch', description: 'What changed' });
  assert.deepEqual(jobMeta('export default 1;\n// title: within twenty lines\n'), { title: 'within twenty lines', description: undefined });
  assert.equal(jobMeta(`${'\n'.repeat(20)}// title: too late\n`).title, undefined, 'only the head of the file');
  assert.deepEqual(jobMeta('export default 1;\n'), { title: undefined, description: undefined });
});

test('release feeds: the tag from the link, the notes decoded once, pre-releases told apart', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <title>Release notes from core</title>
  <entry xml:lang="en-US">
    <id>tag:github.com,2008:Repository/1/2026.10.1</id>
    <updated>2026-10-10T16:14:23Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v2.0%2Bk3s1"/>
    <title>The big one</title>
    <content type="html">&lt;ul&gt;&lt;li&gt;a &amp;lt;b&amp;gt; &amp;#x27;fix&amp;#8217; &lt;a href=&quot;https://x.example&quot;&gt;#1&lt;/a&gt;&lt;/li&gt;&lt;/ul&gt;</content>
  </entry>
  <entry><updated>soon</updated><title><![CDATA[v1.0 & more]]></title><content type="html"><![CDATA[<p>cdata notes</p>]]></content></entry>
</feed>`;
  assert.deepEqual(parseFeed(xml), [
    { tag: 'v2.0+k3s1', updated: '2026-10-10T16:14:23Z', notes: "a <b> 'fix’ #1" },
    { tag: 'v1.0 & more', updated: 'soon', notes: 'cdata notes' },
  ]);
  assert.deepEqual(parseFeed('<feed></feed>'), []);
  // Tags as they appear in the five feeds the example reads, and a few more.
  const skip = ['v3.6.0-rc2', 'gitops-engine/v3.6.0-rc2', 'v1.37.1-rc2+k3s1', 'gdk-v0.1.0-alpha.11', 'v2.0.0-beta.1', '2026.10.0b2', 'v1.2.0-b1',
    'v4.0.0-preview', '1.0-dev', 'v2.5.0-rc.1', '2026.10.0.rc1', 'v1.0.0-alpha', 'v9-nightly', 'stable', 'latest'];
  const report = ['v1.36.5+k3s1', 'v1.37.1+k3s1', '2026.10.1', 'v3.5.4', '2026.10.0', 'gitops-engine/v1.0.0', 'v1.54.0', 'release-2026.1'];
  for (const t of skip) assert.ok(!isRelease(t), `${t} is skipped`);
  for (const t of report) assert.ok(isRelease(t), `${t} is reported`);
});

/** An Atom feed with the given entries. */
const feed = entries => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.map(([tag, updated, notes]) => `<entry><updated>${updated}</updated><link rel="alternate" type="text/html" href="https://github.com/x/y/releases/tag/${tag}"/><title>Release ${tag}</title><content type="html">${notes}</content></entry>`).join('')}</feed>`;

test('release-watch: code reads and filters the feeds, the model only sums up what is new', async () => {
  const { recipesDir, dataDir } = dirs({});
  copyFileSync(EXAMPLE_JOB, join(recipesDir, 'release-watch.mjs'));
  const feeds = {
    'a/one': feed([
      ['v2.0.0', '2026-10-10T10:00:00Z', '&lt;p&gt;Breaking: config &amp;amp; flags renamed&lt;/p&gt;'],
      ['v2.1.0-rc1', '2026-10-10T11:00:00Z', 'a release candidate'],
      ['v1.9.1', '2026-09-30T10:00:00Z', 'within two weeks'],
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
  assert.match(asked, /a\/one v1\.9\.1 \(2026-09-30\)/, 'two weeks back: a missed run loses nothing');
  assert.doesNotMatch(asked, /rc1|2026\.10\.0b2|v1\.9\.0 /, 'no pre-releases, nothing older than two weeks');
  assert.doesNotMatch(asked, /Release v2/, 'tags, not release names');
  assert.equal(prompts[0].model, 'claude-haiku-5-5');
  assert.deepEqual(first.tokens, { input: 300, output: 40, total: 340 });
  const result = read(dataDir, 'release-watch', first.id, 'result.md');
  assert.match(result, /^- \*\*a\/one v2\.0\.0\*\*/);
  assert.match(result, /\*\*Not read:\*\*\n- c\/gone: the feed answered 404/);
  const dead = await runJob({ name: 'release-watch', recipesDir, dataDir, params: { repos: 'd/dead' }, anthropic, fetchImpl: async () => { throw new Error('connect ETIMEDOUT'); }, now });
  assert.equal(dead.status, 'succeeded', 'one feed that cannot be reached is a line in the report, not a failed run');
  assert.match(read(dataDir, 'release-watch', dead.id, 'result.md'), /- d\/dead: connect ETIMEDOUT/);

  // The same feeds again: nothing new, so no model call and no tokens.
  const second = await runJob({ name: 'release-watch', recipesDir, dataDir, params, anthropic, fetchImpl, now });
  assert.equal(prompts.length, 1);
  assert.equal(second.tokens.total, 0);
  assert.match(read(dataDir, 'release-watch', second.id, 'result.md'), /^Nothing new since the last report\./);
});
