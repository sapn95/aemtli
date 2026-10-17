// The Connections page. It asks each gateway how the login of its server
// is, and starts a new one where the owner asks for it. A device-code login
// shows the page to open and the code to enter there; the page then asks
// again every ten seconds until the login is there or the code has run out.
// Everything the gateways say is set with textContent only.

import { registerServiceWorker } from './install.js';

registerServiceWorker();

const POLL_MS = 10_000;
// As long as Microsoft keeps a device code, and as long as the gateway keeps
// the process that waits for it.
const CODE_LIFE_MS = 15 * 60_000;

async function api(path, { method = 'GET' } = {}) {
  const res = await fetch(path, { method });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function say(row, text, tone) {
  const p = row.querySelector('.account');
  p.textContent = text;
  p.className = `account ${tone}`;
}

/** Asks the gateway how its login is and says so; resolves with the answer. */
async function check(row) {
  let state;
  try {
    state = await api(`/api/gateways/${encodeURIComponent(row.dataset.gateway)}/account`);
  } catch (err) {
    say(row, `Not reachable: ${err.message}.`, 'bad');
    return null;
  }
  if (!state.login) {
    say(row, 'Reachable. It keeps no login of its own.', 'quiet');
    return state;
  }
  row.querySelector('.login').hidden = !state.canLogin;
  if (state.loggedIn) say(row, state.who ? `Logged in as ${state.who}.` : 'Logged in.', 'good');
  // The server's own words, unless they only say the same.
  else say(row, /^not logged in\.?$/i.test(state.message) || !state.message ? 'Not logged in.' : `Not logged in. ${state.message}`, 'bad');
  return state;
}

/** The page to open and the code to enter, with a button that copies the code. */
function deviceCode(answer) {
  if (!answer.url || !answer.code) return [element('p', answer.message)];
  const open = element('p');
  const link = element('a', answer.url);
  link.href = answer.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  open.append('Open ', link, ' and enter this code:');
  const code = element('p', '', 'code-row');
  const copy = element('button', 'Copy', 'quiet-button');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(answer.code);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy by hand';
    }
  });
  code.append(element('code', answer.code, 'code'), copy);
  return [open, code];
}

async function login(row, button) {
  const device = row.querySelector('.device');
  button.disabled = true;
  // What held before: a login that still works answers "logged in" at once,
  // so only a change says that the new one is done.
  const before = await check(row);
  device.hidden = false;
  device.replaceChildren(element('p', 'Asking for a code…', 'quiet'));
  let answer;
  try {
    answer = await api(`/api/gateways/${encodeURIComponent(row.dataset.gateway)}/login`, { method: 'POST' });
    if (!answer.login) throw new Error('this gateway keeps no login');
    if (!answer.ok) throw new Error(answer.message || 'the server did not start one');
  } catch (err) {
    device.replaceChildren(element('p', `No login started: ${err.message}`, 'bad'));
    button.disabled = false;
    return;
  }
  const waiting = element('p', 'Waiting for the code to be entered…', 'quiet');
  waiting.setAttribute('role', 'status');
  device.replaceChildren(...deviceCode(answer), waiting);
  const until = Date.now() + CODE_LIFE_MS;
  // One question at a time: the next waits until the last has its answer.
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    const now = await check(row);
    if (now?.loggedIn && (!before?.loggedIn || now.who !== before.who)) {
      device.hidden = true;
      device.replaceChildren();
      button.disabled = false;
      return;
    }
  }
  waiting.textContent = before?.loggedIn ? 'The code has run out. The login from before still holds.' : 'The code has run out. Start again.';
  button.disabled = false;
}

for (const row of document.querySelectorAll('.connection')) {
  const button = row.querySelector('.login');
  button.addEventListener('click', () => login(row, button));
  check(row);
}
