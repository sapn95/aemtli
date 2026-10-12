// The chat page. The web server holds the conversation with goose; this
// page lists the conversations, shows one through a stream it can lose and
// pick up again, and sends what is typed. Closing the page stops nothing:
// a turn goes on, and a question waits until it is answered here or on
// another device. Text from goose is set with textContent only, never HTML.

const list = document.getElementById('chats');
const log = document.getElementById('log');
const form = document.getElementById('form');
const input = document.getElementById('input');
const send = document.getElementById('send');
const cancel = document.getElementById('cancel');
const mode = document.getElementById('mode');
const state = document.getElementById('state');
const fresh = document.getElementById('new');
const heading = document.getElementById('chat-title');

let current = null;
let stream = null;
let events = [];
let status = 'idle';

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

/** The list of conversations, newest first; the open one marked. */
async function refreshList() {
  let chats;
  try {
    ({ chats } = await api('/api/chats'));
  } catch (err) {
    state.textContent = `The conversations could not be listed: ${err.message}`;
    return;
  }
  list.replaceChildren(...chats.map(c => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${encodeURIComponent(c.id)}`;
    a.className = `chat-item${c.id === current ? ' open' : ''}`;
    if (c.id === current) a.setAttribute('aria-current', 'true');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = c.title || 'Untitled';
    const meta = document.createElement('span');
    meta.className = `meta ${c.status}`;
    meta.textContent = c.status === 'running' ? 'working' : c.status === 'waiting' ? 'asks you' : ago(c.updatedAt);
    a.append(title, meta);
    li.append(a);
    return li;
  }));
  if (!chats.length) {
    const li = document.createElement('li');
    li.className = 'quiet';
    li.textContent = 'No conversations yet.';
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
  status = next;
  state.textContent = STATE_WORDS[status] ?? status;
  send.disabled = status !== 'idle';
  cancel.disabled = status === 'idle';
  renderQuestion(question);
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
  log.replaceChildren();
  mode.disabled = !id;
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
      if (el) el.textContent = events[m.index].text;
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

window.addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id !== (current ?? '')) open(id || null);
});

open(decodeURIComponent(location.hash.slice(1)) || null);
mode.disabled = false;
refreshList();
setInterval(refreshList, 30_000);
