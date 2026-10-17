// The chores themselves, for the agent that runs them: read a recipe, and
// propose a change to one as a pull request.
//
// goose reads letters, mail and web pages, so what it asks for is never
// trusted on its word. The narrow shape here is the point: no general GitHub
// access, one file per proposal, and only under the recipes folder this
// server was given. There is no tool that merges, deletes, force-pushes or
// touches another path, so the worst a planted instruction gets is a pull
// request that a person still has to read and merge. The token backing it
// should have no Workflows permission, so a proposal can never change what
// CI runs.
//
// Everything goes through the GitHub REST API, with a fine-grained token or
// with the GitHub App's installation token narrowed to this one repository.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A recipe's file name without its extension: what a CronJob calls it. */
export const RECIPE_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const BRANCH_SAFE = /[^a-z0-9-]+/g;
// A recipe is a page of code, not a program: 64 KB is already generous, and
// the limit keeps one call from filling a repository.
const MAX_BYTES = 64 * 1024;
const MAX_WHY = 2000;
// Open pull requests are read page by page, because a proposal that is not
// in the list is one the agent would make a second time.
const PER_PAGE = 100;
const MAX_PAGES = 5;

/** The first line of a piece of text, trimmed, at most `max` characters. */
const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * What a recipe must carry to be one: the two header lines the UI reads, and
 * a default export to run. Returns the reason it is not, or null.
 */
export function whyNotARecipe(source) {
  const text = String(source ?? '');
  if (!text.trim()) return 'the file would be empty';
  if (Buffer.byteLength(text) > MAX_BYTES) return `a recipe is at most ${MAX_BYTES} bytes, this one is ${Buffer.byteLength(text)}`;
  if (!/^\/\/ title:\s*\S/m.test(text)) return 'the first lines must carry "// title: ..." , which the UI shows';
  if (!/^\/\/ description:\s*\S/m.test(text)) return 'the first lines must carry "// description: ...", which the UI shows';
  if (!/export\s+default\s/.test(text)) return 'a job needs a default export to run';
  return null;
}

/** Node's own syntax check, over a copy in a temp file. Resolves with the error, or null. */
export async function checkSyntax(source, { node = process.execPath, dir = tmpdir() } = {}) {
  const where = await mkdtemp(join(dir, 'aemtli-check-'));
  const file = join(where, 'recipe.mjs');
  try {
    await writeFile(file, source);
    const { code, stderr } = await new Promise((resolve, reject) => {
      // --check parses the file and stops: it never runs what is in it.
      const child = spawn(node, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', d => { err += d; });
      child.on('error', reject);
      child.on('close', c => resolve({ code: c, stderr: err }));
    });
    if (code === 0) return null;
    // Node names the temp file in its message, by the path the system
    // resolved, which says nothing to the agent: the line and the reason do.
    return stderr.replace(/\S*recipe\.mjs/g, '<recipe>')
      .split('\n').map(l => l.trimEnd()).filter(Boolean).slice(0, 6)
      .join('\n');
  } finally {
    await rm(where, { recursive: true, force: true });
  }
}

/**
 * `repo` is "owner/name", `path` the folder the recipes live in, `base` the
 * branch they live on, `token` a fine-grained token with Contents and Pull
 * requests, and nothing else, or a function that resolves to one.
 */
export function createRecipes({ repo, path, base = 'main', token, api = 'https://api.github.com', branchPrefix = 'goose', fetchImpl = fetch, now = () => new Date(), timeoutMs = 20_000 }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo ?? ''))) throw new Error('RECIPES_REPO must be "owner/name"');
  const folder = String(path ?? '').replace(/^\/+|\/+$/g, '');
  if (!folder) throw new Error('RECIPES_REPO_PATH must name the folder the recipes live in');
  if (!token) throw new Error('a token is needed to read and propose recipes');

  async function call(method, where, body) {
    const res = await fetchImpl(`${api}${where}`, {
      method,
      headers: {
        authorization: `Bearer ${typeof token === 'function' ? await token() : token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'aemtli',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      // GitHub's own words, which say what a token may not do; the token
      // itself is never in them.
      const why = json?.message ?? (text.slice(0, 200) || res.statusText);
      throw Object.assign(new Error(`GitHub answered ${res.status}: ${why}`), { status: res.status });
    }
    return json;
  }

  const fileOf = name => `${folder}/${name}.mjs`;
  const checkName = name => {
    if (!RECIPE_NAME.test(String(name ?? ''))) throw Object.assign(new Error(`"${name}" is not a recipe name (lower case letters, digits and dashes)`), { status: 400 });
    return name;
  };
  const encodePath = p => p.split('/').map(encodeURIComponent).join('/');

  /** The recipe files in the folder, by name. */
  async function list() {
    const entries = await call('GET', `/repos/${repo}/contents/${encodePath(folder)}?ref=${encodeURIComponent(base)}`);
    return (Array.isArray(entries) ? entries : [])
      .filter(e => e.type === 'file' && /\.(mjs|yaml)$/.test(e.name))
      .map(e => ({ name: e.name.replace(/\.(mjs|yaml)$/, ''), file: e.name, bytes: e.size, kind: e.name.endsWith('.yaml') ? 'goose recipe' : 'job' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One recipe as it stands on `base`, with the sha a change has to build on. */
  async function read(name) {
    let got;
    try {
      got = await call('GET', `/repos/${repo}/contents/${encodePath(fileOf(checkName(name)))}?ref=${encodeURIComponent(base)}`);
    } catch (err) {
      // GitHub's 404 is about an address; the agent asked for a chore.
      throw err.status === 404 ? Object.assign(new Error(`no recipe "${name}"`), { status: 404 }) : err;
    }
    if (got?.type !== 'file' || typeof got.content !== 'string') throw Object.assign(new Error(`no recipe "${name}"`), { status: 404 });
    return { name, file: fileOf(name), sha: got.sha, source: Buffer.from(got.content, 'base64').toString('utf8') };
  }

  const stamp = () => now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

  return {
    list,
    read,

    /**
     * Opens a pull request that changes this one recipe and nothing else.
     * The source is checked first (header lines, a default export, Node's own
     * syntax check), so a proposal that cannot run never reaches a branch.
     */
    async propose({ name, source, why }) {
      checkName(name);
      const bad = whyNotARecipe(source);
      if (bad) throw Object.assign(new Error(`not a recipe: ${bad}`), { status: 400 });
      const syntax = await checkSyntax(source);
      if (syntax) throw Object.assign(new Error(`the file does not parse:\n${syntax}`), { status: 400 });
      const reason = oneLine(why, MAX_WHY);
      if (!reason) throw Object.assign(new Error('say why the change is wanted; it goes into the pull request'), { status: 400 });

      // What is there now, if anything: a new recipe has no sha to build on.
      let current = null;
      try {
        current = await read(name);
      } catch (err) {
        if (err.status !== 404) throw err;
      }
      if (current && current.source === String(source)) throw Object.assign(new Error(`${name} already reads exactly like this; nothing to propose`), { status: 409 });

      const head = `${branchPrefix}/${name.replace(BRANCH_SAFE, '-')}-${stamp()}`;
      const { object } = await call('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
      await call('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${head}`, sha: object.sha });
      try {
        await call('PUT', `/repos/${repo}/contents/${encodePath(fileOf(name))}`, {
          message: `${current ? 'Change' : 'Add'} the ${name} recipe\n\n${reason}`,
          content: Buffer.from(String(source)).toString('base64'),
          branch: head,
          ...(current ? { sha: current.sha } : {}),
        });
        const pull = await call('POST', `/repos/${repo}/pulls`, {
          title: `${current ? 'Change' : 'Add'} the ${name} recipe`,
          head,
          base,
          body: `${reason}\n\nProposed by goose through ämtli. Nothing of this runs until someone merges it: the cluster follows \`${base}\`.`,
        });
        return { name, branch: head, number: pull.number, url: pull.html_url, changed: Boolean(current) };
      } catch (err) {
        // A branch without a pull request is a branch nobody will look at.
        // Taking it back is best effort: the proposal failed either way, and
        // the reason to tell is the one that failed.
        await call('DELETE', `/repos/${repo}/git/refs/heads/${encodeURIComponent(head)}`).catch(() => {});
        throw err;
      }
    },

    /**
     * The proposals that are still open, so nothing is proposed twice.
     * Every open pull request has to be looked at: GitHub matches `head`
     * exactly and cannot be asked for a prefix, and a proposal missing from
     * this list is one the agent would make again.
     */
    async proposals() {
      const mine = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const pulls = await call('GET', `/repos/${repo}/pulls?state=open&per_page=${PER_PAGE}&page=${page}`);
        const got = Array.isArray(pulls) ? pulls : [];
        mine.push(...got
          .filter(p => String(p.head?.ref ?? '').startsWith(`${branchPrefix}/`))
          .map(p => ({ number: p.number, title: p.title, branch: p.head.ref, url: p.html_url, opened: p.created_at })));
        if (got.length < PER_PAGE) return mine;
      }
      // More open pull requests than this repository should ever have: the
      // list says so rather than pretending to be the whole of it.
      mine.push({ number: null, title: `more than ${MAX_PAGES * PER_PAGE} pull requests are open; this list may miss proposals`, branch: null, url: null, opened: null });
      return mine;
    },
  };
}

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** The tools, for an MCP server. */
export function recipeTools(recipes) {
  const read = { readOnlyHint: true, openWorldHint: false };
  return [
    {
      name: 'recipes_list',
      description: 'Lists the chores as they stand in the repository: the jobs (code) and the goose recipes (YAML).',
      inputSchema: obj({}),
      annotations: read,
      run: async () => ({ recipes: await recipes.list() }),
    },
    {
      name: 'recipes_read',
      description: 'Reads one job as it stands on the branch the cluster follows.',
      inputSchema: obj({ name: { type: 'string', description: 'The chore, as the dashboard names it, e.g. "termine".' } }, ['name']),
      annotations: read,
      run: a => recipes.read(a.name),
    },
    {
      name: 'recipes_open_proposals',
      description: 'The changes already proposed and not yet merged or closed.',
      inputSchema: obj({}),
      annotations: read,
      run: async () => ({ proposals: await recipes.proposals() }),
    },
    {
      name: 'recipes_propose',
      description: 'Proposes the whole new text of one job as a pull request: a branch of its own, that one file, and nothing else. '
        + 'It never merges and never changes anything the cluster runs; a person reads it and decides. '
        + 'The text must carry the "// title:" and "// description:" lines and a default export, and it must parse.',
      inputSchema: obj({
        name: { type: 'string', description: 'The chore to change, or the name of a new one.' },
        source: { type: 'string', description: 'The complete new file, not a patch.' },
        why: { type: 'string', description: 'Why the change is wanted, in a sentence or two. It becomes the pull request.' },
      }, ['name', 'source', 'why']),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: a => recipes.propose(a),
    },
  ];
}
