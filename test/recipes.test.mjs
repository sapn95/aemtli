import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRecipes, recipeTools, whyNotARecipe, checkSyntax, RECIPE_NAME } from '../src/mcp/recipes.mjs';
import { serveStdio } from '../src/mcp/stdio.mjs';

const GOOD = `// title: Termine
// description: Appointments from new mail
export default async function termine(ctx) { return 'nichts'; }
`;

/** GitHub behind a fetch: the folder it holds, and every call written down. */
function fakeGitHub({ files = { 'termine.mjs': GOOD }, pulls = [], fail = {} } = {}) {
  const seen = [];
  const branches = new Map([['main', 'sha-main']]);
  let number = 40;
  const fetchImpl = async (url, init) => {
    const { pathname, search } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ method: init.method, path: pathname + search, body, auth: init.headers.authorization });
    const answer = (status, value) => new Response(value === undefined ? '' : JSON.stringify(value), { status });
    if (fail[pathname]) return answer(fail[pathname].status, { message: fail[pathname].message });
    if (init.method === 'GET' && pathname === '/repos/o/r/contents/c/recipes') {
      return answer(200, Object.entries(files).map(([name, text]) => ({ type: 'file', name, size: Buffer.byteLength(text) })));
    }
    const file = /^\/repos\/o\/r\/contents\/c\/recipes\/(.+)$/.exec(pathname);
    if (file && init.method === 'GET') {
      const text = files[file[1]];
      if (text === undefined) return answer(404, { message: 'Not Found' });
      return answer(200, { type: 'file', sha: `sha-${file[1]}`, content: Buffer.from(text).toString('base64') });
    }
    if (file && init.method === 'PUT') {
      files[file[1]] = Buffer.from(body.content, 'base64').toString('utf8');
      return answer(200, { content: { path: pathname } });
    }
    if (init.method === 'GET' && pathname === '/repos/o/r/git/ref/heads/main') return answer(200, { object: { sha: branches.get('main') } });
    if (init.method === 'POST' && pathname === '/repos/o/r/git/refs') {
      const name = body.ref.replace('refs/heads/', '');
      if (branches.has(name)) return answer(422, { message: 'Reference already exists' });
      branches.set(name, body.sha);
      return answer(201, { ref: body.ref });
    }
    if (init.method === 'POST' && pathname === '/repos/o/r/pulls') {
      number += 1;
      pulls.push({ number, title: body.title, head: { ref: body.head }, html_url: `https://github.com/o/r/pull/${number}`, created_at: '2026-10-16T09:00:00Z' });
      return answer(201, pulls.at(-1));
    }
    if (init.method === 'GET' && pathname === '/repos/o/r/pulls') return answer(200, pulls);
    return answer(404, { message: `no route for ${init.method} ${pathname}` });
  };
  const recipes = createRecipes({ repo: 'o/r', path: '/c/recipes/', token: 'ghp-secret', fetchImpl, now: () => new Date('2026-10-16T09:00:00Z') });
  return { recipes, seen, files, branches, pulls };
}

test('what a recipe must carry before anything is proposed', () => {
  assert.equal(whyNotARecipe(GOOD), null);
  assert.match(whyNotARecipe(''), /empty/);
  assert.match(whyNotARecipe('// description: x\nexport default () => 1;\n'), /title/);
  assert.match(whyNotARecipe('// title: x\nexport default () => 1;\n'), /description/);
  assert.match(whyNotARecipe('// title: x\n// description: y\nexport const a = 1;\n'), /default export/);
  assert.match(whyNotARecipe(`// title: x\n// description: y\nexport default 1;\n// ${'a'.repeat(70_000)}`), /at most 65536 bytes/);
});

test('the syntax check parses the file and says where it breaks, without running it', async () => {
  assert.equal(await checkSyntax(GOOD), null);
  const broken = await checkSyntax('// title: x\nexport default function ( {\n');
  assert.match(broken, /SyntaxError/);
  assert.doesNotMatch(broken, /aemtli-check-/, 'the temp path is not in the message');
  // A file that would do harm when run is only parsed.
  assert.equal(await checkSyntax('process.exit(3);\n'), null);
});

test('a recipe name is lower case, and nothing that could leave the folder', () => {
  for (const ok of ['termine', 'epost-backup', 'a']) assert.ok(RECIPE_NAME.test(ok), ok);
  for (const no of ['../etc/passwd', 'Termine', 'epost backup', '-x', '', 'a'.repeat(42)]) assert.equal(RECIPE_NAME.test(no), false, no);
});

test('the settings are checked before anything is served', () => {
  assert.throws(() => createRecipes({ repo: 'nope', path: 'p', token: 't' }), /owner\/name/);
  assert.throws(() => createRecipes({ repo: 'o/r', path: '', token: 't' }), /RECIPES_REPO_PATH/);
  assert.throws(() => createRecipes({ repo: 'o/r', path: 'p' }), /a token is needed/);
});

test('listing and reading go to the branch the cluster follows, with the token', async () => {
  const gh = fakeGitHub({ files: { 'termine.mjs': GOOD, 'hello.yaml': 'title: Hello\n', 'README.md': 'x' } });
  assert.deepEqual(await gh.recipes.list(), [
    { name: 'hello', file: 'hello.yaml', bytes: 13, kind: 'goose recipe' },
    { name: 'termine', file: 'termine.mjs', bytes: Buffer.byteLength(GOOD), kind: 'job' },
  ]);
  const one = await gh.recipes.read('termine');
  assert.deepEqual(one, { name: 'termine', file: 'c/recipes/termine.mjs', sha: 'sha-termine.mjs', source: GOOD });
  assert.equal(gh.seen[0].path, '/repos/o/r/contents/c/recipes?ref=main');
  assert.equal(gh.seen.at(-1).auth, 'Bearer ghp-secret');
  await assert.rejects(gh.recipes.read('nothing'), err => err.status === 404 && /no recipe "nothing"/.test(err.message));
  await assert.rejects(gh.recipes.read('../../.github/workflows/ci'), err => err.status === 400 && /not a recipe name/.test(err.message));
});

test('a proposal is one branch, one file, one pull request, and no merge', async () => {
  const gh = fakeGitHub();
  const source = GOOD.replace("return 'nichts';", "return 'etwas';");
  const made = await gh.recipes.propose({ name: 'termine', source, why: '  Der Lauf hat nie etwas eingetragen.  ' });
  assert.deepEqual(made, {
    name: 'termine',
    branch: 'goose/termine-20261016T090000Z',
    number: 41,
    url: 'https://github.com/o/r/pull/41',
    changed: true,
  });
  const posts = gh.seen.filter(s => s.method !== 'GET');
  assert.deepEqual(posts.map(p => `${p.method} ${p.path}`), [
    'POST /repos/o/r/git/refs',
    'PUT /repos/o/r/contents/c/recipes/termine.mjs',
    'POST /repos/o/r/pulls',
  ], 'nothing else is touched, and nothing is merged');
  assert.equal(posts[0].body.ref, 'refs/heads/goose/termine-20261016T090000Z');
  assert.equal(posts[0].body.sha, 'sha-main', 'branched off the branch the cluster follows');
  assert.equal(posts[1].body.branch, 'goose/termine-20261016T090000Z');
  assert.equal(posts[1].body.sha, 'sha-termine.mjs', 'built on the file as it stands');
  assert.equal(Buffer.from(posts[1].body.content, 'base64').toString('utf8'), source);
  assert.match(posts[1].body.message, /^Change the termine recipe\n\nDer Lauf hat nie etwas eingetragen\.$/);
  assert.equal(posts[2].body.base, 'main');
  assert.match(posts[2].body.body, /Nothing of this runs until someone merges it/);
  assert.deepEqual(await gh.recipes.proposals(), [{ number: 41, title: 'Change the termine recipe', branch: 'goose/termine-20261016T090000Z', url: 'https://github.com/o/r/pull/41', opened: '2026-10-16T09:00:00Z' }]);
});

test('a new recipe is added without a sha; the pull request says "Add"', async () => {
  const gh = fakeGitHub();
  const made = await gh.recipes.propose({ name: 'neue-idee', source: GOOD, why: 'Etwas Neues.' });
  assert.equal(made.changed, false);
  const put = gh.seen.find(s => s.method === 'PUT');
  assert.equal(put.body.sha, undefined, 'a file that is not there has nothing to build on');
  assert.match(put.body.message, /^Add the neue-idee recipe/);
  assert.equal(gh.seen.find(s => s.path === '/repos/o/r/pulls' && s.method === 'POST').body.title, 'Add the neue-idee recipe');
});

test('what is refused before a branch is made: the name, the file, the reason, and the same text again', async () => {
  const gh = fakeGitHub();
  const nope = (args, re) => assert.rejects(gh.recipes.propose(args), err => re.test(err.message) && err.status >= 400);
  await nope({ name: '../../.github/workflows/ci', source: GOOD, why: 'x' }, /not a recipe name/);
  await nope({ name: 'termine', source: 'export default 1;\n', why: 'x' }, /not a recipe: .*title/);
  await nope({ name: 'termine', source: '// title: a\n// description: b\nexport default function ( {\n', why: 'x' }, /does not parse/);
  await nope({ name: 'termine', source: GOOD, why: '   ' }, /say why/);
  await nope({ name: 'termine', source: GOOD, why: 'nothing changed' }, /already reads exactly like this/);
  assert.deepEqual(gh.seen.filter(s => s.method !== 'GET'), [], 'no branch, no commit, no pull request');
  assert.deepEqual([...gh.branches.keys()], ['main']);
});

test('a branch without a pull request is taken back, and the reason that failed is the one told', async () => {
  const gh = fakeGitHub({ fail: { '/repos/o/r/pulls': { status: 422, message: 'No commits between main and goose/termine' } } });
  await assert.rejects(
    gh.recipes.propose({ name: 'termine', source: GOOD.replace('nichts', 'etwas'), why: 'besser' }),
    err => err.status === 422 && /No commits between/.test(err.message),
  );
  assert.ok(gh.seen.some(s => s.method === 'DELETE' && s.path === '/repos/o/r/git/refs/heads/goose%2Ftermine-20261016T090000Z'), 'the branch is taken back');
});

test('what GitHub refuses comes back in its own words, without the token', async () => {
  const gh = fakeGitHub({ fail: { '/repos/o/r/git/refs': { status: 403, message: 'Resource not accessible by personal access token' } } });
  await assert.rejects(
    gh.recipes.propose({ name: 'termine', source: GOOD.replace('nichts', 'etwas'), why: 'x' }),
    err => err.status === 403 && /GitHub answered 403: Resource not accessible/.test(err.message) && !err.message.includes('ghp-secret'),
  );
});

test('the tools: what they are called, what they take, and that none of them merges', async () => {
  const gh = fakeGitHub();
  const tools = recipeTools(gh.recipes);
  assert.deepEqual(tools.map(t => t.name), ['recipes_list', 'recipes_read', 'recipes_open_proposals', 'recipes_propose']);
  assert.ok(tools.every(t => t.inputSchema.additionalProperties === false && t.description && t.annotations));
  assert.deepEqual(tools.filter(t => t.annotations.readOnlyHint).map(t => t.name), ['recipes_list', 'recipes_read', 'recipes_open_proposals']);
  assert.doesNotMatch(tools.map(t => t.name).join(' '), /merge|delete|close/);
  const by = Object.fromEntries(tools.map(t => [t.name, t]));
  assert.equal((await by.recipes_list.run({})).recipes.length, 1);
  assert.equal((await by.recipes_read.run({ name: 'termine' })).source, GOOD);
  assert.equal((await by.recipes_propose.run({ name: 'termine', source: GOOD.replace('nichts', 'etwas'), why: 'besser' })).number, 41);
  assert.equal((await by.recipes_open_proposals.run({})).proposals.length, 1);
});

test('over stdio: a call that works, and a refusal the agent can read', async () => {
  const gh = fakeGitHub();
  const input = new PassThrough();
  const output = new PassThrough();
  const out = [];
  output.on('data', d => out.push(...d.toString().split('\n').filter(Boolean).map(l => JSON.parse(l))));
  const done = serveStdio({ name: 'recipes', version: '1', tools: recipeTools(gh.recipes), input, output, log: () => {} });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recipes_read', arguments: { name: 'termine' } } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recipes_propose', arguments: { name: 'termine', source: 'kaputt(', why: 'x' } } })}\n`);
  await new Promise(r => setTimeout(r, 50));
  input.end();
  await done;
  assert.equal(JSON.parse(out.find(m => m.id === 1).result.content[0].text).name, 'termine');
  const refused = out.find(m => m.id === 2).result;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /not a recipe: .*title/);
});
