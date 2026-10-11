// HTML for the four pages. Server-rendered, no framework: every value that
// came from a recipe, a run or the cluster goes through `esc`, and the only
// scripts are the two files in public/, which the Content-Security-Policy in
// server.mjs pins to this origin.

/** Escapes text for HTML element content and attribute values. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** A timestamp as "2026-10-11 08:13" in the given zone, or an em space. */
export function when(iso, timeZone = 'Europe/Zurich') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'short' }).format(d);
}

/** "3m 12s" for a duration in milliseconds. */
export function duration(ms) {
  if (typeof ms !== 'number') return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The status of a run as a small coloured label. */
function badge(status) {
  return status ? `<span class="badge ${esc(status)}">${esc(status)}</span>` : '<span class="muted">never ran</span>';
}

/** The frame every page shares. */
export function layout({ title, user, version, body, script }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ämtli</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header>
  <a class="brand" href="/">ämtli</a>
  <nav><a href="/">Chores</a><a href="/chat">Chat</a></nav>
  <span class="user">${esc(user ?? '')}</span>
</header>
<main>
${body}
</main>
<footer>ämtli ${esc(version)} · goose recipes on a schedule</footer>
${script ? `<script type="module" src="/static/${esc(script)}"></script>` : ''}
</body>
</html>`;
}

/** The dashboard: one row per recipe CronJob. */
export function dashboard(items) {
  if (!items.length) {
    return `<h1>Chores</h1><p class="muted">No CronJob carries the label <code>app.kubernetes.io/part-of=aemtli</code> yet.</p>`;
  }
  const rows = items.map(it => `<tr>
  <td><a href="/recipes/${esc(it.name)}"><strong>${esc(it.title)}</strong></a><div class="muted">${esc(it.description)}</div></td>
  <td><code>${esc(it.schedule)}</code><div class="muted">${esc(it.timeZone)}${it.suspended ? ' · paused' : ''}</div></td>
  <td>${it.suspended ? '<span class="muted">paused</span>' : esc(when(it.nextRun))}</td>
  <td>${it.running ? '<span class="badge running">running</span>' : badge(it.lastRun?.status)}
      ${it.lastRun ? `<div class="muted"><a href="/recipes/${esc(it.name)}/runs/${esc(it.lastRun.id)}">${esc(when(it.lastRun.startedAt))}</a></div>` : ''}</td>
  <td><button class="run" data-recipe="${esc(it.name)}"${it.running ? ' disabled' : ''}>Run now</button></td>
</tr>`).join('\n');
  return `<h1>Chores</h1>
<table class="chores">
<thead><tr><th>Recipe</th><th>Schedule</th><th>Next run</th><th>Last run</th><th></th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p id="notice" class="muted" role="status"></p>`;
}

/** One recipe: what it is and its recent runs. */
export function recipePage(item, runs) {
  const rows = runs.map(r => `<tr>
  <td><a href="/recipes/${esc(item.name)}/runs/${esc(r.id)}">${esc(when(r.startedAt))}</a></td>
  <td>${badge(r.status)}</td><td>${esc(r.trigger)}</td><td>${esc(duration(r.durationMs))}</td>
  <td>${esc(r.tokens?.total ?? '')}</td>
</tr>`).join('\n');
  return `<h1>${esc(item.title)}</h1>
<p>${esc(item.description)}</p>
<p class="muted"><code>${esc(item.schedule)}</code> ${esc(item.timeZone)} · next ${esc(when(item.nextRun))}</p>
<p><button class="run" data-recipe="${esc(item.name)}">Run now</button> <span id="notice" class="muted" role="status"></span></p>
${runs.length ? `<table><thead><tr><th>Started</th><th>Status</th><th>Trigger</th><th>Took</th><th>Tokens</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">No runs yet.</p>'}`;
}

/** One run: its answer, its numbers and the tail of its log. */
export function runPage(run, result, log) {
  return `<h1>${esc(run.recipe)} <span class="muted">${esc(when(run.startedAt))}</span></h1>
<p>${badge(run.status)} · ${esc(run.trigger)} · ${esc(duration(run.durationMs))} · ${esc(run.model ?? '')} · ${esc(run.tokens?.total ?? 0)} tokens</p>
${run.error ? `<p class="error">${esc(run.error)}</p>` : ''}
<h2>Result</h2>
<pre class="result">${esc(result) || '<span class="muted">(empty)</span>'}</pre>
<details><summary>Log</summary><pre class="log">${esc(log.slice(-20_000))}</pre></details>
<p><a href="/recipes/${esc(run.recipe)}">All runs of ${esc(run.recipe)}</a></p>`;
}

/** The chat page; public/chat.js does the talking. `cwd` is goose's working directory. */
export function chatPage(cwd) {
  return `<h1>Chat</h1>
<div class="chat-bar">
  <label>Mode
    <select id="mode">
      <option value="smart_approve" selected>ask for sensitive tools</option>
      <option value="approve">ask for every tool</option>
      <option value="auto">never ask</option>
      <option value="chat">no tools</option>
    </select>
  </label>
  <button id="new">New session</button>
  <span id="state" class="muted" role="status">connecting…</span>
</div>
<div id="log" class="chat" aria-live="polite" data-cwd="${esc(cwd)}"></div>
<form id="form" class="composer">
  <textarea id="input" rows="3" placeholder="Ask goose…" required></textarea>
  <div><button type="submit" id="send">Send</button> <button type="button" id="cancel" disabled>Stop</button></div>
</form>`;
}
