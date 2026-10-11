// HTML for the pages. Server-rendered, no framework: every value that came
// from a recipe, a run or the cluster goes through `esc` (or, for a run's
// result, through the Markdown renderer, which allows no raw HTML), and the
// only scripts are the two files in public/, pinned by the CSP in server.mjs.
//
// The dashboard is an Ämtliplan, the weekly chore chart of a Swiss
// household: one row per chore, one column per day, a tick where it was
// done and a red stroke where it was not.

import { toolWords } from './approvals.mjs';

/** Escapes text for HTML element content and attribute values. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Formats an instant in `timeZone` with the given Intl options (en-GB). */
function fmt(date, timeZone, options) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', ...options }).format(date);
}

/** "Mon 12 Oct, 08:13", or an empty string for no date. */
export function when(iso, timeZone = 'UTC') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return fmt(d, timeZone, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(/,(?= \d{2}:)/, ',');
}

/** "08:13" for an instant. */
function hm(date, timeZone) {
  return fmt(date, timeZone, { hour: '2-digit', minute: '2-digit' });
}

/** "3m 12s" for a duration in milliseconds. */
export function duration(ms) {
  if (typeof ms !== 'number') return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const STATUS_WORDS = { succeeded: 'Done', failed: 'Failed', cancelled: 'Stopped', running: 'Running' };

/** A run's status as a word with its colour. */
function status(value) {
  if (!value) return '<span class="status none">Not run yet</span>';
  return `<span class="status ${esc(value)}">${esc(STATUS_WORDS[value] ?? value)}</span>`;
}

/** The frame every page shares. `active` marks the current section in the nav. */
export function layout({ title, user, version, body, script, active }) {
  const nav = (href, label, key) => `<a href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} – ämtli</title>
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="preload" href="/static/fonts/schibsted-grotesk.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header class="top">
  <a class="wordmark" href="/">ämtli</a>
  <nav>${nav('/', 'Chores', 'chores')}${nav('/approvals', 'Approvals', 'approvals')}${nav('/chat', 'Chat', 'chat')}</nav>
  <span class="who">${esc(user ?? '')}</span>
</header>
<main>
${body}
</main>
<footer>ämtli ${esc(version)}, goose recipes on a schedule</footer>
${script ? `<script type="module" src="/static/${esc(script)}"></script>` : ''}
</body>
</html>`;
}

/**
 * Up to three marks of one kind, or a count when there are more. `label`
 * says what the mark is for screen readers; the time is what shows.
 */
function slots(kind, times, label, timeZone) {
  if (times.length > 3) return [`<span class="${kind} many">${times.length}× <span class="word">${esc(label.toLowerCase())}</span></span>`];
  return times.map(at => `<span class="${kind}"><span class="visually-hidden">${esc(label)} at </span>${esc(hm(at, timeZone))}</span>`);
}

/** One cell of the week chart: what ran, what did not, and what is still due. */
function weekCell(cell, timeZone) {
  const marks = [];
  for (const run of cell.runs.slice(0, 3)) {
    const sign = { succeeded: '✓', failed: '✗', cancelled: '✗', running: '…' }[run.status] ?? '?';
    const label = `${STATUS_WORDS[run.status] ?? run.status} at ${hm(new Date(run.startedAt), timeZone)}`;
    marks.push(`<a class="mark ${esc(run.status)}" href="/recipes/${esc(run.recipe)}/runs/${esc(run.id)}" title="${esc(label)}" aria-label="${esc(label)}">${sign}<span class="t">${esc(hm(new Date(run.startedAt), timeZone))}</span></a>`);
  }
  if (cell.runs.length > 3) marks.push(`<span class="more">+${cell.runs.length - 3} more</span>`);
  marks.push(...slots('missed', cell.missed, 'Did not run', timeZone), ...slots('due', cell.planned, 'Due', timeZone));
  return `<td${cell.today ? ' class="today"' : ''}>${marks.join('')}</td>`;
}

/** The Ämtliplan: this week, one row per chore. */
function weekChart(week, items, timeZone) {
  const head = week.days.map(d => `<th scope="col"${d.today ? ' class="today" aria-current="date"' : ''}><span class="dow">${esc(fmt(d.start, timeZone, { weekday: 'short' }))}</span><span class="dom">${esc(fmt(d.start, timeZone, { day: 'numeric' }))}</span></th>`).join('');
  const rows = items.map(it => `<tr>
  <th scope="row"><a href="/recipes/${esc(it.name)}">${esc(it.title)}</a>${it.suspended ? '<span class="paused">paused</span>' : ''}</th>
  ${it.week.map(cell => weekCell(cell, timeZone)).join('')}
</tr>`).join('\n');
  const range = `${fmt(week.days[0].start, timeZone, { day: 'numeric', month: 'short' })} to ${fmt(week.days[6].start, timeZone, { day: 'numeric', month: 'short' })}`;
  return `<section class="plan" aria-labelledby="plan-title">
<div class="plan-head"><h1 id="plan-title">This week</h1><p>${esc(range)}</p></div>
<div class="grid-wrap"><table class="grid">
<thead><tr><td></td>${head}</tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
</section>`;
}

/** The chores in the order they come up next. */
function comingUp(items, timeZone) {
  const ordered = [...items].sort((a, b) => (a.nextRun ?? '9999').localeCompare(b.nextRun ?? '9999'));
  const rows = ordered.map(it => `<li class="chore">
  <div class="next">${it.suspended || !it.nextRun ? '<span class="never">Only by hand</span>' : `<span class="day">${esc(fmt(new Date(it.nextRun), timeZone, { weekday: 'short', day: 'numeric', month: 'short' }))}</span><span class="time">${esc(hm(new Date(it.nextRun), timeZone))}</span>`}</div>
  <div class="what">
    <a class="name" href="/recipes/${esc(it.name)}">${esc(it.title)}</a>
    <p class="desc">${esc(it.description)}</p>
    <p class="sched" title="${esc(it.schedule)} (${esc(it.timeZone)})">${esc(it.suspended ? `Paused. Normally ${it.scheduleText.replace(/^(Every|On|Weekdays|Weekends)\b/, w => w.toLowerCase())}` : it.scheduleText)}</p>
  </div>
  <div class="last"><span class="label">Last run</span>${it.running ? status('running') : status(it.lastRun?.status)}${it.lastRun ? `<a href="/recipes/${esc(it.name)}/runs/${esc(it.lastRun.id)}">${esc(when(it.lastRun.startedAt, timeZone))}</a>` : ''}</div>
  <div class="act"><button class="run quiet-button" data-recipe="${esc(it.name)}"${it.running ? ' disabled' : ''}>Run now</button></div>
</li>`).join('\n');
  return `<section aria-labelledby="up-title"><h2 id="up-title">Coming up</h2><ul class="chores">
${rows}
</ul><p id="notice" class="notice" role="status"></p></section>`;
}

const REQUEST_WORDS = { pending: 'Waiting', running: 'Running', done: 'Done', failed: 'Failed', rejected: 'Rejected', expired: 'Expired' };
const REQUEST_CLASS = { pending: 'running', running: 'running', done: 'succeeded', failed: 'failed', rejected: 'none', expired: 'none' };

/**
 * Text as it will run, with nothing hidden: characters that render as nothing
 * or reorder what follows (zero-width, bidi controls, other controls) are
 * written out as their code point, so what the owner reads is what executes.
 */
export function visible(text) {
  return esc(String(text)).replace(/(?![\n\t])[\p{Cc}\p{Cf}\p{Variation_Selector}\u115f\u1160\u3164\uffa0]/gu,
    c => `<span class="hidden-char">U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}</span>`);
}

/** One argument of a held call, whole: short values inline, the rest as a block. */
function argValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.includes('\n') || text.length > 120 ? `<pre>${visible(text)}</pre>` : visible(text);
}

/** Every argument of a held call, in full: the owner approves exactly what runs. */
function argList(args) {
  const entries = Object.entries(args ?? {});
  if (!entries.length) return '<p class="quiet">No arguments.</p>';
  return `<dl class="args">${entries.map(([k, v]) => `<div><dt>${visible(k)}</dt><dd>${argValue(v)}</dd></div>`).join('')}</dl>`;
}

/** Gateways that could not be asked. */
function unreachableNote(unreachable) {
  return unreachable.map(u => `<p class="down">Could not ask ${esc(u.title)}: ${esc(u.error)}.</p>`).join('');
}

/** Calls the gateways hold for the owner, each with Approve and Reject. */
export function needsYou({ items, unreachable }, timeZone) {
  if (!items.length && !unreachable.length) return '';
  const cards = items.map(r => `<li class="request">
  <p class="ask"><span class="gw">${esc(r.gatewayTitle)}</span> wants to <strong>${esc(toolWords(r.tool, r.gateway))}</strong> <code class="tool">${visible(r.tool)}</code></p>
  ${argList(r.arguments)}
  <p class="asked">Asked ${esc(when(r.requestedAt, timeZone))}</p>
  <div class="decide"><button class="approve" data-gateway="${esc(r.gateway)}" data-id="${esc(r.id)}">Approve</button><button class="reject quiet-button" data-gateway="${esc(r.gateway)}" data-id="${esc(r.id)}">Reject</button></div>
  <p class="outcome" role="status"></p>
</li>`).join('\n');
  return `<section class="needs" id="needs" aria-labelledby="needs-title">
${items.length ? `<h2 id="needs-title">Needs you</h2><ul class="requests">\n${cards}\n</ul>` : '<h2 id="needs-title" class="visually-hidden">Gateways</h2>'}
${unreachableNote(unreachable)}
</section>`;
}

/** Every held call the gateways remember, decided or not. */
export function approvalsPage({ items, unreachable }, configured, timeZone) {
  if (!configured) {
    return `<section class="empty"><h1>No gateways yet</h1>
<p>A gateway serves one MCP server to the agents and holds the calls that need your approval. Set <code>GATEWAYS</code> to list them, as the README describes.</p></section>`;
  }
  const rows = items.slice(0, 100).map(r => `<li class="${r.status === 'pending' ? 'request' : 'decided'}">
  <p class="ask"><span class="gw">${esc(r.gatewayTitle)}</span> <strong>${esc(toolWords(r.tool, r.gateway))}</strong> <code class="tool">${visible(r.tool)}</code> <span class="status ${esc(REQUEST_CLASS[r.status] ?? 'none')}">${esc(REQUEST_WORDS[r.status] ?? r.status)}</span></p>
  <p class="asked">Asked ${esc(when(r.requestedAt, timeZone))}${r.decidedAt ? `, decided ${esc(when(r.decidedAt, timeZone))}` : ''}</p>
  <details><summary>What it asked for${r.result ? ' and what came back' : ''}</summary>${argList(r.arguments)}${r.result ? `<pre class="result">${esc(r.result)}</pre>` : ''}</details>
  ${r.status === 'pending' ? `<div class="decide"><button class="approve" data-gateway="${esc(r.gateway)}" data-id="${esc(r.id)}">Approve</button><button class="reject quiet-button" data-gateway="${esc(r.gateway)}" data-id="${esc(r.id)}">Reject</button></div><p class="outcome" role="status"></p>` : ''}
</li>`).join('\n');
  return `<section class="approvals">
<h1>Approvals</h1>
<p class="lede">What the agents asked to do that waits for you, or waited: sending, deleting, anything with money.</p>
${unreachableNote(unreachable)}
${items.length ? `<ul class="history">\n${rows}\n</ul>` : '<p class="quiet">Nothing asked yet.</p>'}
</section>`;
}

/** The dashboard. */
export function dashboard({ items, week, timeZone, needs = { items: [], unreachable: [] } }) {
  if (!items.length) {
    return `${needsYou(needs, timeZone)}<section class="empty"><h1>No chores yet</h1>
<p>A chore is a goose recipe plus a CronJob that runs <code>aemtli run &lt;recipe&gt;</code>. Give the CronJob the label <code>app.kubernetes.io/part-of: aemtli</code> and it shows up here.</p></section>`;
  }
  return `${needsYou(needs, timeZone)}
${weekChart(week, items, timeZone)}
${comingUp(items, timeZone)}`;
}

/** One chore: what it does, when, and its runs. */
export function recipePage(item, runs, timeZone) {
  const rows = runs.map(r => `<li><a href="/recipes/${esc(item.name)}/runs/${esc(r.id)}"><span class="at">${esc(when(r.startedAt, timeZone))}</span>${status(r.status)}<span class="trigger">${esc(r.trigger === 'manual' ? 'By hand' : 'On schedule')}</span><span class="took">${esc(duration(r.durationMs))}</span></a></li>`).join('\n');
  return `<article class="recipe">
<h1>${esc(item.title)}</h1>
<p class="lede">${esc(item.description)}</p>
<dl class="facts">
  <div><dt>When</dt><dd title="${esc(item.schedule)}">${esc(item.suspended ? 'Paused, runs only by hand' : item.scheduleText)}</dd></div>
  <div><dt>Next</dt><dd>${esc(item.suspended || !item.nextRun ? 'Not scheduled' : when(item.nextRun, timeZone))}</dd></div>
</dl>
<p><button class="run" data-recipe="${esc(item.name)}"${item.running ? ' disabled' : ''}>Run now</button></p>
<p id="notice" class="notice" role="status"></p>
<h2>Runs</h2>
${runs.length ? `<ul class="runs">${rows}</ul>` : '<p class="quiet">It has not run yet. Run it now to see what it does.</p>'}
</article>`;
}

/** One run: its answer (rendered Markdown), its numbers, and its log. */
export function runPage(run, title, resultHtml, log, timeZone) {
  return `<article class="run-page">
<p class="crumb"><a href="/recipes/${esc(run.recipe)}">${esc(title)}</a></p>
<h1>${esc(when(run.startedAt, timeZone))}</h1>
<dl class="facts">
  <div><dt>Result</dt><dd>${status(run.status)}</dd></div>
  <div><dt>Started</dt><dd>${esc(run.trigger === 'manual' ? 'By hand' : 'On schedule')}</dd></div>
  <div><dt>Took</dt><dd>${esc(duration(run.durationMs))}</dd></div>
  <div><dt>Model</dt><dd>${esc(run.model ?? '')}</dd></div>
  <div><dt>Tokens</dt><dd>${esc((run.tokens?.total ?? 0).toLocaleString('en-GB'))}</dd></div>
</dl>
${run.error ? `<div class="error" role="alert"><h2>What went wrong</h2><p>${esc(run.error)}</p></div>` : ''}
<section class="result md">${resultHtml || '<p class="quiet">The run left no answer.</p>'}</section>
<details class="log"><summary>goose's log</summary><pre>${esc(log.slice(-20_000)) || 'Empty.'}</pre></details>
</article>`;
}

/** The chat page; public/chat.js does the talking. `cwd` is goose's working directory. */
export function chatPage(cwd, mcpServers = []) {
  return `<section class="chat-page">
<div class="chat-bar">
  <h1>Chat with goose</h1>
  <label>Ask before tools
    <select id="mode">
      <option value="smart_approve" selected>when they change things</option>
      <option value="approve">always</option>
      <option value="auto">never</option>
      <option value="chat">no tools at all</option>
    </select>
  </label>
  <button id="new" class="quiet-button">New conversation</button>
</div>
<p id="state" class="state" role="status">Connecting…</p>
<div id="log" class="chat" aria-live="polite" data-cwd="${esc(cwd)}" data-mcp="${esc(JSON.stringify(mcpServers))}"></div>
<form id="form" class="composer">
  <label class="visually-hidden" for="input">Message</label>
  <textarea id="input" rows="3" placeholder="Ask goose something. Cmd+Enter sends." required></textarea>
  <div class="composer-actions"><button type="submit" id="send">Send</button><button type="button" id="cancel" class="quiet-button" disabled>Stop</button></div>
</form>
</section>`;
}
