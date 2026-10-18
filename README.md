<img src="public/icon.svg" alt="" width="96" height="96">

# ämtli

*Ämtli* is Swiss German for the small chores on a household rota. This is that
for [goose](https://github.com/aaif-goose/goose): goose recipes run as
Kubernetes CronJobs, a dashboard shows what ran and what came of it, and a chat
talks to the same goose, all behind Cloudflare Access.

It runs on a Raspberry Pi 4 with k3s and does not need a local model: point
goose at a provider with an API key, or at an Ollama on another machine.

## What is in it

| Part | What it does |
| --- | --- |
| `aemtli run <recipe>` | What a CronJob runs for an agent's chore. Starts `goose run --recipe`, waits, and writes `run.json`, `result.md` and `run.log` to the shared volume. Exit 0 only if a model actually answered. |
| `aemtli job <name>` | What a CronJob runs for a chore that code can do. Runs `<name>.mjs`, which asks the model only where judgement is needed, through the model proxy and a small model by default. Recorded like a goose run. |
| `aemtli web` | The dashboard, the run pages, and the chat. One row per chore: its name, its schedule in words ("Weekdays at 07:00"), this week as seven marks (a tick for each run, a red cross where one failed, an empty box where a slot passed without a run, a ring for what is still due), when it runs next, what came of the last run, and "Run now". On a wide screen the rows line up under one row of day names and read as the chart they are; on a phone each row stacks and the marks carry their own day letters. A run page shows the answer rendered from Markdown. |
| `goose serve` | The agent the chat talks to, over ACP on a WebSocket that only the web pod can reach. It keeps every conversation, so the chat has a history. |
| `aemtli model-proxy` | The only holder of the model's API key. goose and the runs call the model through it with a placeholder key; it puts the real one on. |
| `aemtli mcp-gateway` | Serves one MCP server to the agents, in a pod that alone holds that server's credentials. Calls the owner has to approve are held until they decide in the UI. |
| `aemtli mcp-kanban` | The kanban board as MCP tools on stdio, for a gateway to run. Works with [byge](https://github.com/sapn95/byge) only. See [The kanban board](#the-kanban-board). |
| `aemtli mcp-recipes` | The chores in the GitOps repository, and a pull request to change one. See [Chores that improve themselves](#chores-that-improve-themselves). |
| `aemtli mcp-github` | The owner's repositories through a GitHub App: read, merge a green pull request, tag a release. See [The repositories](#the-repositories). |

One image holds all six: goose, node and npm (for MCP servers started with
`npx`), uv and python (for `uvx`), and the app.

```text
browser ─▶ Cloudflare Access ─▶ tunnel ─▶ aemtli-web ─┬─▶ Kubernetes API (CronJobs, Jobs)
                                                       ├─▶ volume aemtli-runs (read)
                                                       └─▶ chat broker ═ACP═▶ aemtli-goose ─▶ aemtli-model-proxy ─▶ model API
CronJob ─▶ aemtli run <recipe> ─▶ goose run ─────────────────────▶ aemtli-model-proxy ─▶ model API
                                └─▶ volume aemtli-runs (write)
goose serve keeps its settings and sessions on volume aemtli-goose.
```

## A recipe

A recipe is an ordinary goose recipe file in the `aemtli-recipes` ConfigMap,
plus a CronJob that runs `aemtli run <name>`. The CronJob carries the
schedule; the dashboard finds it by the label `app.kubernetes.io/part-of:
aemtli` and the recipe name in `aemtli.sapn.ch/recipe`. See
[`deploy/kubernetes/example`](deploy/kubernetes/example) for two: `hello`
(paused, for checking the wiring) and `release-watch`.

Two things goose does that the runner works around:

- goose exits 0 and reports `"status": "completed"` even when the model could
  not be reached; the error is only in the text of the last message. The
  runner counts a run as successful only when tokens were used and the last
  message came from a model, so a dead API key shows up as a failed Job.
- A tool a person chose to "always allow" in the chat is remembered in
  `/data/goose/config/goose/permission.yaml` in the goose pod. Delete the
  line to be asked again.

## The chat

The web server, not the browser, holds the conversation with goose. A turn
goes on when the phone locks or the page closes; a question goose asks
before a tool waits until it is answered, from any device, and a push says
that it waits. When nobody is watching, another push says that the answer is
there. The page lists the conversations goose keeps (it stores them on
`aemtli-goose`), opens one by replaying it, and follows it through a stream
of server-sent events that the browser picks up again by itself after a
dropped connection. goose's answers arrive as HTML that the server draws from
their Markdown with the same rules as a run's result: no raw HTML, no script
links, no images loaded.

A message can carry images: up to six, added with the Image button, pasted,
or dropped on the box. The page draws each one as a JPEG of at most 1568
pixels on its longer side, the size the model works at, and the drawing
leaves the photo's metadata (location, camera) behind. The server checks
each image's first bytes against its type and hands it to goose as an image
block, which goose passes on to the model. Images that come back when goose
replays a conversation are shown with the message they belong to. The server
keeps up to 64 MB of them in memory and serves them by id under
`/api/chats/<id>/images/<image>`; one it let go returns when the
conversation is opened again, unless that one conversation alone holds more.

A conversation can be put away or deleted from its line in the list (the box
and the bin beside the time) or from the chat's own header. Archived ones are
hidden until the page asks for them; where they are kept is ämtli's own
business, because goose has no archive over ACP. Deleting one deletes it at
goose, and that cannot be undone.

Every code block has a Copy button: in goose's answers, in a run's result and
log, and in a held call's long arguments.

A conversation keeps the tool servers it was made with: goose stores them
per session, so a gateway added afterwards shows up in new conversations,
not in old ones.

A run can be taken into the chat from its own page: "Ask goose" under the
answer sends the question with the run in front of it, so nobody pastes a
report to ask about it. It goes to a new conversation unless another one is
named, and what the run wrote is quoted as data rather than as an
instruction, because a job collects it from letters and web pages.

`/api/chats` lists them and starts one; `/api/chats/<id>/events` is the
stream; `say`, `stop`, `answer`, `mode` and `archive` change a conversation,
and `DELETE` removes it, from this origin only.
`/api/recipes/<name>/runs/<id>/chat` is the question about a run.

## On the phone

ämtli installs as an app: "Add to Home Screen" in Safari, "Install app" in
Chrome. It starts without the browser around it and has a Reload button on
the dashboard and a chore's page, since there is no browser to reload with.
The manifest (`/manifest.webmanifest`) is linked with its cookie
(`crossorigin="use-credentials"`), because Access refuses a request for it
without one. The icons are drawn by the server (`src/web/icon.mjs`) from the
motif of `public/icon.svg`, so the repo holds no PNG files.

On Android, Chrome paints the manifest's colour in a band under the
installed app, where the gesture bar is. A manifest has one colour for both
themes, so it is the paper of the dark theme. With the phone in light mode
that band is dark, and so is the screen shown while the app starts. The
status bar follows the phone's theme once a page has loaded.

A service worker (`/sw.js`) keeps the versioned static files and a page that
says there is no connection. It never keeps a page or anything under
`/api/`, and it leaves the chat's event stream alone. Each release is a new
worker, which drops the old one's files.

On a phone only the page scrolls. A wide table or code block scrolls
sideways inside itself, the list of conversations folds away while one is
open, and the box to write in stays at the bottom of the screen.

Everything stays behind Access, the manifest and the icons too. Some iOS
versions fetch the home-screen icon without the cookie, and then the icon
stays blank. An Access bypass alone does not change that: the server checks
the Access assertion itself and answers 403 without one. It would take a
bypass for `/static/icons/*` and `/manifest.webmanifest` together with the
server letting exactly those two through, which it does not do. Neither
holds anything private.

## Notifications

A push goes out for a call held for your approval, for a question goose
asks in the chat or an answer nobody waited for, and for whatever a job
reports with `ctx.notify`. It can go two ways, and either is optional:

- **Web Push**, straight to the installed app. Turn it on for each device
  on the Connections page; on an iPhone that works only in the app added to
  the home screen. The server encrypts each message for the device (RFC
  8291) and signs its request with a VAPID key (RFC 8292), so the push
  service in between sees that something was sent, never what. It posts only
  to the push services of Chrome, Firefox, Safari and Edge, whatever a
  subscription names. A push service that says a device is gone has it
  dropped. Make the key once with
  `openssl ecparam -name prime256v1 -genkey -noout -out key.pem` and give
  the web pod its path in `VAPID_PRIVATE_KEY_FILE`.
- **ntfy**, through an ntfy server and its app, with `NTFY_URL`.

A job runs in a pod of its own, without the key or the subscriptions. It
hands its push to the web pod's notify port (`NOTIFY_PORT`) with a token,
and the web pod sends it on both ways. The tunnel does not reach that port,
and the network policy lets only the job pods in.

## Jobs: code first, the model where it pays

Most chores are the same steps every time: fetch, filter, file by a rule.
Those are code. A job is a JavaScript module next to the recipes; its
default export gets a context and returns the result as Markdown:

```js
// title: Release watch
// description: What changed this week in the projects the homelab runs
export default async function (ctx) {
  const news = /* fetch and filter in code */ [];
  if (!news.length) return 'Nothing new.';            // no model call, no tokens
  return ctx.ask({ prompt: `One line each:\n${news.join('\n')}` });
}
```

- `ctx.ask({ prompt, system, model, maxTokens, effort })` sends one message
  to the model through the model proxy. The model defaults to
  `claude-haiku-5-5` and `effort` to `low`. Current models think before they
  answer, and that counts against the token limit, so the request gets 2048
  tokens on top of `maxTokens`. Tokens are counted into the run.
- `ctx.mcp('<gateway>')` is an MCP client for a gateway named in
  `MCP_GATEWAYS`, with `tools()`, `call(name, args)` and `json(name, args)`.
  Approvals apply as they do for agents. A gateway that is not up yet
  (refused, or no address) is waited for, up to three minutes: gateways
  restart with every image and install their server first.
- `ctx.notify({ title, message })` sends one push, for a run worth a look
  on a phone (see Notifications). With `NOTIFY_URL` and `NOTIFY_TOKEN_FILE`
  it goes through the web pod, which sends it on by Web Push and ntfy;
  without them, straight to ntfy with `NTFY_URL`, `NTFY_TOPIC` and
  `NTFY_TOKEN_FILE`. With neither it says so in the log and returns false,
  and a push that does not go out never fails the run.
- `ctx.pdfText(bytes)` returns a PDF's text as `pdftotext -layout` lays it
  out (poppler is in the image), for lists and letters parsed in code.
- `ctx.qr(bytes)` returns the text of the QR codes on a PDF's first eight
  pages (`{ pages }` changes that): `pdftoppm` draws them, and ZXing,
  compiled to WebAssembly (`zxing-wasm`), reads them.
  `src/run/swissqr.mjs` reads a Swiss QR bill from that text and checks it
  the way a bank does, and `src/run/pain001.mjs` writes the bills into a
  pain.001.001.09 payment file (Swiss Payment Standards 2022, CHF), which
  e-banking imports and shows before anything is paid.
- `ctx.attach(name, data, type)` keeps a file with the run (a payment file, a
  list), up to 10 MB, typed as XML, CSV, text, PDF or JSON. The run page lists
  it, and it downloads; it is never shown in the page. `ctx.runLink` is the
  run page's address, for a push that should open it.
- `ctx.cards({ board })` keeps cards on the kanban board for what waits for
  the owner, through the gateway named `kanban`. `ensure(ref, { title,
  description, due, subtasks, column })` adds a card once per reference,
  and `done(ref)` moves it to the board's last column. The board (`Ämtli`
  unless named) is made on first use. `ensure` hands back the card's `url`
  and `url(id)` builds one, so a report can link the card; both are null
  without `KANBAN_PUBLIC_URL`, never a guessed address.
- `ctx.state` is kept between runs (`ctx.saveState()`), for "only what is
  new". `ctx.params`, `ctx.fetch`, `ctx.log` and `ctx.now` do what they say.

The model in a job gets text and gives text back. It has no tools, so what a
letter or a release note says cannot make it do anything. Use a goose recipe
for chores that really need an agent to decide its own steps.

The example's `release-watch` is a job: the feeds are read and filtered in
code, and the model is asked only to sum up releases it has not seen. A week
with nothing new costs nothing; the goose recipe it replaced spent about
30,000 tokens on the same answer.

## Tools that need a yes

An MCP server that can send a letter or a mail should not need a person for
reading, and should not do the sending without one. Each such server runs
behind its own `aemtli mcp-gateway`:

- The gateway pod is the only place the server's credentials live. The
  agents reach it over MCP's Streamable HTTP transport; it starts the server
  over stdio, one process per agent session.
- A policy file sorts the server's tools: `allow` runs, `approve` is held,
  `deny` is not even listed. A tool no list names is held, so a new tool in
  an update waits for a decision instead of running.
- A held call answers the agent at once ("waiting as request …"), so a
  scheduled run ends normally and says what waits. The UI shows each held
  call with its arguments under "Needs you" on the dashboard, and on the
  Approvals page. Approve runs the call in a fresh process and shows what
  came back; Reject records that nothing ran. Nobody deciding for seven days
  expires it.
- With Web Push or ntfy set up, the UI sends one push per held call: the
  gateway's name and the tool, never the arguments.
- A decision can carry a word to goose: the box beside Approve and Reject
  goes into a conversation once the call is decided, so a call rejected for
  the wrong date is corrected in the same breath. The decision stands even
  when the message does not go through, and the answer says which it was.
- A server that keeps a login of its own, like Outlook's, is logged in again
  from the Connections page, with no kubectl. The page shows each gateway and
  whether its login works; "Log in again" has the gateway call the server's
  login tool and shows the page to open and the code to enter. The gateway
  keeps that process up for fifteen minutes, because a device-code login
  finishes only after the code is entered, and the page asks every ten
  seconds until it has. The owner reaches the login tools through the admin
  port only. Agents must not: one that started a login could pass the code
  to someone who signs in with their own account, so the gateway does not
  start unless its policy denies every tool `GATEWAY_ACCOUNT` names.

```yaml
# a gateway's policy
default: approve
allow: [epost_list_*, epost_get_letter, epost_store_letter, create-calendar-event]
approve: [epost_delete_letter]
deny: [epost_login]
# An allowed call is held when one of these arguments is filled: a calendar
# entry is private, one with attendees sends invitations.
hold_if:
  create-calendar-event: [body.attendees]
```

`hold_if` paths are dotted argument names, matched without regard to case;
an empty list, object or string, `null` and `false` count as not filled.

The example has one gateway, for [epost-mcp](https://github.com/sapn95/epost-mcp),
in [`deploy/kubernetes/example/mcp-epost`](deploy/kubernetes/example/mcp-epost).
Its pod installs the server from a pinned lockfile at start and reaches only
DNS and public HTTPS. In a recipe or the chat, a gateway is an extension:

```yaml
extensions:
  - type: streamable_http
    name: epost
    uri: http://aemtli-mcp-epost:8080/mcp
    timeout: 120
```

## Security

- **Who gets in.** Cloudflare Access with GitHub login decides that at the
  edge. The UI then checks the `Cf-Access-Jwt-Assertion` token itself:
  RS256 only, signed by the team's current keys, for this application's AUD,
  not expired, and for an address in `ALLOWED_EMAILS`. A request that reached
  the pod some other way still gets a 403.
- **Cross-site.** "Run now", the decisions on held calls and everything that
  changes a conversation accept only same-origin requests. The browser has
  no connection to goose at all; only the web pod does.
- **The agent.** goose has a shell, in the chat and in every run, and a
  recipe that reads the internet can be talked into using it. So:
  - The model key is not in its environment. Only `aemtli-model-proxy` has
    it, as a mounted file; goose gets a placeholder and the proxy's address.
    An agent can still spend through the proxy, so give the key a spend
    limit at the provider.
  - Its pods and the recipe pods get no Kubernetes token. Their
    NetworkPolicy allows DNS, the model proxy and HTTPS to the internet, and
    nothing private: not the rest of the cluster, not the home network.
  - Runs and chat do not share state. Runs write only `aemtli-runs` and keep
    goose's own state in a throwaway home; goose serve keeps settings and
    sessions on `aemtli-goose`. A run cannot plant an extension or an
    "always allow" for the next chat.
  - The UI reads run files without following symlinks, refuses anything that
    is not a regular file, and reads at most a fixed size.
  - Only the web pod may open goose's port. The server secret is generated
    by ESO; the web pod and goose have it, the browser never does.
  - MCP servers with credentials run behind gateways, in pods of their own.
    The agents can call their tools but never see the credentials, and the
    calls that need approval cannot be approved by an agent: the approvals
    port takes a token only the UI has, and the NetworkPolicy lets only the
    UI reach it. The arguments of held calls are not logged.
- **Pod security.** The example namespace enforces the `restricted` Pod
  Security Standard, so the Jobs the UI may create cannot ask for privileges.
- **The UI's own rights** are one Role: read CronJobs, list and create Jobs,
  in its namespace.
- Every page is server-rendered with escaping, behind a Content-Security-Policy
  that allows only this origin's scripts and styles.

## Chores that improve themselves

`aemtli mcp-recipes` hands the agent the chores as they stand in the GitOps
repository, and one way to change them: a pull request.

| Tool | |
| --- | --- |
| `recipes_list`, `recipes_read`, `recipes_open_proposals` | read |
| `recipes_propose` | one branch, that one file, one pull request |

The narrow shape is the point. goose reads letters, mail and web pages, so
what it asks for is never trusted on its word:

- Only `<RECIPES_REPO_PATH>/<name>.mjs`, with `name` of lower-case letters,
  digits and dashes. Nothing else in the repository can be reached, and no
  name can leave the folder.
- One file per proposal, on a branch of its own named `goose/<name>-<when>`.
  There is no tool that merges, closes, deletes or force-pushes.
- The text must carry the `// title:` and `// description:` lines and a
  default export, and it must pass `node --check`, which parses it without
  running it. A proposal that cannot run never reaches a branch.
- The cluster follows `main`, so nothing a proposal says runs anywhere until
  a person merges it. That merge is the control; read the diff. The
  repositories gateway below can merge, which is why its policy has to hold
  `github_merge`.
- The token is a fine-grained one for that repository with Contents and Pull
  requests, **and no Workflows permission**: a proposal can then never change
  what CI runs, which is what would otherwise reach the CI secrets.

Settings: `RECIPES_REPO` (`owner/name`), `RECIPES_REPO_PATH`,
`RECIPES_REPO_BRANCH` (`main`), `RECIPES_TOKEN_FILE`, and for a different
host `GITHUB_API`. Without `RECIPES_TOKEN_FILE` it uses the GitHub App below
(`GITHUB_APP_ID`, `GITHUB_APP_KEY_FILE`) and asks for a token that reaches
only `RECIPES_REPO`, with Contents and Pull requests and nothing else.

## The repositories

`aemtli mcp-github` lets goose and the jobs look after the owner's
repositories: see what is open, merge a pull request whose checks are green,
and tag a release.

| Tool | |
| --- | --- |
| `github_repos`, `github_pull_requests`, `github_pull_request`, `github_releases` | read |
| `github_merge` | one pull request into the default branch, by rebase or squash |
| `github_release` | a new `v*` tag on a commit the default branch holds |

It acts as a GitHub App with write access and nothing more: Contents and Pull
requests to write, Checks and Commit statuses to read, no Administration, no
Workflows. The owner's own token would get past any branch protection that
does not enforce admins. The App does not: a red required check stops it like
anyone else, and it cannot change a setting. The private
key stays in the gateway pod. It signs a JWT, the JWT buys an installation
token that lasts an hour, and the token is renewed five minutes before it runs
out.

The code checks these whatever the policy says:

- A merge names the head commit the owner saw. If the branch has moved since,
  nothing is merged.
- GitHub has to call the pull request clean: not behind its base, no
  conflict. A rebase lands new commits, and this keeps them what the checks
  saw.
- Every check on that commit is green, at least one passed, and every one was
  read. This also covers the repositories without branch protection.
- A pull request from a fork, or one that changes anything under `.github`
  (the workflows, the actions they run, Dependabot's settings), is merged in
  the browser. The App may not write workflows anyway.
- A release tags a commit the default branch already holds, with green checks,
  under a tag that does not exist yet, and matching `package.json` if there is
  one. The tag starts the repository's own release workflow. Bump the version
  in a merged pull request first.

No tool pushes, closes, deletes or changes a setting. Hold `github_merge` and
`github_release` in the gateway's policy: with `recipes_propose` next to it, a
free merge would let goose merge its own proposal.

The App, once: register it under the owner's developer settings with the
permissions above and no webhook, install it on all repositories, and give the
gateway its id and private key.

Settings: `GITHUB_OWNER`, `GITHUB_APP_ID`, `GITHUB_APP_KEY_FILE` (the private
key, PEM), and for a different host `GITHUB_API`.

## The kanban board

`aemtli mcp-kanban` works with [byge](https://github.com/sapn95/byge) only,
the fork of golang-kanban v2 that ämtli's owner runs. It does what a person
does on the board, posting byge's forms and reading its pages, from inside
the cluster, so goose and the jobs can read the board and keep cards on it.
It relies on byge's markup and on byge's service identity, so upstream
golang-kanban or another fork will not work with it:

| Tool | |
| --- | --- |
| `kanban_list_boards`, `kanban_read_board`, `kanban_get_card`, `kanban_search` | read |
| `kanban_create_card`, `kanban_update_card`, `kanban_move_card`, `kanban_set_subtask` | change cards; an update keeps every field it is not given |
| `kanban_archive_card`, `kanban_restore_card` | archive and undo it |
| `kanban_create_board` | add a board, or get the one with that name |

There is no tool to delete a card, a column or a board; that stays in the
browser.

The pages are read as the byge release the cluster runs renders them, and
the tests read pages recorded from that release (`test/fixtures/kanban`).
Record them again when the board moves to another release.

The board refuses a cross-site browser post. A request from a server carries
no `Sec-Fetch-Site` and no `Origin`, so the gateway's posts go through; the
board's NetworkPolicy is what decides who may reach it. byge knows ämtli as
a service identity: every request carries `KANBAN_AS` in the header
`KANBAN_USER_HEADER`, which is byge's `AUTH_SERVICE_HEADER`.

A job finds its cards again by a reference at the end of the description,
`[ämtli:<ref>]`. A card the owner archived counts as dealt with and is not
made again.

## Settings

`aemtli web`:

| Variable | Default | |
| --- | --- | --- |
| `AUTH_MODE` | `access` | `none` only for a laptop |
| `CF_ACCESS_TEAM_DOMAIN` | | `<team>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | | the Access application's AUD tag |
| `ALLOWED_EMAILS` | | comma-separated |
| `PUBLIC_ORIGIN` | | `https://<host>`; required with Access, for the origin checks |
| `GOOSE_SERVE_HOST`, `GOOSE_SERVE_PORT` | `127.0.0.1`, `3284` | |
| `GOOSE_SERVER__SECRET_KEY` | | without it the chat is off |
| `DATA_DIR`, `RECIPES_DIR` | `/data`, `/recipes` | |
| `CHAT_CWD` | `/data/workspace` | goose's working directory for chat sessions |
| `DISPLAY_TIME_ZONE` | `UTC` | the zone the dashboard shows times and weeks in, e.g. `Europe/Zurich` |
| `GATEWAYS` | | JSON: `[{"name":"epost","title":"ePost","url":"http://aemtli-mcp-epost:8081","mcp":"http://aemtli-mcp-epost:8080/mcp"}]`. `url` is the approvals port; with `mcp`, every chat session gets the gateway as a tool server |
| `GATEWAY_TOKENS_DIR` | | one file per gateway, named after it, with its approvals token. A gateway with `"tokenFile": "/abs/path"` in `GATEWAYS` reads its token from there instead |
| `VAPID_PRIVATE_KEY_FILE` | | the Web Push key (PEM, P-256); without the file, no Web Push |
| `VAPID_SUBJECT` | `PUBLIC_ORIGIN` | a `mailto:` address or `https://` URL the push services can reach you at |
| `PUSH_FILE` | `$STATE_DIR/push-subscriptions.json` | the devices that turned Web Push on |
| `NTFY_URL`, `NTFY_TOPIC`, `NTFY_TOKEN_FILE` | | pushes also go to ntfy; optional |
| `NOTIFY_PORT`, `NOTIFY_TOKEN_FILE` | | the port where jobs hand in a push, and its token; without the file the port stays closed |
| `NOTIFY_STATE_FILE` | `$DATA_DIR/notified.json` | which held calls were pushed already |
| `STATE_DIR` | | where the UI keeps the favourite chores and which conversations are archived; without it there are neither |

`aemtli mcp-gateway`: `MCP_COMMAND` (the server's argv as JSON),
`POLICY_FILE`, `ADMIN_TOKEN_FILE` (at least 16 characters), `STATE_DIR`
(`/state`), `PORT` (8080, for agents), `ADMIN_PORT` (8081, for the UI), and
`GATEWAY_ACCOUNT` for a server with a login of its own: the tools that tell
and renew it, as
`{"status":{"tool":"verify-login"},"login":{"tool":"login","arguments":{"force":true}}}`.
Every other variable passes through to the MCP server, which is how it gets
its credentials.

`aemtli mcp-kanban`: `KANBAN_URL` (the byge board inside the cluster, e.g.
`http://kanban.kanban.svc.cluster.local:17808`), and for byge's service
identity `KANBAN_AS` and `KANBAN_USER_HEADER`.

`aemtli model-proxy`: `MODEL_UPSTREAM` (`https://api.anthropic.com`),
`MODEL_AUTH_HEADER` (`x-api-key`; `authorization` for OpenAI-style APIs),
`MODEL_AUTH_PREFIX` ("Bearer " with its space, for those), `MODEL_KEY_FILE`
(`/secrets/model/key`), `MODEL_ALLOW_PATHS` (`/v1/`).

`aemtli job`: `RECIPES_DIR`, `DATA_DIR`, `AEMTLI_TRIGGER`, `AEMTLI_KEEP_RUNS`,
`MCP_GATEWAYS` (JSON: `{"epost":"http://aemtli-mcp-epost:8080/mcp"}`),
`ANTHROPIC_HOST` with a placeholder `ANTHROPIC_API_KEY` for the proxy, and
for `ctx.notify` either `NOTIFY_URL` (the web pod's notify port, e.g.
`http://aemtli-web:8082/notify`) with `NOTIFY_TOKEN_FILE`, or the same
`NTFY_URL`, `NTFY_TOPIC` and `NTFY_TOKEN_FILE` the UI uses, plus
`PUBLIC_ORIGIN` for the link a push carries and
`KANBAN_PUBLIC_URL` for the one a card carries.

`aemtli run`: `RECIPES_DIR`, `DATA_DIR`, `AEMTLI_TRIGGER` (`schedule` or
`manual`), `AEMTLI_MAX_TURNS` (goose's own default is 1000), `AEMTLI_KEEP_RUNS`
(50), and goose's own variables (`GOOSE_PROVIDER`, `GOOSE_MODEL`, and for the
proxy `ANTHROPIC_HOST` plus a placeholder `ANTHROPIC_API_KEY`).

## Development

```sh
npm ci
npm run gate      # lint, hygiene, tests with a coverage floor
# the UI on :8080 without Access, against a cluster API of your choice
K8S_BASE_URL=http://127.0.0.1:8001 K8S_NAMESPACE=aemtli K8S_TOKEN=x npm run web
```

The tests use a fake goose for the runner, a fake Kubernetes API, a fake ACP
server for the WebSocket proxy, and a fake model (`test/fixtures/fake-llm.mjs`)
that speaks both the OpenAI and the Anthropic API, can call a shell tool, and
can insist on one API key. With a real goose 1.54 and that fake model, the
whole chain has been driven in Chromium: chat, a tool call with its
permission prompt, "Run now", and a run through the model proxy that only
succeeds with the key the proxy adds.

## Licence

MIT. The typeface in `public/fonts/` is Schibsted Grotesk by the Schibsted-Grotesk
Project Authors, under the SIL Open Font License (`public/fonts/OFL.txt`).
