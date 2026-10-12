// The chat page. The web server holds the conversation with goose; this
// page lists the conversations, shows one through a stream it can lose and
// pick up again, and sends what is typed. Closing the page stops nothing:
// a turn goes on, and a question waits until it is answered here or on
// another device. goose's answers come as HTML the server rendered from their
// Markdown, with raw HTML and script links already refused there; everything
// else is set with textContent only.

const list = document.getElementById('chats');
const log = document.getElementById('log');
const form = document.getElementById('form');
const input = document.getElementById('input');
const send = document.getElementById('send');
const cancel = document.getElementById('cancel');
const mode = document.getElementById('mode');
const state = document.getElementById('state');
const fresh = document.getElementById('new');
const showArchived = document.getElementById('show-archived');
const archiveButton = document.getElementById('archive');
const deleteButton = document.getElementById('delete');
const heading = document.getElementById('chat-title');

let current = null;
let stream = null;
let events = [];
let status = 'idle';
// Counts the turns of the open conversation, so a listing that started
// before one cannot say anything about it.
let turns = 0;
// Which conversations are put away, as the last listing said.
let away = new Set();

const STATE_WORDS = { idle: 'Ready.', running: 'goose is working. You can close the page; it keeps going.', waiting: 'goose asks before going on.' };
const OPTION_LABELS = { allow_once: 'Allow once', allow_always: 'Always allow', reject_once: 'Reject', reject_always: 'Always reject' };
const OPTION_ORDER = ['allow_once', 'reject_once', 'allow_always', 'reject_always'];

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

/** "3 min ago", "yesterday", "12 Oct" for a time in the list. */
function ago(iso) {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  if (minutes < 48 * 60) return 'yesterday';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** The two buttons that act on the conversation that is open. */
function showActions(title) {
  archiveButton.disabled = !current;
  deleteButton.disabled = !current;
  archiveButton.textContent = current && away.has(current) ? 'Put back' : 'Archive';
  deleteButton.dataset.title = title ?? '';
}

/** The list of conversations, newest first; the open one marked. */
async function refreshList() {
  const asked = { id: current, turn: turns };
  let chats;
  try {
    ({ chats } = await api('/api/chats'));
  } catch (err) {
    state.textContent = `The conversations could not be listed: ${err.message}`;
    return;
  }
  away = new Set(chats.filter(c => c.archived).map(c => c.id));
  showArchived.parentElement.hidden = !away.size;
  showArchived.parentElement.lastChild.textContent = away.size === 1 ? ' Show 1 archived' : ` Show ${away.size} archived`;
  const open = chats.find(c => c.id === current);
  showActions(open?.title);
  adoptIdle(open, asked);
  const shown = chats.filter(c => !away.has(c.id) || showArchived.checked || c.id === current);
  list.replaceChildren(...shown.map(c => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${encodeURIComponent(c.id)}`;
    a.className = `chat-item${c.id === current ? ' open' : ''}${c.archived ? ' archived' : ''}`;
    if (c.id === current) a.setAttribute('aria-current', 'true');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = c.title || 'Untitled';
    const meta = document.createElement('span');
    meta.className = `meta ${c.status}`;
    meta.textContent = c.status === 'running' ? 'working' : c.status === 'waiting' ? 'asks you' : `${c.archived ? 'archived · ' : ''}${ago(c.updatedAt)}`;
    a.append(title, meta);
    li.append(a);
    return li;
  }));
  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'quiet';
    li.textContent = chats.length ? 'Nothing but archived conversations.' : 'No conversations yet.';
    list.append(li);
  }
}

/** One event as an element. */
function render(e, index) {
  const el = document.createElement('div');
  el.dataset.index = index;
  if (e.type === 'tool') {
    el.className = 'msg tool';
    el.dataset.status = e.status;
    el.textContent = `${e.title} (${e.status})`;
  } else if (e.type === 'question') {
    el.className = 'msg permission';
    el.textContent = `goose wants to run: ${e.title}`;
    if (e.answer) {
      const said = document.createElement('p');
      said.className = 'answered';
      said.textContent = `Answered: ${OPTION_LABELS[e.answer] ?? e.answer}`;
      el.append(said);
    }
  } else if (e.type === 'agent' && typeof e.html === 'string') {
    el.className = 'msg agent md';
    el.innerHTML = e.html;
  } else {
    el.className = `msg ${e.type}`;
    el.textContent = e.text ?? '';
  }
  return el;
}

/** The question that waits, with its buttons, under the last event. */
function renderQuestion(question) {
  log.querySelector('.choices')?.remove();
  if (!question) return;
  const box = log.querySelector(`[data-index="${Number(question.index)}"]`) ?? log.lastElementChild;
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'choices';
  for (const o of [...question.options].sort((a, b) => OPTION_ORDER.indexOf(a.kind) - OPTION_ORDER.indexOf(b.kind))) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = OPTION_LABELS[o.kind] ?? o.name;
    b.className = o.kind?.startsWith('reject') ? 'quiet-button' : '';
    b.addEventListener('click', async () => {
      for (const x of row.querySelectorAll('button')) x.disabled = true;
      try {
        await api(`/api/chats/${encodeURIComponent(current)}/answer`, { method: 'POST', body: { option: o.id } });
      } catch (err) {
        state.textContent = `The answer did not go through: ${err.message}`;
        for (const x of row.querySelectorAll('button')) x.disabled = false;
      }
    });
    row.append(b);
  }
  box.append(row);
}

function showStatus(next, question) {
  if (next === 'running' && status !== 'running') turns += 1;
  status = next;
  state.textContent = STATE_WORDS[status] ?? status;
  send.disabled = status !== 'idle';
  cancel.disabled = status === 'idle';
  renderQuestion(question);
}

/**
 * What the list says about the open conversation. A stream that dropped
 * leaves the page thinking a turn is still running, and then nothing can be
 * typed; the listing is the second opinion that frees the composer again.
 * Only towards idle: a turn that is running must not be talked over.
 */
function adoptIdle(listed, asked) {
  if (asked.id !== current || asked.turn !== turns) return;
  if (listed && listed.status === 'idle' && status !== 'idle') showStatus('idle', null);
}

function drawAll(question) {
  log.replaceChildren(...events.map(render));
  showStatus(status, question);
  log.scrollTop = log.scrollHeight;
}

/** Opens one conversation and follows it. */
function open(id) {
  stream?.close();
  current = id;
  events = [];
  turns += 1;
  log.replaceChildren();
  mode.disabled = !id;
  showActions();
  if (!id) {
    heading.textContent = 'Chat with goose';
    state.textContent = 'Pick a conversation or start one.';
    send.disabled = false;
    return;
  }
  state.textContent = 'Loading…';
  stream = new EventSource(`/api/chats/${encodeURIComponent(id)}/events`);
  stream.onmessage = message => {
    const m = JSON.parse(message.data);
    if (m.kind === 'snapshot') {
      events = m.events;
      status = m.status;
      if (m.mode) mode.value = m.mode;
      heading.textContent = m.title || 'Chat with goose';
      drawAll(m.question);
    } else if (m.kind === 'event') {
      events.push(m.event);
      log.append(render(m.event, events.length - 1));
      log.scrollTop = log.scrollHeight;
    } else if (m.kind === 'append') {
      events[m.index].text += m.text;
      const el = log.querySelector(`[data-index="${m.index}"]`);
      // An answer already drawn from Markdown waits for its next drawing;
      // one that is not shows its text as it grows.
      if (el && !el.classList.contains('md')) el.textContent = events[m.index].text;
      log.scrollTop = log.scrollHeight;
    } else if (m.kind === 'replace') {
      events[m.index] = m.event;
      log.querySelector(`[data-index="${m.index}"]`)?.replaceWith(render(m.event, m.index));
    } else if (m.kind === 'status') {
      showStatus(m.status, m.question);
      if (m.status === 'idle') refreshList();
    }
  };
  // The browser reconnects on its own; the snapshot that follows puts the
  // page back in step with what happened meanwhile. A conversation that is
  // gone answers 404, and then the browser stops trying.
  const mine = stream;
  mine.onerror = () => {
    state.textContent = mine.readyState === EventSource.CLOSED
      ? 'This conversation could not be opened. It may have been deleted.'
      : 'Reconnecting… goose keeps working meanwhile.';
    // The listing still answers, and it says whether the turn is over.
    refreshList();
  };
  refreshList();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  send.disabled = true;
  try {
    if (!current) {
      const { id } = await api('/api/chats', { method: 'POST', body: { mode: mode.value } });
      location.hash = encodeURIComponent(id);
      open(id);
    }
    await api(`/api/chats/${encodeURIComponent(current)}/say`, { method: 'POST', body: { text } });
    input.value = '';
  } catch (err) {
    state.textContent = `Not sent: ${err.message}`;
    send.disabled = false;
  }
});

input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) form.requestSubmit();
});

cancel.addEventListener('click', async () => {
  try {
    await api(`/api/chats/${encodeURIComponent(current)}/stop`, { method: 'POST', body: {} });
  } catch (err) {
    state.textContent = `Could not stop: ${err.message}`;
  }
});

mode.addEventListener('change', async () => {
  if (!current) return;
  try {
    await api(`/api/chats/${encodeURIComponent(current)}/mode`, { method: 'POST', body: { mode: mode.value } });
  } catch (err) {
    state.textContent = `The setting did not change: ${err.message}`;
  }
});

fresh.addEventListener('click', () => {
  location.hash = '';
  open(null);
  mode.disabled = false;
  input.focus();
  refreshList();
});

archiveButton.addEventListener('click', async () => {
  if (!current) return;
  archiveButton.disabled = true;
  try {
    await api(`/api/chats/${encodeURIComponent(current)}/archive`, { method: 'POST', body: { archived: !away.has(current) } });
    await refreshList();
  } catch (err) {
    state.textContent = `Not changed: ${err.message}`;
    archiveButton.disabled = false;
  }
});

deleteButton.addEventListener('click', async () => {
  if (!current) return;
  const what = deleteButton.dataset.title || 'this conversation';
  if (!window.confirm(`Delete “${what}”? The whole conversation goes, at goose as well, and that cannot be undone.`)) return;
  deleteButton.disabled = true;
  try {
    await api(`/api/chats/${encodeURIComponent(current)}`, { method: 'DELETE' });
    location.hash = '';
    open(null);
    await refreshList();
  } catch (err) {
    state.textContent = `Not deleted: ${err.message}`;
    deleteButton.disabled = false;
  }
});

showArchived.addEventListener('change', refreshList);

window.addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id !== (current ?? '')) open(id || null);
});

open(decodeURIComponent(location.hash.slice(1)) || null);
mode.disabled = false;
refreshList();
setInterval(refreshList, 30_000);
