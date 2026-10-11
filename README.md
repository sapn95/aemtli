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
| `aemtli run <recipe>` | What a CronJob runs. Starts `goose run --recipe`, waits, and writes `run.json`, `result.md` and `run.log` to the shared volume. Exit 0 only if a model actually answered. |
| `aemtli web` | The dashboard (recipes, schedule, next and last run, "Run now"), the run pages, and the chat. |
| `goose serve` | The agent the chat talks to, over ACP on a WebSocket that only the web pod can reach. |
| `aemtli model-proxy` | The only holder of the model's API key. goose and the runs call the model through it with a placeholder key; it puts the real one on. |

One image holds all four: goose, node and npm (for MCP servers started with
`npx`), uv and python (for `uvx`), and the app.

```text
browser ─▶ Cloudflare Access ─▶ tunnel ─▶ aemtli-web ─┬─▶ Kubernetes API (CronJobs, Jobs)
                                                       ├─▶ volume aemtli-runs (read)
                                                       └─▶ /acp ─▶ aemtli-goose ─▶ aemtli-model-proxy ─▶ model API
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

## Security

- **Who gets in.** Cloudflare Access with GitHub login decides that at the
  edge. The UI then checks the `Cf-Access-Jwt-Assertion` token itself:
  RS256 only, signed by the team's current keys, for this application's AUD,
  not expired, and for an address in `ALLOWED_EMAILS`. A request that reached
  the pod some other way still gets a 403.
- **Cross-site.** "Run now" accepts only same-origin requests, and the chat
  WebSocket only the configured origin.
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
- **Pod security.** The example namespace enforces the `restricted` Pod
  Security Standard, so the Jobs the UI may create cannot ask for privileges.
- **The UI's own rights** are one Role: read CronJobs, list and create Jobs,
  in its namespace.
- Every page is server-rendered with escaping, behind a Content-Security-Policy
  that allows only this origin's scripts and styles.

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

`aemtli model-proxy`: `MODEL_UPSTREAM` (`https://api.anthropic.com`),
`MODEL_AUTH_HEADER` (`x-api-key`; `authorization` for OpenAI-style APIs),
`MODEL_AUTH_PREFIX` ("Bearer " with its space, for those), `MODEL_KEY_FILE`
(`/secrets/model/key`), `MODEL_ALLOW_PATHS` (`/v1/`).

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

MIT.
