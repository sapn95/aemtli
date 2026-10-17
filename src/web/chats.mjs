// The chat broker: the web server, not the browser, holds the conversation
// with goose. A turn keeps running when the phone locks or the train enters
// a tunnel; a question goose asks waits, and a push says so; the browser
// only watches, through a stream it can drop and pick up again.
//
// goose keeps the conversations themselves (ACP session/list and
// session/load), so the history survives a restart of either side. What the
// broker keeps is the live part: what each conversation shows right now, who
// is watching it, and the question waiting for an answer.

import { randomBytes } from 'node:crypto';

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

// Images: the types the model reads, as their first bytes show them. A
// browser's word for the type is not taken on its own.
const IMAGE_MAGIC = {
  'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': b => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  'image/webp': b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
/** At most this many images go with one message. */
export const MAX_IMAGES = 6;
// The model takes an image of up to 5 MB as sent, which is base64.
const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;
// All of a message's images together: the whole prompt is one WebSocket
// message to goose, and goose takes a frame of up to 16 MiB.
export const MAX_IMAGES_BASE64 = 12 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// Images the page can show, kept in memory: they come from the browser or
// from goose replaying a conversation, and goose has them again on the next
// load. Past this the oldest go first.
const IMAGE_MEMORY = 64 * 1024 * 1024;

const badImage = message => Object.assign(new Error(message), { status: 400 });

/** Whether base64 `data` is an image of `mimeType` by its first bytes. */
function isImage(mimeType, data) {
  return typeof mimeType === 'string' && Object.hasOwn(IMAGE_MAGIC, mimeType)
    && typeof data === 'string' && IMAGE_MAGIC[mimeType](Buffer.from(data.slice(0, 64), 'base64'));
}

/**
 * The images a message carries, checked: at most MAX_IMAGES, each a JPEG,
 * PNG, GIF or WebP whose bytes say so, in base64, small enough for the
 * model. Returns [{ mimeType, data }]; throws a 400 saying what is wrong.
 */
export function readImages(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badImage('images must be a list');
  if (raw.length > MAX_IMAGES) throw badImage(`at most ${MAX_IMAGES} images go with one message`);
  let total = 0;
  return raw.map((image, i) => {
    const which = `image ${i + 1}`;
    const { mimeType, data } = image ?? {};
    if (typeof mimeType !== 'string' || !Object.hasOwn(IMAGE_MAGIC, mimeType)) throw badImage(`${which}: only JPEG, PNG, GIF and WebP are read`);
    if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64.test(data)) throw badImage(`${which}: the data must be base64`);
    if (data.length > MAX_IMAGE_BASE64) throw badImage(`${which} is larger than the model takes (5 MB)`);
    total += data.length;
    if (total > MAX_IMAGES_BASE64) throw badImage('the images together are larger than one message can carry (12 MB)');
    if (!isImage(mimeType, data)) throw badImage(`${which} is not the ${mimeType.slice(6).toUpperCase()} it says it is`);
    return { mimeType, data };
  });
}

/**
 * `connect()` returns a WebSocket-like object (send, close, onopen,
 * onmessage, onclose). `cwd` and `mcpServers` go to every session. `notify`
 * sends a push. `link(id)` is where a push points. `render(text)` turns
 * goose's Markdown into HTML that is safe to put into the page; without it
 * the page shows the text as it is. `imageMemory` is how many bytes of
 * images are kept for the page.
 */
export function createChatBroker({ connect, cwd, mcpServers = [], notify = () => Promise.resolve(false), link = () => undefined, log = () => {}, answerMs = ANSWER_MS, render = null, renderMs = 250, imageMemory = IMAGE_MEMORY }) {
  let socket = null;
  let ready = null;
  let nextId = 1;
  const pending = new Map();
  const chats = new Map();
  let closed = false;
  // Image id -> { chat, mimeType, data }, oldest first.
  const images = new Map();
  let imageBytes = 0;

  /** Keeps an image for the page to fetch; returns what an event carries of it. */
  function keepImage(c, mimeType, data) {
    const id = randomBytes(12).toString('hex');
    const bytes = Buffer.from(data, 'base64');
    images.set(id, { chat: c.id, mimeType, data: bytes });
    imageBytes += bytes.length;
    for (const [old, kept] of images) {
      if (imageBytes <= imageMemory || old === id) break;
      images.delete(old);
      imageBytes -= kept.data.length;
    }
    return { id, mimeType };
  }

  /** Forgets the images of a conversation that is forgotten or loaded again. */
  function dropImages(chatId) {
    for (const [id, kept] of images) {
      if (kept.chat !== chatId) continue;
      images.delete(id);
      imageBytes -= kept.data.length;
    }
  }

  /** A conversation's live state, made when first needed. */
  function chat(id) {
    let c = chats.get(id);
    if (!c) {
      c = { id, events: [], status: 'idle', question: null, queue: [], mode: null, title: null, watchers: new Set(), loaded: false, loading: null, touched: Date.now(), turn: 0 };
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
    for (const c of quiet.slice(0, Math.max(0, quiet.length - MAX_IDLE))) {
      chats.delete(c.id);
      dropImages(c.id);
    }
  }

  /** Tells everyone watching a conversation what changed. */
  function emit(c, event) {
    // While goose replays a conversation it is rebuilt from nothing; the
    // watchers get the whole of it once that is done.
    if (c.replaying) return;
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of c.watchers) res.write(data);
  }

  /** An event as the page gets it: goose's words also as HTML. */
  const shown = e => (render && e.type === 'agent' ? { ...e, html: render(e.text) } : e);

  /**
   * An answer that is still arriving is drawn as HTML at most every
   * `renderMs`, and only while somebody watches: Markdown cannot be drawn in
   * pieces, and drawing the whole of it for every chunk is work nobody sees.
   */
  function drawSoon(c, index) {
    if (!render) return;
    c.drawIndex = index;
    c.drawTimer ??= setTimeout(() => drawNow(c), renderMs);
  }
  function drawNow(c) {
    clearTimeout(c.drawTimer);
    c.drawTimer = null;
    const i = c.drawIndex;
    c.drawIndex = null;
    if (i !== null && i !== undefined && c.events[i] && c.watchers.size) emit(c, { kind: 'replace', index: i, event: shown(c.events[i]) });
  }

  function push(c, event) {
    // The answer before it is finished: drawn whole before what follows.
    drawNow(c);
    c.events.push(event);
    if (c.events.length > MAX_EVENTS + TRIM_STEP) {
      c.events.splice(0, c.events.length - MAX_EVENTS);
      if (c.watchers.size) emit(c, snapshot(c));
    } else {
      // Drawn only for somebody to see.
      if (c.watchers.size) emit(c, { kind: 'event', event: shown(event) });
    }
  }

  /**
   * The question as the page sees it: what goose wants to run, the options,
   * and which event it is, so the buttons go under that one and not under a
   * question still waiting in line.
   */
  const asked = (c, q) => (q ? { title: q.title, options: q.options, index: c.events.indexOf(q.event) } : null);

  function setStatus(c, status) {
    c.status = status;
    emit(c, { kind: 'status', status, question: asked(c, c.question) });
  }

  /** One session/update from goose, into the conversation it belongs to. */
  function onUpdate(c, u) {
    const last = c.events.at(-1);
    switch (u.sessionUpdate) {
      case 'user_message_chunk':
      case 'agent_message_chunk': {
        const role = u.sessionUpdate === 'user_message_chunk' ? 'user' : 'agent';
        if (u.content?.type === 'image') {
          // An image goose replays, or one an answer carries: kept for the
          // page, with the message it belongs to, if it is one the page may
          // show and no larger than one the browser could have sent.
          if (!isImage(u.content.mimeType, u.content.data) || u.content.data.length > MAX_IMAGE_BASE64) return;
          const ref = keepImage(c, u.content.mimeType, u.content.data);
          if (last?.type === role && !last.closed) {
            (last.images ??= []).push(ref);
            emit(c, { kind: 'replace', index: c.events.length - 1, event: shown(last) });
          } else {
            push(c, { type: role, text: '', images: [ref] });
          }
          return;
        }
        if (u.content?.type !== 'text') return;
        if (last?.type === role && !last.closed) {
          last.text += u.content.text;
          emit(c, { kind: 'append', index: c.events.length - 1, text: u.content.text });
          if (role === 'agent') drawSoon(c, c.events.length - 1);
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
      dropImages(c.id);
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

  const snapshot = c => ({ kind: 'snapshot', events: c.events.map(shown), status: c.status, question: asked(c, c.question), mode: c.mode, title: c.title });

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

    /**
     * Sends a message, with images checked by readImages. Resolves once goose
     * took it; the answer streams.
     */
    async say(id, text, pictures = []) {
      const c = await prepared(id);
      if (c.status !== 'idle') throw Object.assign(new Error('goose is still answering'), { status: 409 });
      const last = c.events.at(-1);
      if (last) last.closed = true;
      const said = { type: 'user', text, closed: true };
      if (pictures.length) said.images = pictures.map(p => keepImage(c, p.mimeType, p.data));
      push(c, said);
      c.turn += 1;
      setStatus(c, 'running');
      const prompt = [
        ...(text ? [{ type: 'text', text }] : []),
        ...pictures.map(p => ({ type: 'image', mimeType: p.mimeType, data: p.data })),
      ];
      call('session/prompt', { sessionId: id, prompt }, 0).then(result => {
        drawNow(c);
        if (c.events.at(-1)) c.events.at(-1).closed = true;
        if (result?.stopReason === 'cancelled') push(c, { type: 'note', text: 'Stopped.' });
        dropQuestions(c, false);
        setStatus(c, 'idle');
        // Nobody watching: say on the phone that the answer is there.
        if (!c.watchers.size) notify({ title: 'goose ist fertig', message: c.title ?? (text || 'Bild').slice(0, 80), click: link(c.id) }).catch(() => {});
      }, err => {
        push(c, { type: 'error', text: err.message });
        dropQuestions(c, false);
        setStatus(c, 'idle');
      });
    },

    /**
     * Stops the turn that is running. goose answers the prompt with
     * "cancelled" and the status follows; a goose that says nothing at all
     * would leave the conversation unusable, so after `answerMs` the
     * conversation is called idle anyway and says so.
     */
    async stop(id) {
      await open();
      socket?.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: id } }));
      const c = chat(id);
      dropQuestions(c, true);
      if (c.status === 'idle') return;
      // The turn this stops, so a later one is never called idle by it.
      const turn = c.turn;
      setTimeout(() => {
        if (c.status === 'idle' || c.turn !== turn) return;
        push(c, { type: 'note', text: 'Stopped. goose did not say that it stopped, so the next message may be refused while it finishes.' });
        setStatus(c, 'idle');
      }, answerMs).unref?.();
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
      dropImages(id);
    },

    /** One image of a conversation, as it was kept, or null. */
    image(chatId, imageId) {
      const kept = images.get(imageId);
      return kept && kept.chat === chatId ? { mimeType: kept.mimeType, data: kept.data } : null;
    },

    close() {
      closed = true;
      socket?.close();
    },
    /** For the tests: what the broker holds. */
    chats,
    images,
  };
}
