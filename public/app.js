import { addCopyButtons } from './copy.js';
import { registerServiceWorker } from './install.js';
import { autoRefresh } from './refresh.js';

// The page as the server sent it, read before anything below changes it
// (copy buttons, the search filter), so refresh.js can tell news from that.
const served = document.querySelector('main')?.innerHTML ?? '';

registerServiceWorker();

// "Run now" buttons on the dashboard and the recipe page. The server checks
// that the request is same-origin; this only has to make it and say how it went.
const notice = document.getElementById('notice');

// The run's answer, goose's log and a held call's long arguments.
addCopyButtons(document.querySelector('main') ?? document.body);

// Only shown on the home-screen app, which has no reload button of its own.
for (const button of document.querySelectorAll('button.reload')) button.addEventListener('click', () => location.reload());

for (const button of document.querySelectorAll('button.run')) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    const recipe = button.dataset.recipe;
    try {
      const res = await fetch(`/api/recipes/${encodeURIComponent(recipe)}/run`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (notice) notice.textContent = res.ok ? `Started ${recipe}. The page shows how it went once it is done.` : `${recipe} did not start: ${body.error ?? res.status}`;
    } catch (err) {
      if (notice) notice.textContent = `${recipe} did not start: ${err.message}`;
      button.disabled = false;
    }
  });
}

// Approve and Reject on held calls. The gateway runs an approved call before
// it answers, so the outcome shown is what actually happened. Once decided,
// the card says so: its status, what came back, and no buttons any more.
const DECIDED = { done: ['Done', 'succeeded'], failed: ['Failed', 'failed'], rejected: ['Rejected', 'none'], decided: ['Decided', 'none'] };

/** A call's result as text, JSON laid out over lines. */
function readable(result) {
  const text = String(result ?? '');
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Turns a held call's card into a decided one. */
function settle(card, status, result) {
  card.classList.add('decided');
  card.querySelector('.say')?.remove();
  card.querySelector('.decide')?.remove();
  const [word, tone] = DECIDED[status] ?? [status, 'none'];
  let chip = card.querySelector('.ask .status');
  if (!chip) {
    chip = document.createElement('span');
    card.querySelector('.ask')?.append(' ', chip);
  }
  chip.className = `status ${tone}`;
  chip.textContent = word;
  if (result) {
    const pre = document.createElement('pre');
    pre.className = 'call-result';
    pre.textContent = readable(result).slice(0, 20_000);
    card.querySelector('.outcome').after(pre);
    addCopyButtons(card);
  }
}

for (const button of document.querySelectorAll('button.approve, button.reject')) {
  button.addEventListener('click', async () => {
    const card = button.closest('li');
    const outcome = card.querySelector('.outcome');
    const verb = button.classList.contains('approve') ? 'approve' : 'reject';
    const say = card.querySelector('.say-text')?.value.trim() ?? '';
    const chat = card.querySelector('.say-chat')?.value ?? '';
    for (const b of card.querySelectorAll('.decide button')) b.disabled = true;
    outcome.textContent = verb === 'approve' ? 'Running…' : 'Rejecting…';
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(button.dataset.gateway)}/${encodeURIComponent(button.dataset.id)}/${verb}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(say ? { say, chat } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        outcome.textContent = 'Someone already decided this one. The page shows how in a moment.';
        settle(card, 'decided');
        return;
      }
      if (res.status === 502) outcome.textContent = 'No answer yet. It may still be running: look on the Approvals page in a minute before trying again.';
      else if (!res.ok) outcome.textContent = `That did not work: ${body.error ?? res.status}`;
      else {
        const result = body.status === 'rejected' ? '' : String(body.result ?? '').trim();
        if (body.status === 'rejected') outcome.textContent = 'Nothing ran.';
        else if (body.status === 'done') outcome.textContent = result ? 'What came back:' : 'Done, with nothing to show.';
        else outcome.textContent = result ? 'It failed. What came back:' : 'It failed, without saying why.';
        if (say && body.said) outcome.textContent += ' goose was told.';
        else if (say && body.sayError) outcome.textContent += ` goose was not told: ${body.sayError}`;
        settle(card, body.status, result);
      }
    } catch {
      // The connection dropped; the call may have run anyway. Not offering the
      // buttons again keeps it from running twice.
      outcome.textContent = 'No answer. It may have run: look on the Approvals page before trying again.';
    }
  });
}

// "Ask goose" under a run: the question goes to the server, which puts the
// run in front of it, and the chat page opens on the answer as it comes.
const ask = document.getElementById('ask');
if (ask) {
  const text = document.getElementById('ask-text');
  const where = document.getElementById('ask-chat');
  const button = document.getElementById('ask-send');
  const outcome = document.getElementById('ask-outcome');
  ask.addEventListener('submit', async event => {
    event.preventDefault();
    const question = text.value.trim();
    if (!question) return;
    button.disabled = true;
    outcome.textContent = 'Asking…';
    try {
      const res = await fetch(`/api/recipes/${encodeURIComponent(ask.dataset.recipe)}/runs/${encodeURIComponent(ask.dataset.run)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: question, chat: where.value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 409 ? 'goose is still answering in that conversation. Pick another one, or wait a moment.' : body.error ?? res.status);
      outcome.textContent = 'Asked. Opening the chat…';
      location.href = `/chat#${encodeURIComponent(body.chat)}`;
    } catch (err) {
      outcome.textContent = `Not asked: ${err.message}`;
      button.disabled = false;
    }
  });
}

// The conversations a word to goose can go to, named in every note box on
// the page. Without the chat there are no boxes and nothing to fill.
const sayWheres = document.querySelectorAll('.say-chat');
if (sayWheres.length) {
  fetch('/api/chats').then(r => (r.ok ? r.json() : { chats: [] })).then(({ chats = [] }) => {
    for (const where of sayWheres) {
      for (const c of chats.slice(0, 20)) {
        const option = document.createElement('option');
        option.value = c.id;
        option.textContent = c.title || 'Untitled';
        where.append(option);
      }
    }
  }).catch(() => {});
}

// Search and favourites on the overview. The search only hides rows; the
// stars are kept on the server, so every device shows the same ones.
const find = document.getElementById('find');
const onlyFav = document.getElementById('only-fav');
const none = document.getElementById('none');
const rows = [...document.querySelectorAll('li.chore')];

/** Shows the rows that match the search and, if asked, are favourites. */
function filter() {
  const words = (find?.value ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const favsOnly = onlyFav?.getAttribute('aria-pressed') === 'true';
  let shown = 0;
  for (const row of rows) {
    const text = row.dataset.search ?? '';
    const show = words.every(w => text.includes(w)) && (!favsOnly || row.dataset.fav === '1');
    row.hidden = !show;
    if (show) shown += 1;
  }
  if (none) none.hidden = shown > 0 || !rows.length;
}

/** The favourites filter is remembered on this device, the search is not. */
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* a private window: fine */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

if (find) {
  find.addEventListener('input', filter);
  find.addEventListener('keydown', event => {
    if (event.key === 'Escape') { find.value = ''; filter(); }
  });
  // "/" goes to the search box, as on most sites, unless one is typing already.
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      find.focus();
    }
  });
}
if (onlyFav) {
  if (recall('aemtli.onlyFav') === 'true') onlyFav.setAttribute('aria-pressed', 'true');
  onlyFav.addEventListener('click', () => {
    const on = onlyFav.getAttribute('aria-pressed') !== 'true';
    onlyFav.setAttribute('aria-pressed', String(on));
    remember('aemtli.onlyFav', String(on));
    filter();
  });
}
filter();

for (const star of document.querySelectorAll('button.fav')) {
  star.addEventListener('click', async () => {
    const on = star.getAttribute('aria-pressed') !== 'true';
    star.disabled = true;
    try {
      const res = await fetch(`/api/favorites/${encodeURIComponent(star.dataset.recipe)}/${on ? 'on' : 'off'}`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.status);
      star.setAttribute('aria-pressed', String(on));
      star.textContent = on ? '★' : '☆';
      star.title = on ? 'A favourite' : 'Make it a favourite';
      const row = star.closest('li.chore');
      if (on) row.dataset.fav = '1';
      else delete row.dataset.fav;
      filter();
    } catch (err) {
      if (notice) notice.textContent = `The star did not stick: ${err.message}`;
    } finally {
      star.disabled = false;
    }
  });
}

autoRefresh(served);
