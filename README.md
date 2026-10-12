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
| `aemtli mcp-kanban` | The kanban board ([golang-kanban](https://github.com/NicolasHaas/golang-kanban) v2) as MCP tools on stdio, for a gateway to run. See [The kanban board](#the-kanban-board). |

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

`/api/chats` lists them and starts one; `/api/chats/<id>/events` is the
stream; `say`, `stop`, `answer` and `mode` change a conversation, from this
origin only.

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
- `ctx.notify({ title, message })` sends one push through ntfy, for a run
  worth a look on a phone. It needs `NTFY_URL`, `NTFY_TOPIC` and
  `NTFY_TOKEN_FILE` in the run's pod; without them it says so in the log and
  returns false, and a refused push never fails the run.
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
  unless named) is made on first use.
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
- With `NTFY_URL` set, the UI sends one push per held call: the gateway's
  name and the tool, never the arguments.

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

## The kanban board

Upstream golang-kanban v2 has no API: a person posts forms and reads pages.
`aemtli mcp-kanban` does the same from inside the cluster, so goose and the
jobs can read the board and keep cards on it:

| Tool | |
| --- | --- |
| `kanban_list_boards`, `kanban_read_board`, `kanban_get_card`, `kanban_search` | read |
| `kanban_create_card`, `kanban_update_card`, `kanban_move_card`, `kanban_set_subtask` | change cards; an update keeps every field it is not given |
| `kanban_archive_card`, `kanban_restore_card` | archive and undo it |
| `kanban_create_board` | add a board, or get the one with that name |

There is no tool to delete a card, a column or a board; that stays in the
browser.

The pages are read as the commit the cluster runs renders them, and the tests
read pages recorded from that commit (`test/fixtures/kanban`). Record them
again when the board moves to another commit.

The board refuses a cross-site browser post. A request from a server carries
no `Sec-Fetch-Site` and no `Origin`, so the gateway's posts go through; the
board's NetworkPolicy is what decides who may reach it. A board that reads
the signed-in user from a header (upstream's `AUTH_HEADER`) gets
`KANBAN_AS` in the header `KANBAN_USER_HEADER` on every request.

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
| `NTFY_URL`, `NTFY_TOPIC`, `NTFY_TOKEN_FILE` | | where held calls are pushed; without `NTFY_URL`, no pushes |
| `NOTIFY_STATE_FILE` | `$DATA_DIR/notified.json` | which held calls were pushed already |
| `STATE_DIR` | | where the UI keeps the favourite chores; without it there are none |

`aemtli mcp-gateway`: `MCP_COMMAND` (the server's argv as JSON),
`POLICY_FILE`, `ADMIN_TOKEN_FILE` (at least 16 characters), `STATE_DIR`
(`/state`), `PORT` (8080, for agents), `ADMIN_PORT` (8081, for the UI). Every
other variable passes through to the MCP server, which is how it gets its
credentials.

`aemtli mcp-kanban`: `KANBAN_URL` (the board inside the cluster, e.g.
`http://kanban.kanban.svc.cluster.local:17808`), and for a board that reads
the user from a header, `KANBAN_AS` and `KANBAN_USER_HEADER`.

`aemtli model-proxy`: `MODEL_UPSTREAM` (`https://api.anthropic.com`),
`MODEL_AUTH_HEADER` (`x-api-key`; `authorization` for OpenAI-style APIs),
`MODEL_AUTH_PREFIX` ("Bearer " with its space, for those), `MODEL_KEY_FILE`
(`/secrets/model/key`), `MODEL_ALLOW_PATHS` (`/v1/`).

`aemtli job`: `RECIPES_DIR`, `DATA_DIR`, `AEMTLI_TRIGGER`, `AEMTLI_KEEP_RUNS`,
`MCP_GATEWAYS` (JSON: `{"epost":"http://aemtli-mcp-epost:8080/mcp"}`),
`ANTHROPIC_HOST` with a placeholder `ANTHROPIC_API_KEY` for the proxy, and
for `ctx.notify` the same `NTFY_URL`, `NTFY_TOPIC` and `NTFY_TOKEN_FILE` the
UI uses, plus `PUBLIC_ORIGIN` for the link a push carries.

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
