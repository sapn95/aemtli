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

/** "in 20 min", "in 3 h", "tomorrow 07:00", "Mon 07:00" for a time ahead. */
function soon(iso, now, timeZone) {
  const at = new Date(iso);
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 1) return 'any moment';
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 10 * 60) return `in ${Math.round(minutes / 60)} h`;
  const day = fmt(at, timeZone, { weekday: 'short' });
  const today = fmt(now, timeZone, { weekday: 'short' });
  const tomorrow = fmt(new Date(now.getTime() + 86_400_000), timeZone, { weekday: 'short' });
  const prefix = day === today ? 'today' : day === tomorrow ? 'tomorrow' : day;
  return `${prefix} ${hm(at, timeZone)}`;
}

const MARKS = { succeeded: '✓', failed: '✗', cancelled: '✗', running: '…' };

/**
 * One day of one chore: the run that happened, or the slot that passed
 * without one, or the slot still to come. A day with runs links to the last
 * of them; `n×` says how many when there were several.
 */
function day(cell, timeZone) {
  const label = fmt(cell.start, timeZone, { weekday: 'short', day: 'numeric', month: 'short' });
  const marks = [];
  const says = [];
  if (cell.runs.length) {
    const run = cell.runs.at(-1);
    const count = cell.runs.length > 1 ? `<span class="count">${cell.runs.length}×</span>` : '';
    marks.push(`<a class="mark ${esc(run.status)}" href="/recipes/${esc(run.recipe)}/runs/${esc(run.id)}">${MARKS[run.status] ?? '?'}${count}</a>`);
    says.push(`${cell.runs.length > 1 ? `${cell.runs.length} runs, last ` : ''}${(STATUS_WORDS[run.status] ?? run.status).toLowerCase()} at ${hm(new Date(run.startedAt), timeZone)}`);
  }
  // A day can hold both: a slot that passed with nothing in it, and a run
  // somebody started by hand. Then it shows both marks.
  if (cell.missed.length) {
    marks.push('<span class="mark missed" aria-hidden="true"></span>');
    says.push(`did not run at ${cell.missed.map(at => hm(at, timeZone)).join(', ')}`);
  }
  if (cell.planned.length) {
    marks.push('<span class="mark due" aria-hidden="true"></span>');
    says.push(`due at ${cell.planned.map(at => hm(at, timeZone)).join(', ')}`);
  }
  if (!marks.length) {
    marks.push('<span class="mark none" aria-hidden="true"></span>');
    says.push('nothing');
  }
  const classes = ['day', cell.today ? 'today' : '', cell.runs.length ? 'ran' : '', cell.missed.length ? 'late' : ''];
  const title = `${label}: ${says.join(', ')}`;
  return `<li class="${classes.filter(Boolean).join(' ')}" title="${esc(title)}">
    <span class="dow" aria-hidden="true">${esc(fmt(cell.start, timeZone, { weekday: 'narrow' }))}</span>
    <span class="marks">${marks.join('')}</span>
    <span class="visually-hidden">${esc(title)}</span>
  </li>`;
}

/** The week's days as a heading row, in the column the strips sit in. */
function weekHead(week, timeZone) {
  const cells = week.days.map(d => `<li${d.today ? ' class="today"' : ''}><span class="dow">${esc(fmt(d.start, timeZone, { weekday: 'short' }))}</span> <span class="dom">${esc(fmt(d.start, timeZone, { day: 'numeric' }))}</span></li>`).join('');
  return `<div class="week-head" aria-hidden="true"><ol class="days">${cells}</ol></div>`;
}

/**
 * One chore: what it is, when it runs, its week, and what came of the last
 * run. The same markup carries the week on a phone, where it sits under the
 * name, and on a wide screen, where the strips line up into the chart.
 */
function chore(it, now, timeZone) {
  const strip = it.week.map(cell => day(cell, timeZone)).join('');
  const schedule = it.suspended
    ? `Paused. Normally ${it.scheduleText.replace(/^(Every|On|Weekdays|Weekends)\b/, w => w.toLowerCase())}`
    : it.scheduleText;
  const next = it.running
    ? 'running now'
    : it.suspended || !it.nextRun ? 'only by hand' : soon(it.nextRun, now, timeZone);
  const last = it.lastRun
    ? `<a href="/recipes/${esc(it.name)}/runs/${esc(it.lastRun.id)}">${status(it.lastRun.status)} ${esc(when(it.lastRun.startedAt, timeZone))}</a>`
    : status(null);
  return `<li class="chore">
  <div class="head">
    <a class="name" href="/recipes/${esc(it.name)}"${it.description ? ` title="${esc(it.description)}"` : ''}>${esc(it.title)}</a>
    <p class="when" title="${esc(it.schedule)} (${esc(it.timeZone)})">${esc(schedule)}</p>
  </div>
  <ol class="strip">${strip}</ol>
  <div class="meta">
    <span class="next">${esc(next)}</span>
    <span class="last">${last}</span>
  </div>
  <div class="act"><button class="run quiet-button" data-recipe="${esc(it.name)}"${it.running ? ' disabled' : ''}>Run now</button></div>
</li>`;
}

/** The Ämtliplan: every chore with its schedule and this week. */
function plan(items, week, now, timeZone) {
  const ordered = [...items].sort((a, b) => (a.nextRun ?? '9999').localeCompare(b.nextRun ?? '9999'));
  const range = `${fmt(week.days[0].start, timeZone, { day: 'numeric', month: 'short' })} to ${fmt(week.days[6].start, timeZone, { day: 'numeric', month: 'short' })}`;
  return `<section class="plan" aria-labelledby="plan-title">
<div class="plan-head"><h1 id="plan-title">This week</h1><p>${esc(range)}</p></div>
${weekHead(week, timeZone)}
<ul class="chores">
${ordered.map(it => chore(it, now, timeZone)).join('\n')}
</ul>
<p id="notice" class="notice" role="status"></p>
</section>`;
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
export function dashboard({ items, week, timeZone, now = new Date(), needs = { items: [], unreachable: [] } }) {
  if (!items.length) {
    return `${needsYou(needs, timeZone)}<section class="empty"><h1>No chores yet</h1>
<p>A chore is a goose recipe or a job, plus a CronJob that runs it. Give the CronJob the label <code>app.kubernetes.io/part-of: aemtli</code> and it shows up here.</p></section>`;
  }
  return `${needsYou(needs, timeZone)}
${plan(items, week, now, timeZone)}`;
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
