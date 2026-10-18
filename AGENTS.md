# Working on aemtli

`README.md` says what aemtli is and how it is set up; read it first. This file
is for an agent changing the code: how a change gets in, the conventions the
code keeps, and the traps that have already been stepped in. The deployment on
the owner's Pi lives in sapn95/homelab-gitops, which has an `AGENTS.md` of its
own.

## How a change gets in

1. A branch, never `main`. Commits carry the owner's GitHub noreply
   address (`sapn95@users.noreply.github.com`) and the name of the earlier
   commits, and no co-author trailer.
2. `npm run gate`: lint, `scripts/hygiene.mjs`, and the tests with coverage
   (90 % lines and functions, 80 % branches). Hygiene reads tracked files only,
   so `git add` a new file before the gate, or CI finds what the gate did not.
3. A PR with a plain-English body: what changed, why, and how it was checked.
   CI runs the gate on Node 22 and 24, builds the image, checks the example
   manifests and scans for secrets.
4. Review: the CodeRabbit CLI once on the final branch
   (`coderabbit review --agent --base main`). It allows three reviews an hour
   for the whole account; when it is rate limited, review the diff by hand, say
   so on the PR, and merge. Take what is right, answer on the PR what is not.
5. `gh pr merge --rebase`.

**A release** is a commit of its own, last on the PR it ships with:
`npm version <minor|patch> --no-git-tag-version`, committed as
`Release x.y.z`. After the merge, tag that commit on `main`
(`git tag -a vx.y.z -m vx.y.z`, push the tag). `.github/workflows/release.yml`
builds the image for amd64 and arm64, pushes it to GHCR with a provenance
attestation, and makes the GitHub release. Then bump the image tag and the
base `ref=` in homelab-gitops.

## Conventions

- No new runtime dependency, no framework, no build step. Node's own modules
  do the work: `node:crypto` signs and encrypts Web Push, `node:zlib` writes
  the app icons.
- Everything that goes into a page goes through `esc()` (`src/web/pages.mjs`);
  browser scripts set text with `textContent`. The CSP allows no inline script
  or style, so a page's behaviour is a file in `public/` listed in `STATIC`
  (`src/web/server.mjs`).
- Every POST from the browser is same-origin only (`sameOrigin`); everything
  but `/healthz` is behind Cloudflare Access, which the server checks again.
- A tool that acts outward (sends, pays, deletes, merges) is held by its
  gateway for the owner's decision; the policy file in the deployment says
  which. A new MCP server lists its tools with `readOnlyHint` where true.
- Tests use real servers on random ports and fakes in `test/fixtures/`, not
  mocks of internals. A new behaviour gets a test, and a mutant of the change
  should fail one (break the line on purpose, run the test, put it back).
- Comments say why, in full sentences. Fixtures and examples use reserved
  names (`example.com`, `Example_*`): the repository is public, and hygiene
  refuses personal data.

## Map

| Path | What |
| --- | --- |
| `bin/aemtli.mjs` | The command: `web`, `run`, `job`, `model-proxy`, `mcp-gateway`, and the MCP servers (`mcp-kanban`, `mcp-recipes`, `mcp-github`, `mcp-transport`, `mcp-cluster`) |
| `src/web/` | The UI server, pages, chat broker, approvals client, Web Push (`webpush.mjs`) and the notify fan-out and port (`notify.mjs`) |
| `src/gateway/` | The MCP gateway: policy, held calls, the admin port for the UI |
| `src/mcp/` | The MCP servers, each a create function and a tools list served by `stdio.mjs` |
| `src/run/` | Recipe runs (goose) and jobs (code, `ctx.*`) |
| `public/` | Browser scripts, the stylesheet, the service worker |
| `deploy/kubernetes/` | The base every install uses, and an example overlay |

## Traps that happened

- gitleaks scans each commit of a PR, not the result. A finding fixed in a
  later commit still fails; fold the fix into the commit that added it. A
  published test vector is marked `gitleaks:allow` with the reason.
- Hygiene takes `user:password@host` for an email address; build such a URL
  from parts in a test.
- `npm run lint` is `eslint .`, which also lints agent worktrees under
  `.claude/worktrees` if there are any.
- Headless Chromium does not emulate `display-mode: standalone`. To check the
  installed app's layout, load `app.css` again with that media query replaced
  by `@media all` (and `bypassCSP` in the test context). It has no push
  service either, so Web Push is checked on a phone.
- byge's HTML is not an API. The kanban client uses byge's JSON API
  (`/api/v1`); `/search` and the board list on `/` are gone since byge 2.18.
- A job pod's first connections can be refused while the cluster's network
  policy catches up with it; clients that run in fresh pods retry a
  connection that was never made, and only that.
