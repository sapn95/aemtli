// A small ACP client for the chat page. It talks JSON-RPC over the /acp
// WebSocket, which the server forwards to `goose serve`. Text from the agent
// is set with textContent only, never as HTML.

const log = document.getElementById('log');
const form = document.getElementById('form');
const input = document.getElementById('input');
const send = document.getElementById('send');
const cancel = document.getElementById('cancel');
const mode = document.getElementById('mode');
const state = document.getElementById('state');
const fresh = document.getElementById('new');

let ws;
let nextId = 1;
let sessionId = null;
let agentBubble = null;
const pending = new Map();
const tools = new Map();

/** Appends an element of `kind` with `text` to the conversation. */
function add(kind, text = '') {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

/** Sends a request and resolves with its result (rejects on an error reply). */
function call(method, params) {
  const id = nextId++;
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** Sends a notification (no reply expected). */
function notify(method, params) {
  ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
}

/** Answers a request the agent made of us. */
function answer(id, result) {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

/** Shows that a turn is running, or that it is over. */
function busy(on) {
  send.disabled = on;
  cancel.disabled = !on;
  state.textContent = on ? 'goose is working…' : 'Ready';
  if (!on) agentBubble = null;
}

const TOOL_WORDS = { pending: 'waiting', in_progress: 'running', completed: 'done', failed: 'failed' };

/** "Read file (done)": a tool call's title and how far it got. */
function toolLine(title, status) {
  const word = TOOL_WORDS[status] ?? status;
  return word ? `${title} (${word})` : title;
}

/** Renders one session/update notification. */
function onUpdate(update) {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (update.content?.type === 'text') {
        agentBubble = agentBubble ?? add('agent');
        agentBubble.textContent += update.content.text;
        log.scrollTop = log.scrollHeight;
      }
      break;
    case 'tool_call': {
      const el = add('tool', toolLine(update.title ?? 'tool', update.status ?? 'pending'));
      tools.set(update.toolCallId, { el, title: update.title ?? 'tool' });
      // The next text belongs below the tool line, not above it.
      agentBubble = null;
      break;
    }
    case 'tool_call_update': {
      const t = tools.get(update.toolCallId);
      if (t) {
        if (update.title) t.title = update.title;
        t.el.textContent = toolLine(t.title, update.status);
        t.el.dataset.status = update.status ?? '';
      }
      break;
    }
    default:
      // usage, titles, command lists and thoughts are not shown.
      break;
  }
}

// ACP names four kinds of permission option; goose sends the kind as the
// option's name too, which reads like an identifier. The safe one comes first.
const OPTION_LABELS = { allow_once: 'Allow once', allow_always: 'Always allow', reject_once: 'Reject', reject_always: 'Always reject' };
const OPTION_ORDER = ['allow_once', 'reject_once', 'allow_always', 'reject_always'];

/** Shows a permission request with one button per option. */
function onPermission(id, params) {
  const box = add('permission', `goose wants to run: ${params.toolCall?.title ?? 'a tool'}`);
  const row = document.createElement('div');
  const options = [...(params.options ?? [])].sort((a, b) => OPTION_ORDER.indexOf(a.kind) - OPTION_ORDER.indexOf(b.kind));
  for (const option of options) {
    const b = document.createElement('button');
    const label = OPTION_LABELS[option.kind] ?? option.name;
    b.textContent = label;
    b.addEventListener('click', () => {
      answer(id, { outcome: { outcome: 'selected', optionId: option.optionId } });
      row.remove();
      const said = document.createElement('p');
      said.className = 'answered';
      said.textContent = `You chose: ${label}`;
      box.append(said);
    });
    row.append(b);
  }
  box.append(row);
}

/** Dispatches one incoming message. */
function onMessage(event) {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && !msg.method) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (p) msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    return;
  }
  if (msg.method === 'session/update' && msg.params?.sessionId === sessionId) return onUpdate(msg.params.update);
  if (msg.method === 'session/request_permission') return onPermission(msg.id, msg.params);
  // A request this client does not implement gets a proper refusal, so the
  // agent is never left waiting for an answer that will not come.
  if (msg.id !== undefined) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported by this client' } }));
}

/** Starts a new session in the selected mode. */
async function newSession() {
  // The MCP gateways, which goose connects to for this session only.
  const created = await call('session/new', { cwd: log.dataset.cwd, mcpServers: JSON.parse(log.dataset.mcp || '[]') });
  sessionId = created.sessionId;
  await call('session/set_mode', { sessionId, modeId: mode.value });
  log.replaceChildren();
  tools.clear();
  busy(false);
}

/** Opens the WebSocket and initialises the protocol. */
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/acp`);
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', () => {
    state.textContent = 'Disconnected. Reload the page to reconnect.';
    send.disabled = true;
    cancel.disabled = true;
  });
  ws.addEventListener('open', async () => {
    try {
      await call('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'aemtli', version: '1' },
      });
      await newSession();
    } catch (err) {
      state.textContent = `Could not start a conversation: ${err.message}`;
    }
  });
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !sessionId) return;
  input.value = '';
  add('user', text);
  busy(true);
  try {
    const result = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    if (result?.stopReason && result.stopReason !== 'end_turn') add('note', `stopped: ${result.stopReason}`);
  } catch (err) {
    add('error', err.message);
  } finally {
    busy(false);
  }
});

input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) form.requestSubmit();
});
cancel.addEventListener('click', () => notify('session/cancel', { sessionId }));
mode.addEventListener('change', () => sessionId && call('session/set_mode', { sessionId, modeId: mode.value }));
fresh.addEventListener('click', () => newSession().catch(err => add('error', err.message)));

connect();
