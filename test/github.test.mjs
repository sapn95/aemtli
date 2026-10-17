import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createGitHub, githubTools, judgeChecks, checkRepo, TAG } from '../src/mcp/github.mjs';
import { serveStdio } from '../src/mcp/stdio.mjs';

const HEAD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const OLD = 'c'.repeat(40);
const OK = [{ name: 'check (24)', status: 'completed', conclusion: 'success' }, { name: 'auto-merge', status: 'completed', conclusion: 'skipped' }];

/** One repository on GitHub behind a fetch, with every call written down. */
function fakeGitHub({
  pr = {},
  files = [{ filename: 'src/a.mjs' }],
  runs = { [HEAD]: OK, [MAIN]: OK },
  statuses = {},
  totals = {},
  repo = {},
  tags = [],
  pkg = { [MAIN]: { version: '1.4.0' } },
  compare = { [MAIN]: 'identical', [OLD]: 'behind', [HEAD]: 'ahead' },
  repos = [{ name: 'zyt', private: true, archived: false, default_branch: 'main', pushed_at: 'p', html_url: 'https://github.com/sapn95/zyt' }, { name: 'aemtli', private: false, archived: false, default_branch: 'main', pushed_at: 'p', html_url: 'https://github.com/sapn95/aemtli' }],
  open = [],
  search = [],
  fail = {},
} = {}) {
  const seen = [];
  const created = [];
  const pull = { number: 5, title: 'Make it better', user: { login: 'sapn95' }, state: 'open', merged: false, draft: false, html_url: 'https://github.com/sapn95/aemtli/pull/5', base: { ref: 'main', repo: { default_branch: 'main', full_name: 'sapn95/aemtli' } }, head: { ref: 'feature', sha: HEAD, repo: { full_name: 'sapn95/aemtli' } }, mergeable: true, mergeable_state: 'clean', ...pr };
  const info = { default_branch: 'main', archived: false, html_url: 'https://github.com/sapn95/aemtli', ...repo };
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ method: init.method, path: pathname, query: Object.fromEntries(searchParams), body, auth: init.headers.authorization });
    const answer = (status, value) => new Response(value === undefined ? '' : JSON.stringify(value), { status });
    const page = (items, wrap) => {
      const n = Number(searchParams.get('page') ?? 1);
      const size = Number(searchParams.get('per_page') ?? 30);
      const slice = items.slice((n - 1) * size, n * size);
      return answer(200, wrap ? { [wrap]: slice } : slice);
    };
    if (fail[pathname]) return answer(fail[pathname], { message: 'Nope' });
    const r = '/repos/sapn95/aemtli';
    if (pathname === '/installation/repositories') return page(repos, 'repositories');
    if (pathname === '/search/issues') return page(search, 'items');
    if (pathname === `${r}/pulls`) return page(open);
    if (pathname === `${r}/pulls/5`) return answer(200, pull);
    if (pathname === `${r}/pulls/5/files`) return page(files);
    if (pathname === `${r}/pulls/5/merge`) return answer(200, { merged: true, sha: 'd'.repeat(40), message: 'Pull Request successfully merged' });
    const commit = /^\/repos\/sapn95\/aemtli\/commits\/(\w+)\/(check-runs|status)$/.exec(pathname);
    if (commit && commit[2] === 'check-runs') return page(runs[commit[1]] ?? [], 'check_runs');
    if (commit) return answer(200, { total_count: totals[commit[1]] ?? (statuses[commit[1]] ?? []).length, statuses: statuses[commit[1]] ?? [] });
    if (pathname === r) return answer(200, info);
    if (pathname.startsWith(`${r}/git/ref/tags/`)) return tags.includes(decodeURIComponent(pathname.split('/').pop())) ? answer(200, { ref: 'x' }) : answer(404, { message: 'Not Found' });
    const cmp = /^\/repos\/sapn95\/aemtli\/compare\/main\.\.\.(\w+)$/.exec(pathname);
    if (cmp) return answer(200, { status: compare[cmp[1]] ?? 'diverged' });
    if (pathname === `${r}/contents/package.json`) {
      const got = pkg[searchParams.get('ref')];
      if (got === undefined) return answer(404, { message: 'Not Found' });
      if (got === null) return answer(200, { content: '', encoding: 'none' });
      return answer(200, { encoding: 'base64', content: Buffer.from(typeof got === 'string' ? got : JSON.stringify(got)).toString('base64') });
    }
    if (pathname === `${r}/git/tags` && init.method === 'POST') {
      created.push(body);
      return answer(201, { sha: 'e'.repeat(40) });
    }
    if (pathname === `${r}/git/refs` && init.method === 'POST') {
      created.push(body);
      return answer(201, { ref: body.ref });
    }
    if (pathname === `${r}/releases`) return answer(200, [{ tag_name: 'v1.3.0', name: 'v1.3.0', draft: false, prerelease: false, published_at: 'p', html_url: 'u' }]);
    if (pathname === `${r}/tags`) return answer(200, [{ name: 'v1.3.0', commit: { sha: OLD } }]);
    return answer(404, { message: `no route for ${init.method} ${pathname}` });
  };
  let n = 0;
  const github = createGitHub({ owner: 'sapn95', token: async () => `ghs_${++n}`, fetchImpl });
  return { github, seen, created, writes: () => seen.filter(s => s.method !== 'GET') };
}

test('a repository name, and nothing that could leave the owner', () => {
  for (const ok of ['aemtli', '.github', 'homebrew-tap', 'a_b.c']) assert.equal(checkRepo(ok), ok);
  for (const no of ['..', '.', 'o/r', '', 'a b', undefined, 'x'.repeat(101)]) assert.throws(() => checkRepo(no), err => err.status === 400, String(no));
});

test('a release tag is v and SemVer, as the release workflows match it', () => {
  for (const ok of ['v1.2.3', 'v0.18.0', 'v1.39.0-rc.SIG-5463.3']) assert.ok(TAG.test(ok), ok);
  for (const no of ['1.2.3', 'v1.2', 'v1.2.3 ', 'latest', 'v1.2.3/../x']) assert.equal(TAG.test(no), false, no);
});

test('what the checks say: check runs and statuses both count, and nothing reported is not green', () => {
  assert.deepEqual(judgeChecks(OK, [{ context: 'sonar', state: 'success' }]), { state: 'green', ran: 3, red: [], pending: [] });
  assert.equal(judgeChecks([], []).state, 'none');
  assert.deepEqual(judgeChecks([{ name: 'ci', status: 'completed', conclusion: 'skipped' }], []), { state: 'none', ran: 1, red: [], pending: [] }, 'skipped alone tested nothing');
  assert.deepEqual(judgeChecks([{ name: 'ci', status: 'in_progress' }], [{ context: 'cr', state: 'pending' }]).pending, ['ci', 'cr']);
  const red = judgeChecks([{ name: 'ci', status: 'completed', conclusion: 'failure' }, { name: 'x', status: 'queued' }], [{ context: 'cr', state: 'error' }]);
  assert.equal(red.state, 'red', 'a failure outweighs one still running');
  assert.deepEqual(red.red, ['ci (failure)', 'cr (error)']);
});

test('the settings are checked before anything is served', () => {
  assert.throws(() => createGitHub({ owner: 'a/b', token: async () => 't' }), /GITHUB_OWNER/);
  assert.throws(() => createGitHub({ owner: 'sapn95', token: 't' }), /token source/);
});

test('the repositories, sorted, read page by page with a fresh token each call', async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ name: `r${String(i).padStart(3, '0')}`, private: false, archived: false, default_branch: 'main', pushed_at: 'p', html_url: 'u' }));
  const gh = fakeGitHub({ repos: many });
  const got = await gh.github.repos();
  assert.equal(got.repositories.length, 150);
  assert.equal(got.complete, true);
  assert.equal(got.repositories[0].name, 'r000');
  assert.deepEqual(gh.seen.map(s => s.query.page), ['1', '2']);
  assert.deepEqual(gh.seen.map(s => s.auth), ['Bearer ghs_1', 'Bearer ghs_2']);
  assert.deepEqual((await fakeGitHub().github.repos()).repositories.map(r => r.name), ['aemtli', 'zyt']);
});

test('open pull requests: in one repository, or across the owner by search', async () => {
  const one = fakeGitHub({ open: [{ number: 5, title: 't', user: { login: 'dependabot[bot]' }, draft: false, created_at: 'c', html_url: 'u' }] });
  assert.deepEqual((await one.github.pulls({ repo: 'aemtli' })).pulls, [{ repo: 'aemtli', number: 5, title: 't', author: 'dependabot[bot]', draft: false, opened: 'c', url: 'u' }]);
  assert.equal(one.seen[0].query.state, 'open');

  const all = fakeGitHub({ search: [{ number: 9, title: 's', user: { login: 'sapn95' }, draft: true, created_at: 'c', html_url: 'u', repository_url: 'https://api.github.com/repos/sapn95/byge' }] });
  const got = await all.github.pulls();
  assert.deepEqual(got.pulls, [{ repo: 'byge', number: 9, title: 's', author: 'sapn95', draft: true, opened: 'c', url: 'u' }]);
  assert.equal(all.seen[0].query.q, 'is:pr is:open user:sapn95');
  await assert.rejects(all.github.pulls({ repo: '../x' }), err => err.status === 400);
});

test('one pull request: its head, its files, a renamed workflow, a fork, and its checks', async () => {
  const gh = fakeGitHub({ files: [{ filename: 'docs/ci.md', previous_filename: '.github/workflows/ci.yml' }], pr: { head: { ref: 'f', sha: HEAD, repo: { full_name: 'someone/aemtli' } } } });
  const pr = await gh.github.pull({ repo: 'aemtli', number: 5 });
  assert.equal(pr.sha, HEAD);
  assert.equal(pr.touchesCi, true, 'moving a workflow away changes it too');
  assert.equal(pr.fork, true);
  assert.equal(pr.checks.state, 'green');
  assert.equal(pr.checks.complete, true);
  const gone = fakeGitHub({ pr: { head: { ref: 'f', sha: HEAD, repo: null } } });
  assert.equal((await gone.github.pull({ repo: 'aemtli', number: 5 })).fork, true, 'a deleted fork is still a fork');
  assert.deepEqual(pr.files, ['docs/ci.md']);
  await assert.rejects(gh.github.pull({ repo: 'aemtli', number: '5' }), err => err.status === 400 && /not a pull request number/.test(err.message));
});

test('a merge names the head it was approved for, and goes in by rebase', async () => {
  const gh = fakeGitHub();
  const done = await gh.github.merge({ repo: 'aemtli', number: 5, sha: HEAD });
  assert.deepEqual(done, { repo: 'aemtli', number: 5, merged: true, sha: 'd'.repeat(40), message: 'Pull Request successfully merged', url: 'https://github.com/sapn95/aemtli/pull/5' });
  assert.deepEqual(gh.writes().map(w => [w.method, w.path, w.body]), [['PUT', '/repos/sapn95/aemtli/pulls/5/merge', { sha: HEAD, merge_method: 'rebase' }]]);
  const squash = fakeGitHub();
  await squash.github.merge({ repo: 'aemtli', number: 5, sha: HEAD, method: 'squash' });
  assert.equal(squash.writes()[0].body.merge_method, 'squash');
});

test('what stops a merge before GitHub is asked to merge', async () => {
  const refused = async (setup, args, pattern) => {
    const gh = fakeGitHub(setup);
    await assert.rejects(gh.github.merge({ repo: 'aemtli', number: 5, sha: HEAD, ...args }), err => pattern.test(err.message), String(pattern));
    assert.deepEqual(gh.writes(), [], `nothing written: ${pattern}`);
  };
  await refused({}, { sha: 'abc' }, /not a full commit sha/);
  await refused({}, { method: 'merge' }, /rebase or squash/);
  await refused({ pr: { head: { ref: 'f', sha: OLD } } }, {}, /moved: its head is c+ now/);
  await refused({ pr: { draft: true } }, {}, /is a draft/);
  await refused({ pr: { state: 'closed', merged: true } }, {}, /#5 is merged/);
  await refused({ pr: { state: 'closed' } }, {}, /#5 is closed/);
  await refused({ pr: { base: { ref: 'homelab', repo: { default_branch: 'main' } } } }, {}, /goes into homelab, not into main/);
  await refused({ pr: { head: { ref: 'f', sha: HEAD, repo: { full_name: 'someone/aemtli' } } } }, {}, /comes from a fork/);
  for (const filename of ['.github/workflows/release.yml', '.github/actions/setup/action.yml', '.github/dependabot.yml']) {
    await refused({ files: [{ filename }] }, {}, /changes \.github\/, where CI and its actions live/);
  }
  await refused({ pr: { mergeable_state: 'behind' } }, {}, /not clean to merge \(GitHub says behind\)/);
  await refused({ pr: { mergeable: null, mergeable_state: 'unknown' } }, {}, /GitHub says unknown/);
  await refused({ pr: { mergeable: false, mergeable_state: 'dirty' } }, {}, /GitHub says dirty/);
  await refused({ runs: { [HEAD]: [{ name: 'ci', status: 'completed', conclusion: 'skipped' }] } }, {}, /no check on a+ passed: every one was skipped/);
  await refused({ runs: { [HEAD]: Array.from({ length: 500 }, (_, i) => ({ name: `c${i}`, status: 'completed', conclusion: 'success' })) } }, {}, /more checks reported on a+ than can be read/);
  await refused({ statuses: { [HEAD]: [{ context: 'a', state: 'success' }] }, totals: { [HEAD]: 140 } }, {}, /more checks reported/);
  await refused({ files: Array.from({ length: 501 }, (_, i) => ({ filename: `f${i}` })) }, {}, /more files than can be read/);
  await refused({ runs: { [HEAD]: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] } }, {}, /checks on a+ failed: ci \(failure\)/);
  await refused({ runs: { [HEAD]: [{ name: 'ci', status: 'in_progress' }] } }, {}, /still running: ci/);
  await refused({ runs: {} }, {}, /no check has reported/);
  await refused({ statuses: { [HEAD]: [{ context: 'CodeRabbit', state: 'failure' }] } }, {}, /CodeRabbit \(failure\)/);
});

test('a release is an annotated tag on what main holds, matching package.json', async () => {
  const gh = fakeGitHub();
  const done = await gh.github.release({ repo: 'aemtli', tag: 'v1.4.0', sha: MAIN });
  assert.deepEqual(done, { repo: 'aemtli', tag: 'v1.4.0', sha: MAIN, url: 'https://github.com/sapn95/aemtli/releases/tag/v1.4.0', workflows: 'https://github.com/sapn95/aemtli/actions' });
  assert.deepEqual(gh.created, [
    { tag: 'v1.4.0', message: '1.4.0', object: MAIN, type: 'commit' },
    { ref: 'refs/tags/v1.4.0', sha: 'e'.repeat(40) },
  ]);
  assert.deepEqual(gh.writes().map(w => `${w.method} ${w.path}`), ['POST /repos/sapn95/aemtli/git/tags', 'POST /repos/sapn95/aemtli/git/refs']);

  const older = fakeGitHub({ pkg: {}, runs: { [OLD]: OK } });
  await older.github.release({ repo: 'aemtli', tag: 'v1.3.1', sha: OLD });
  assert.equal(older.created.length, 2, 'an older commit on main, and no package.json to agree with');
});

test('what stops a release before a tag is made', async () => {
  const refused = async (setup, args, pattern) => {
    const gh = fakeGitHub(setup);
    await assert.rejects(gh.github.release({ repo: 'aemtli', tag: 'v1.4.0', sha: MAIN, ...args }), err => pattern.test(err.message), String(pattern));
    assert.deepEqual(gh.writes(), [], `nothing written: ${pattern}`);
  };
  await refused({}, { tag: '1.4.0' }, /not a release tag/);
  await refused({}, { sha: 'main' }, /not a full commit sha/);
  await refused({ repo: { archived: true } }, {}, /archived/);
  await refused({ tags: ['v1.4.0'] }, {}, /already has v1\.4\.0/);
  await refused({ pkg: { [HEAD]: { version: '1.4.0' } } }, { sha: HEAD }, /is not on main/);
  await refused({}, { tag: 'v1.5.0' }, /says 1\.4\.0, not 1\.5\.0/);
  await refused({ pkg: { [MAIN]: '{ not json' } }, {}, /does not parse/);
  await refused({ pkg: { [MAIN]: null } }, {}, /package\.json at b+ cannot be read here/);
  await refused({ runs: { [MAIN]: [{ name: 'ci', status: 'completed', conclusion: 'cancelled' }] } }, {}, /ci \(cancelled\)/);
  await refused({ fail: { '/repos/sapn95/aemtli/contents/package.json': 500 } }, {}, /GitHub answered 500: Nope/);
});

test('releases and tags of one repository', async () => {
  const got = await fakeGitHub().github.releases({ repo: 'aemtli' });
  assert.deepEqual(got, { repo: 'aemtli', releases: [{ tag: 'v1.3.0', name: 'v1.3.0', draft: false, prerelease: false, published: 'p', url: 'u' }], tags: [{ tag: 'v1.3.0', sha: OLD }] });
});

test('the tools: reading is marked read-only, and only merge and release write', async () => {
  const gh = fakeGitHub();
  const tools = githubTools(gh.github);
  assert.deepEqual(tools.map(t => t.name), ['github_repos', 'github_pull_requests', 'github_pull_request', 'github_releases', 'github_merge', 'github_release']);
  assert.ok(tools.every(t => t.inputSchema.additionalProperties === false && t.description && t.annotations));
  assert.deepEqual(tools.filter(t => !t.annotations.readOnlyHint).map(t => t.name), ['github_merge', 'github_release']);
  assert.doesNotMatch(tools.map(t => t.name).join(' '), /delete|close|push|admin/);
  const by = Object.fromEntries(tools.map(t => [t.name, t]));
  assert.equal((await by.github_repos.run({})).repositories.length, 2);
  assert.equal((await by.github_pull_requests.run({ repo: 'aemtli' })).pulls.length, 0);
  assert.equal((await by.github_pull_request.run({ repo: 'aemtli', number: 5 })).sha, HEAD);
  assert.equal((await by.github_releases.run({ repo: 'aemtli' })).tags.length, 1);
  assert.equal((await by.github_merge.run({ repo: 'aemtli', number: 5, sha: HEAD })).merged, true);
  assert.equal((await by.github_release.run({ repo: 'aemtli', tag: 'v1.4.0', sha: MAIN })).tag, 'v1.4.0');
});

test('over stdio: a refusal the agent can read', async () => {
  const gh = fakeGitHub({ pr: { head: { ref: 'f', sha: OLD } } });
  const input = new PassThrough();
  const output = new PassThrough();
  const out = [];
  output.on('data', d => out.push(...d.toString().split('\n').filter(Boolean).map(l => JSON.parse(l))));
  const done = serveStdio({ name: 'github', version: '1', tools: githubTools(gh.github), input, output, log: () => {} });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'github_merge', arguments: { repo: 'aemtli', number: 5, sha: HEAD } } })}\n`);
  await new Promise(r => setTimeout(r, 50));
  input.end();
  await done;
  const refused = out.find(m => m.id === 1).result;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /moved/);
});
