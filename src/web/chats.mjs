// The chat broker: the web server, not the browser, holds the conversation
// with goose. A turn keeps running when the phone locks or the train enters
// a tunnel; a question goose asks waits, and a push says so; the browser
// only watches, through a stream it can drop and pick up again.
//
// goose keeps the conversations themselves (ACP session/list and
// session/load), so the history survives a restart of either side. What the
// broker keeps is the live part: what each conversation shows right now, who
// is watching it, and the question waiting for an answer.

const TOOL_WORDS = { pending: 'waiting', in_progress: 'running', completed: 'done', failed: 'failed' };
// What one conversation shows at most. Trimmed in steps, and each trim sends
// the watchers a new snapshot, because the stream addresses events by index.
const MAX_EVENTS = 2000;
const TRIM_STEP = 200;
// Conversations kept in memory while nobody watches them and nothing runs.
const MAX_IDLE = 30;
const PROTOCOL = 1;
// How long goose may take to answer anything but a prompt.
const ANSWER_MS = 60_000;
const gone = () => Object.assign(new Error('no such conversation'), { status: 404 });

/**
 * `connect()` returns a WebSocket-like object (send, close, onopen,
 * onmessage, onclose). `cwd` and `mcpServers` go to every session. `notify`
 * sends a push. `link(id)` is where a push points.
 */
export function createChatBroker({ connect, cwd, mcpServers = [], notify = () => Promise.resolve(false), link = () => undefined, log = () => {}, answerMs = ANSWER_MS }) {
  let socket = null;
  let ready = null;
  let nextId = 1;
  const pending = new Map();
  const chats = new Map();
  let closed = false;

  /** A conversation's live state, made when first needed. */
  function chat(id) {
    let c = chats.get(id);
    if (!c) {
      c = { id, events: [], status: 'idle', question: null, queue: [], mode: null, title: null, watchers: new Set(), loaded: false, loading: null, touched: Date.now() };
      forgetIdle();
      chats.set(id, c);
    }
    c.touched = Date.now();
    return c;
  }

  /** One that nobody watches and nothing runs in can be loaded again from goose. */
  const idle = c => c.status === 'idle' && !c.watchers.size && !c.loading;

  /** Keeps at most MAX_IDLE idle conversations in memory, the most recent ones. */
  function forgetIdle() {
    const quiet = [...chats.values()].filter(idle).sort((a, b) => a.touched - b.touched);
    for (const c of quiet.slice(0, Math.max(0, quiet.length - MAX_IDLE))) chats.delete(c.id);
  }

  /** Tells everyone watching a conversation what changed. */
  function emit(c, event) {
    // While goose replays a conversation it is rebuilt from nothing; the
    // watchers get the whole of it once that is done.
    if (c.replaying) return;
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of c.watchers) res.write(data);
  }

  function push(c, event) {
    c.events.push(event);
    if (c.events.length > MAX_EVENTS + TRIM_STEP) {
      c.events.splice(0, c.events.length - MAX_EVENTS);
      emit(c, snapshot(c));
    } else {
      emit(c, { kind: 'event', event });
    }
  }

  /** The question as the page sees it: what goose wants to run and the options. */
  const shown = q => (q ? { title: q.title, options: q.options } : null);

  function setStatus(c, status) {
    c.status = status;
    emit(c, { kind: 'status', status, question: shown(c.question) });
  }

  /** One session/update from goose, into the conversation it belongs to. */
  function onUpdate(c, u) {
    const last = c.events.at(-1);
    switch (u.sessionUpdate) {
      case 'user_message_chunk':
      case 'agent_message_chunk': {
        if (u.content?.type !== 'text') return;
        const role = u.sessionUpdate === 'user_message_chunk' ? 'user' : 'agent';
        if (last?.type === role && !last.closed) {
          last.text += u.content.text;
          emit(c, { kind: 'append', index: c.events.length - 1, text: u.content.text });
        } else {
          push(c, { type: role, text: u.content.text });
        }
        return;
      }
      case 'tool_call':
        if (last) last.closed = true;
        push(c, { type: 'tool', id: u.toolCallId, title: u.title ?? 'tool', status: TOOL_WORDS[u.status] ?? u.status ?? 'waiting' });
        return;
      case 'tool_call_update': {
        const i = c.events.findLastIndex(e => e.type === 'tool' && e.id === u.toolCallId);
        if (i < 0) return;
        if (u.title) c.events[i].title = u.title;
        if (u.status) c.events[i].status = TOOL_WORDS[u.status] ?? u.status;
        emit(c, { kind: 'replace', index: i, event: c.events[i] });
        return;
      }
      case 'session_info_update':
        if (u.title) c.title = u.title;
        return;
      default:
        // Plans, usage, commands and thoughts are not shown.
    }
  }

  function onMessage(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (p) {
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      }
      return;
    }
    const session = typeof m.params?.sessionId === 'string' ? m.params.sessionId : null;
    if (m.method === 'session/update' && session && m.params.update) return onUpdate(chat(session), m.params.update);
    if (m.method === 'session/request_permission' && session && m.id !== undefined) return onQuestion(m.id, session, m.params);
    // Anything else goose asks of a client this one cannot do: a refusal,
    // so it never waits for an answer that will not come.
    if (m.id !== undefined) reply(m.id, undefined, { code: -32601, message: 'not supported' });
  }

  const reply = (id, result, error) => socket?.send(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }));
  const cancelled = q => reply(q.requestId, { outcome: { outcome: 'cancelled' } });

  /**
   * goose asks before a tool: the question waits here, and a push goes out.
   * A second question while one waits (tools called side by side) queues
   * behind it, and comes up once the first is answered.
   */
  function onQuestion(requestId, session, params) {
    const c = chat(session);
    if (c.events.at(-1)) c.events.at(-1).closed = true;
    const title = params.toolCall?.title ?? 'a tool';
    const event = { type: 'question', title };
    const q = { requestId, title, event, options: (params.options ?? []).map(o => ({ id: o.optionId, kind: o.kind, name: o.name })) };
    push(c, event);
    if (c.question) {
      c.queue.push(q);
      return;
    }
    c.question = q;
    setStatus(c, 'waiting');
    notify({ title: 'goose fragt', message: `Darf goose ${title} ausführen?`, click: link(c.id) }).catch(() => {});
  }

  /** Ends every question of a conversation, answered or not. */
  function dropQuestions(c, answerThem) {
    for (const q of [c.question, ...c.queue].filter(Boolean)) if (answerThem) cancelled(q);
    c.question = null;
    c.queue = [];
  }

  /** The connection to goose, opened once and opened again when it drops. */
  function open() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const ws = connect();
      socket = ws;
      ws.onmessage = event => {
        try {
          onMessage(typeof event.data === 'string' ? event.data : String(event.data));
        } catch (err) {
          log(`chat: a message from goose was not understood: ${err.message}`);
        }
      };
      ws.onclose = () => {
        // A turn that was running ends here, with this as its last word; the
        // conversation itself is still goose's, and is loaded again on the
        // next look.
        for (const p of pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('The connection to goose dropped. Ask again if the answer is missing.'));
        }
        pending.clear();
        socket = null;
        ready = null;
        for (const c of chats.values()) c.loaded = false;
        reject(new Error('the connection to goose closed'));
        if (!closed) log('chat: the connection to goose closed');
      };
      ws.onopen = () => {
        // A goose that refuses or never answers is closed, so the next call
        // starts over instead of waiting on this one.
        request('initialize', { protocolVersion: PROTOCOL, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'aemtli-web', version: '1' } })
          .then(() => resolve(), err => { reject(err); ws.close(); });
      };
    });
    ready.catch(() => {});
    return ready;
  }

  /** One call to goose; `timeoutMs` 0 waits as long as it takes (a prompt). */
  function request(method, params, timeoutMs = answerMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('goose is not connected'));
      const timer = timeoutMs ? setTimeout(() => {
        pending.delete(id);
        reject(new Error(`goose did not answer ${method} in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs) : null;
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async function call(method, params, timeoutMs) {
    await open();
    return request(method, params, timeoutMs);
  }

  /**
   * Loads a conversation goose kept, replaying it into the events. Callers
   * that come while it loads wait for the same load, so a replay never lands
   * twice. One that goose does not know is forgotten here as well.
   */
  function load(c) {
    if (c.loaded) return Promise.resolve();
    c.loading ??= (async () => {
      c.events = [];
      c.replaying = true;
      try {
        const result = await call('session/load', { sessionId: c.id, cwd, mcpServers });
        c.mode = result?.modes?.currentModeId ?? c.mode;
      } catch (err) {
        if (!c.watchers.size && c.status === 'idle' && chats.get(c.id) === c) chats.delete(c.id);
        throw err;
      } finally {
        c.replaying = false;
      }
      for (const e of c.events) e.closed = true;
      c.loaded = true;
      emit(c, snapshot(c));
    })().finally(() => { c.loading = null; });
    return c.loading;
  }

  const snapshot = c => ({ kind: 'snapshot', events: c.events, status: c.status, question: shown(c.question), mode: c.mode, title: c.title });

  /** Loads a conversation for a caller: 404 when goose has none, or it was deleted meanwhile. */
  async function prepared(id) {
    const c = chat(id);
    try {
      await load(c);
    } catch (err) {
      throw /not found|unknown|no session/i.test(err.message) ? gone() : err;
    }
    if (chats.get(id) !== c) throw gone();
    return c;
  }

  return {
    /** Every conversation goose keeps, newest first, with what this side knows. */
    async list() {
      const result = await call('session/list', {});
      return (result?.sessions ?? []).map(s => {
        const live = chats.get(s.sessionId);
        return { id: s.sessionId, title: live?.title ?? s.title ?? 'Untitled', updatedAt: s.updatedAt ?? null, status: live?.status ?? 'idle', messages: s._meta?.messageCount ?? null };
      }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    /** A new conversation in `mode`. */
    async create(mode) {
      const result = await call('session/new', { cwd, mcpServers });
      const c = chat(result.sessionId);
      c.loaded = true;
      if (mode) {
        await call('session/set_mode', { sessionId: c.id, modeId: mode });
        c.mode = mode;
      } else {
        c.mode = result?.modes?.currentModeId ?? null;
      }
      return { id: c.id };
    },

    /** Loads a conversation, so that watching it can start; 404 when goose has none. */
    async open(id) {
      await prepared(id);
    },

    /**
     * Starts watching a conversation: writes what it shows now to the
     * stream, then every change, until the stream closes. Returns the
     * function that stops it.
     */
    async watch(id, res) {
      const c = await prepared(id);
      res.write(`data: ${JSON.stringify(snapshot(c))}\n\n`);
      c.watchers.add(res);
      return () => c.watchers.delete(res);
    },

    /** Sends a message. Resolves once goose took it; the answer streams. */
    async say(id, text) {
      const c = await prepared(id);
      if (c.status !== 'idle') throw Object.assign(new Error('goose is still answering'), { status: 409 });
      const last = c.events.at(-1);
      if (last) last.closed = true;
      push(c, { type: 'user', text, closed: true });
      setStatus(c, 'running');
      call('session/prompt', { sessionId: id, prompt: [{ type: 'text', text }] }, 0).then(result => {
        if (c.events.at(-1)) c.events.at(-1).closed = true;
        if (result?.stopReason === 'cancelled') push(c, { type: 'note', text: 'Stopped.' });
        dropQuestions(c, false);
        setStatus(c, 'idle');
        // Nobody watching: say on the phone that the answer is there.
        if (!c.watchers.size) notify({ title: 'goose ist fertig', message: c.title ?? text.slice(0, 80), click: link(c.id) }).catch(() => {});
      }, err => {
        push(c, { type: 'error', text: err.message });
        dropQuestions(c, false);
        setStatus(c, 'idle');
      });
    },

    /** Stops the turn that is running. */
    async stop(id) {
      await open();
      socket?.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: id } }));
      dropQuestions(chat(id), true);
    },

    /** Answers the question that waits, with one of its options. */
    answer(id, optionId) {
      const c = chats.get(id);
      const q = c?.question;
      if (!q) throw Object.assign(new Error('no question waits'), { status: 409 });
      const option = q.options.find(o => o.id === optionId);
      if (!option) throw Object.assign(new Error('not one of the options'), { status: 400 });
      reply(q.requestId, { outcome: { outcome: 'selected', optionId } });
      const i = c.events.indexOf(q.event);
      q.event.answer = option.name ?? option.kind;
      if (i >= 0) emit(c, { kind: 'replace', index: i, event: q.event });
      // The next question in line, if tools asked side by side.
      c.question = c.queue.shift() ?? null;
      setStatus(c, c.question ? 'waiting' : 'running');
    },

    /** Switches how much goose asks before tools. */
    async mode(id, modeId) {
      await call('session/set_mode', { sessionId: id, modeId });
      chat(id).mode = modeId;
    },

    /** Deletes a conversation for good. */
    async remove(id) {
      await call('session/delete', { sessionId: id });
      const c = chats.get(id);
      for (const res of c?.watchers ?? []) res.end();
      if (c) c.watchers.clear();
      chats.delete(id);
    },

    close() {
      closed = true;
      socket?.close();
    },
    /** For the tests: what the broker holds. */
    chats,
  };
}
