// The owner's repositories, for goose and the jobs: what is open, whether
// its checks are green, merging a pull request, and tagging a release.
//
// The token is the GitHub App's (github-app.mjs): write access, no
// Administration and no Workflows permission. The gateway in front decides
// what runs freely; the cluster's policy holds every merge and every release
// for a click. What is checked here holds whatever the policy says, because
// goose reads letters and web pages and its arguments are never trusted on
// their word:
//
// - A merge names the head commit the owner saw. If the branch moved since,
//   nothing is merged: an approval is for that commit, not for the branch.
//   A rebase or squash still lands new commits on top of the default
//   branch, so GitHub has to call the pull request clean (not behind, no
//   conflict), which keeps what lands what the checks saw.
// - Every check on that commit is green, at least one passed, and every one
//   was read. Branch protection would stop a red required check anyway; this
//   also covers the repositories without protection, and checks that are
//   not required.
// - A pull request from a fork is refused: its checks ran on code nobody
//   here wrote. So is one that changes anything under .github, where the
//   workflows (which the App cannot write) and the actions they run live.
// - A release is a new v* tag on a commit the default branch already holds,
//   green, and agreeing with package.json where there is one. The tag
//   starts the repository's own release workflow; nothing here builds or
//   publishes.
//
// No tool pushes, deletes, closes, force-pushes or changes a setting.

/** A release tag, as the release workflows match it (`v*`), in SemVer. */
export const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[\w.-]{1,100}$/;
const PER_PAGE = 100;
const MAX_PAGES = 5;
const GREEN = new Set(['success', 'skipped', 'neutral']);
// Workflows, the actions they call, and the files that steer Dependabot.
const CI_DIR = '.github/';
// What GitHub calls a pull request that can be merged as it stands; it
// answers "unknown" (and mergeable null) while it is still working it out.
const CLEAN = new Set(['clean', 'has_hooks']);
const METHODS = new Set(['rebase', 'squash']);

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Whether `name` names a repository and nothing that could leave the owner. */
export function checkRepo(name) {
  const repo = String(name ?? '');
  if (!NAME.test(repo) || repo === '.' || repo === '..') throw fail(400, `"${name}" is not a repository name`);
  return repo;
}

/**
 * What the checks on one commit say: `green` when every check run and
 * status passed, `pending` while one has not finished, `red` when one
 * failed, `none` when nothing reported. Check runs and commit statuses are
 * two APIs; both count.
 */
export function judgeChecks(runs, statuses) {
  const red = [];
  const pending = [];
  for (const r of runs) {
    if (r.status !== 'completed') pending.push(r.name);
    else if (!GREEN.has(r.conclusion)) red.push(`${r.name} (${r.conclusion})`);
  }
  for (const s of statuses) {
    if (s.state === 'pending') pending.push(s.context);
    else if (s.state !== 'success') red.push(`${s.context} (${s.state})`);
  }
  const ran = runs.length + statuses.length;
  // Something has to have passed: a commit whose every check was skipped has
  // been tested by nothing.
  const passed = runs.filter(r => r.conclusion === 'success').length + statuses.filter(s => s.state === 'success').length;
  const state = red.length ? 'red' : pending.length ? 'pending' : passed ? 'green' : 'none';
  return { state, ran, red, pending };
}

/** Why `checks` stops a merge or a release, or null if it does not. */
function notGreen(checks, sha) {
  if (!checks.complete) return `more checks reported on ${sha} than can be read here`;
  if (checks.state === 'green') return null;
  if (checks.state === 'none') return checks.ran ? `no check on ${sha} passed: every one was skipped` : `no check has reported on ${sha} yet`;
  if (checks.state === 'pending') return `checks on ${sha} are still running: ${checks.pending.join(', ')}`;
  return `checks on ${sha} failed: ${checks.red.join(', ')}`;
}

/**
 * `owner` the account, `token` a function that resolves to a token for it
 * (the App's installation token).
 */
export function createGitHub({ owner, token, api = 'https://api.github.com', fetchImpl = fetch, timeoutMs = 20_000 }) {
  if (!NAME.test(String(owner ?? ''))) throw new Error('GITHUB_OWNER must name the account');
  if (typeof token !== 'function') throw new Error('a token source is needed');

  async function call(method, where, body) {
    const res = await fetchImpl(`${api}${where}`, {
      method,
      headers: {
        authorization: `Bearer ${await token()}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'aemtli',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // GitHub answers JSON; anything else is reported by its status.
    }
    if (!res.ok) throw fail(res.status, `GitHub answered ${res.status}: ${json?.message ?? (text.slice(0, 200) || res.statusText)}`);
    return json;
  }

  /** A GET that answers null for 404, for things that may not exist. */
  const maybe = where => call('GET', where).catch(err => {
    if (err.status === 404) return null;
    throw err;
  });

  /**
   * Every page of a list, up to MAX_PAGES. `pick` takes the items out of a
   * page for the APIs that wrap them in an object.
   */
  async function pages(where, pick = page => page) {
    const all = [];
    const join = where.includes('?') ? '&' : '?';
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const got = pick(await call('GET', `${where}${join}per_page=${PER_PAGE}&page=${page}`)) ?? [];
      all.push(...got);
      if (got.length < PER_PAGE) return { items: all, complete: true };
    }
    return { items: all, complete: false };
  }

  const base = repo => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(checkRepo(repo))}`;
  const pullNumber = n => {
    if (!Number.isInteger(n) || n < 1) throw fail(400, `"${n}" is not a pull request number`);
    return n;
  };
  const checkSha = sha => {
    if (!SHA.test(String(sha ?? ''))) throw fail(400, `"${sha}" is not a full commit sha (40 hex characters)`);
    return sha;
  };

  async function checks(repo, sha) {
    const runs = await pages(`${base(repo)}/commits/${sha}/check-runs`, p => p?.check_runs);
    const combined = await call('GET', `${base(repo)}/commits/${sha}/status?per_page=${PER_PAGE}`);
    const statuses = combined?.statuses ?? [];
    // A check that was not read cannot be called green.
    const complete = runs.complete && (combined?.total_count ?? statuses.length) <= statuses.length;
    return { ...judgeChecks(runs.items, statuses), complete };
  }

  async function pull(repo, number) {
    const pr = await call('GET', `${base(repo)}/pulls/${pullNumber(number)}`);
    const files = await pages(`${base(repo)}/pulls/${number}/files`);
    const names = files.items.flatMap(f => [f.filename, f.previous_filename].filter(Boolean));
    return {
      repo,
      number,
      title: pr.title,
      author: pr.user?.login ?? null,
      state: pr.merged ? 'merged' : pr.state,
      draft: Boolean(pr.draft),
      url: pr.html_url,
      base: pr.base?.ref,
      defaultBranch: pr.base?.repo?.default_branch,
      head: pr.head?.ref,
      sha: pr.head?.sha,
      // A head whose repository is gone is a fork that was deleted.
      fork: !pr.head?.repo || pr.head.repo.full_name !== pr.base?.repo?.full_name,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state,
      files: files.items.map(f => f.filename),
      filesComplete: files.complete,
      touchesCi: names.some(n => n.startsWith(CI_DIR)),
      checks: pr.head?.sha ? await checks(repo, pr.head.sha) : null,
    };
  }

  return {
    /** The repositories the App may see. */
    async repos() {
      const got = await pages('/installation/repositories', p => p?.repositories);
      return {
        complete: got.complete,
        repositories: got.items
          .map(r => ({ name: r.name, private: r.private, archived: r.archived, defaultBranch: r.default_branch, pushed: r.pushed_at, url: r.html_url }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },

    /** Open pull requests, in one repository or across all of the owner's. */
    async pulls({ repo } = {}) {
      if (repo) {
        const got = await pages(`${base(repo)}/pulls?state=open`);
        return {
          complete: got.complete,
          pulls: got.items.map(p => ({ repo, number: p.number, title: p.title, author: p.user?.login ?? null, draft: Boolean(p.draft), opened: p.created_at, url: p.html_url })),
        };
      }
      const q = encodeURIComponent(`is:pr is:open user:${owner}`);
      const got = await pages(`/search/issues?q=${q}&sort=created&order=desc`, p => p?.items);
      return {
        complete: got.complete,
        pulls: got.items.map(p => ({ repo: String(p.repository_url ?? '').split('/').pop(), number: p.number, title: p.title, author: p.user?.login ?? null, draft: Boolean(p.draft), opened: p.created_at, url: p.html_url })),
      };
    },

    /** One pull request with its files and the checks on its head. */
    pull: ({ repo, number }) => pull(repo, number),

    /** The latest releases and tags of one repository. */
    async releases({ repo }) {
      const releases = await call('GET', `${base(repo)}/releases?per_page=10`);
      const tags = await call('GET', `${base(repo)}/tags?per_page=10`);
      return {
        repo,
        releases: (releases ?? []).map(r => ({ tag: r.tag_name, name: r.name, draft: r.draft, prerelease: r.prerelease, published: r.published_at, url: r.html_url })),
        tags: (tags ?? []).map(t => ({ tag: t.name, sha: t.commit?.sha })),
      };
    },

    /**
     * Merges one pull request into the default branch, if its head is still
     * `sha` and everything on it is green.
     */
    async merge({ repo, number, sha, method = 'rebase' }) {
      checkSha(sha);
      if (!METHODS.has(method)) throw fail(400, `method must be rebase or squash: the branches keep a linear history`);
      const pr = await pull(repo, number);
      if (pr.state !== 'open') throw fail(409, `#${number} is ${pr.state}`);
      if (pr.draft) throw fail(409, `#${number} is a draft`);
      if (pr.base !== pr.defaultBranch) throw fail(409, `#${number} goes into ${pr.base}, not into ${pr.defaultBranch}`);
      if (pr.sha !== sha) throw fail(409, `#${number} moved: its head is ${pr.sha} now, and the merge was asked for ${sha}. Read it again.`);
      if (pr.fork) throw fail(409, `#${number} comes from a fork; merge it by hand`);
      if (!pr.filesComplete) throw fail(409, `#${number} changes more files than can be read here; merge it by hand`);
      if (pr.touchesCi) throw fail(409, `#${number} changes ${CI_DIR}, where CI and its actions live; merge it by hand`);
      if (!pr.mergeable || !CLEAN.has(pr.mergeableState)) throw fail(409, `#${number} is not clean to merge (GitHub says ${pr.mergeableState ?? 'nothing yet'}); update the branch or try again in a minute`);
      const why = notGreen(pr.checks, sha);
      if (why) throw fail(409, why);
      const done = await call('PUT', `${base(repo)}/pulls/${number}/merge`, { sha, merge_method: method });
      return { repo, number, merged: Boolean(done?.merged), sha: done?.sha ?? null, message: done?.message ?? null, url: pr.url };
    },

    /**
     * Tags `sha` as `tag`: an annotated tag, as `npm version` makes one,
     * which starts the repository's release workflow.
     */
    async release({ repo, tag, sha }) {
      checkSha(sha);
      if (!TAG.test(String(tag ?? ''))) throw fail(400, `"${tag}" is not a release tag (v1.2.3, or v1.2.3-rc.1)`);
      const info = await call('GET', base(repo));
      if (info.archived) throw fail(409, `${repo} is archived`);
      if (await maybe(`${base(repo)}/git/ref/tags/${encodeURIComponent(tag)}`)) throw fail(409, `${repo} already has ${tag}`);
      const branch = info.default_branch;
      const compare = await call('GET', `${base(repo)}/compare/${encodeURIComponent(branch)}...${sha}`);
      // base...head: "behind" means the commit is in the branch's history.
      if (!['identical', 'behind'].includes(compare?.status)) throw fail(409, `${sha} is not on ${branch}; a release is tagged on what was merged`);
      const pkg = await maybe(`${base(repo)}/contents/package.json?ref=${sha}`);
      if (pkg) {
        // The contents API leaves a large file's content out, and a folder
        // has none: neither can be compared, so neither is released.
        if (typeof pkg.content !== 'string' || pkg.encoding !== 'base64') throw fail(409, `package.json at ${sha} cannot be read here`);
        let version;
        try {
          version = JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8')).version;
        } catch {
          throw fail(409, `package.json at ${sha} does not parse`);
        }
        if (version !== tag.slice(1)) throw fail(409, `package.json at ${sha} says ${version}, not ${tag.slice(1)}; the release workflow would refuse the tag`);
      }
      const why = notGreen(await checks(repo, sha), sha);
      if (why) throw fail(409, why);
      const object = await call('POST', `${base(repo)}/git/tags`, { tag, message: tag.slice(1), object: sha, type: 'commit' });
      await call('POST', `${base(repo)}/git/refs`, { ref: `refs/tags/${tag}`, sha: object.sha });
      return { repo, tag, sha, url: `${info.html_url}/releases/tag/${encodeURIComponent(tag)}`, workflows: `${info.html_url}/actions` };
    },
  };
}

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const repoArg = { type: 'string', description: 'The repository name, without the owner, e.g. "aemtli".' };

/** The tools, for an MCP server. */
export function githubTools(github) {
  const read = { readOnlyHint: true, openWorldHint: true };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  return [
    {
      name: 'github_repos',
      description: 'Lists the repositories ämtli may see, with their default branch.',
      inputSchema: obj({}),
      annotations: read,
      run: () => github.repos(),
    },
    {
      name: 'github_pull_requests',
      description: 'Lists open pull requests, in one repository or, without one, across all of them.',
      inputSchema: obj({ repo: repoArg }),
      annotations: read,
      run: a => github.pulls(a),
    },
    {
      name: 'github_pull_request',
      description: 'Reads one pull request: its head commit, the files it changes, and whether the checks on its head are green. Read it before asking to merge it.',
      inputSchema: obj({ repo: repoArg, number: { type: 'integer', minimum: 1 } }, ['repo', 'number']),
      annotations: read,
      run: a => github.pull(a),
    },
    {
      name: 'github_releases',
      description: 'The latest releases and tags of one repository.',
      inputSchema: obj({ repo: repoArg }, ['repo']),
      annotations: read,
      run: a => github.releases(a),
    },
    {
      name: 'github_merge',
      description: 'Merges one pull request into the default branch. It merges only if its head is still the commit given, every check on it is green, '
        + 'GitHub calls it clean, it is not from a fork, and it changes nothing under .github. Rebase by default, as the branches keep a linear history.',
      inputSchema: obj({
        repo: repoArg,
        number: { type: 'integer', minimum: 1 },
        sha: { type: 'string', description: 'The head commit github_pull_request reported, in full.' },
        method: { type: 'string', enum: ['rebase', 'squash'] },
      }, ['repo', 'number', 'sha']),
      annotations: write,
      run: a => github.merge(a),
    },
    {
      name: 'github_release',
      description: 'Tags a release: a new v* tag on a commit the default branch already holds, with green checks, and matching package.json where there is one. '
        + 'The tag starts the repository\'s own release workflow. Bump the version in a merged pull request first.',
      inputSchema: obj({
        repo: repoArg,
        tag: { type: 'string', description: 'e.g. "v1.4.0"' },
        sha: { type: 'string', description: 'The commit to tag, in full; usually the head of the default branch.' },
      }, ['repo', 'tag', 'sha']),
      annotations: write,
      run: a => github.release(a),
    },
  ];
}
