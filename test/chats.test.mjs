import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatBroker } from '../src/web/chats.mjs';
import { fakeGoose } from './fixtures/fake-goose-acp.mjs';

/** A stream the broker writes to, as a response object would be written. */
function watcher() {
  const frames = [];
  return { frames, write: d => frames.push(JSON.parse(d.replace(/^data: /, ''))), end() {} };
}

const settle = () => new Promise(r => setTimeout(r, 20));

function broker(goose, pushes = []) {
  return createChatBroker({ connect: goose.connect, cwd: '/w', mcpServers: [{ type: 'http', name: 'epost', url: 'http://x/mcp', headers: [] }], notify: async n => { pushes.push(n); return true; }, link: id => `https://chores.example/chat#${id}` });
}

test('a conversation: made, said to, answered, streamed to whoever watches', async () => {
  const goose = fakeGoose();
  const b = broker(goose);
  const { id } = await b.create('approve');
  const w = watcher();
  await b.watch(id, w);
  await b.say(id, 'Grüessech');
  await settle();
  assert.deepEqual(w.frames[0], { kind: 'snapshot', events: [], status: 'idle', question: null, mode: 'approve', title: null });
  const live = b.chats.get(id);
  assert.deepEqual(live.events.map(e => [e.type, e.text]), [['user', 'Grüessech'], ['agent', 'Hallo zäme']]);
  assert.equal(live.status, 'idle');
  assert.ok(w.frames.some(f => f.kind === 'append' && f.text === 'zäme'), 'the answer streams in pieces');
  assert.deepEqual(w.frames.filter(f => f.kind === 'status').map(f => f.status), ['running', 'idle']);
});

test('a second message while goose answers is refused, and Stop ends the turn', async () => {
  const goose = fakeGoose();
  const b = broker(goose);
  const { id } = await b.create();
  await b.say(id, 'SLOW please');
  await settle();
  assert.equal(b.chats.get(id).status, 'running');
  await assert.rejects(b.say(id, 'and this'), err => err.status === 409);
  await b.stop(id);
  await settle();
  assert.equal(b.chats.get(id).status, 'idle');
  assert.equal(b.chats.get(id).events.at(-1).text, 'Stopped.');
});

test('a question waits for an answer from any device, and a push says so', async () => {
  const goose = fakeGoose();
  const pushes = [];
  const b = broker(goose, pushes);
  const { id } = await b.create();
  await b.say(id, 'Use a TOOL');
  await settle();
  const c = b.chats.get(id);
  assert.equal(c.status, 'waiting');
  assert.equal(c.question.title, 'shell: ls');
  assert.deepEqual(pushes[0], { title: 'goose fragt', message: 'Darf goose shell: ls ausführen?', click: `https://chores.example/chat#${id}` });
  assert.throws(() => b.answer(id, 'made-up'), err => err.status === 400);
  // A phone that opens the conversation now sees the question in the snapshot.
  const late = watcher();
  await b.watch(id, late);
  assert.equal(late.frames[0].question.options.length, 2);
  b.answer(id, 'allow');
  await settle();
  assert.equal(c.status, 'idle');
  assert.equal(c.events.find(e => e.type === 'question').answer, 'Allow');
  assert.equal(c.events.find(e => e.type === 'tool').status, 'done');
  assert.throws(() => b.answer(id, 'allow'), err => err.status === 409, 'nothing waits any more');
});

test('nobody watching: a push when the answer is there; somebody watching: none', async () => {
  const goose = fakeGoose();
  const pushes = [];
  const b = broker(goose, pushes);
  const { id } = await b.create();
  await b.say(id, 'Hoi');
  await settle();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'goose ist fertig');
  const w = watcher();
  const stop = await b.watch(id, w);
  await b.say(id, 'Hoi nomau');
  await settle();
  assert.equal(pushes.length, 1, 'the page showed it');
  stop();
});

test('after a restart the history comes back from goose, and the list is newest first', async () => {
  const goose = fakeGoose();
  const first = broker(goose);
  const { id } = await first.create();
  await first.say(id, 'Erinnere dich');
  await settle();
  await first.create();
  first.close();

  const second = broker(goose);
  const w = watcher();
  await second.watch(id, w);
  assert.deepEqual(w.frames[0].events.map(e => [e.type, e.text]), [['user', 'Erinnere dich'], ['agent', 'Hallo zäme']]);
  assert.equal(w.frames[0].mode, 'auto');
  const list = await second.list();
  assert.deepEqual(list.map(c => c.id), ['s2', 's1']);
  assert.equal(list[1].messages, 2);
  await second.remove('s2');
  assert.deepEqual((await second.list()).map(c => c.id), ['s1']);
});

test('when the connection to goose drops, a running turn says so and the next call reconnects', async () => {
  const goose = fakeGoose();
  const b = broker(goose);
  const { id } = await b.create();
  const w = watcher();
  await b.watch(id, w);
  await b.say(id, 'SLOW');
  await settle();
  goose.sockets.at(-1).close();
  await settle();
  const c = b.chats.get(id);
  assert.equal(c.status, 'idle');
  assert.match(c.events.at(-1).text, /connection to goose dropped/);
  assert.equal((await b.list()).length, 1, 'a new connection');
  assert.equal(goose.sockets.length, 2);
  // Watching again reloads from goose and sends the page a fresh snapshot.
  const again = watcher();
  await b.watch(id, again);
  assert.equal(again.frames[0].kind, 'snapshot');
});

test('every session gets the working directory and the gateways', async () => {
  const goose = fakeGoose();
  const seen = [];
  const b = createChatBroker({
    connect: () => {
      const ws = goose.connect();
      const send = ws.send;
      ws.send = raw => { seen.push(JSON.parse(raw)); send(raw); };
      return ws;
    },
    cwd: '/w',
    mcpServers: [{ type: 'http', name: 'epost', url: 'http://x/mcp', headers: [] }],
  });
  const { id } = await b.create();
  b.chats.get(id).loaded = false;
  await b.watch(id, watcher());
  assert.ok(seen.some(m => m.method === 'session/new'));
  assert.ok(seen.some(m => m.method === 'session/load'));
  for (const m of seen.filter(x => x.method === 'session/new' || x.method === 'session/load')) {
    assert.equal(m.params.cwd, '/w');
    assert.equal(m.params.mcpServers[0].name, 'epost');
  }
});

/** A conversation with history, made by one broker, for another to load. */
async function kept(goose) {
  const first = broker(goose);
  const { id } = await first.create();
  await first.say(id, 'Erinnere dich');
  await settle();
  first.close();
  return id;
}

test('two devices opening a conversation at once see it once', async () => {
  const goose = fakeGoose();
  const id = await kept(goose);
  const b = broker(goose);
  const [one, two] = [watcher(), watcher()];
  await Promise.all([b.watch(id, one), b.watch(id, two)]);
  assert.equal(b.chats.get(id).events.length, 2);
  assert.equal(one.frames[0].events.length, 2);
  assert.equal(two.frames[0].events.length, 2);
});

test('a long conversation is trimmed, and the page gets it whole again', async () => {
  const goose = fakeGoose();
  const b = broker(goose);
  const { id } = await b.create();
  const w = watcher();
  await b.watch(id, w);
  b.chats.get(id).events = Array.from({ length: 2200 }, (_, i) => ({ type: 'note', text: String(i), closed: true }));
  await b.say(id, 'noch eins');
  await settle();
  const trimmed = w.frames.find(f => f.kind === 'snapshot' && f.events.length === 2000);
  assert.ok(trimmed, 'a snapshot after the trim');
  assert.equal(trimmed.events.at(-1).text, 'noch eins');
  assert.equal(trimmed.events[0].text, '201');
});

test('questions asked side by side wait in line, and Stop ends all of them', async () => {
  const goose = fakeGoose();
  const pushes = [];
  const b = broker(goose, pushes);
  const { id } = await b.create();
  await b.say(id, 'TWICE please');
  await settle();
  const c = b.chats.get(id);
  assert.equal(c.question.title, 'shell: ls');
  assert.equal(c.events[c.events.indexOf(c.question.event)].title, 'shell: ls');
  const early = watcher();
  await b.watch(id, early);
  assert.equal(c.events[early.frames[0].question.index].title, 'shell: ls', 'not the newest question');
  b.answer(id, 'allow');
  await settle();
  assert.equal(c.status, 'waiting');
  assert.equal(c.question.title, 'shell: pwd', 'the second comes up');
  // The page is pointed at the question that waits, not the newest one.
  const w = watcher();
  await b.watch(id, w);
  assert.equal(c.events[w.frames[0].question.index].title, 'shell: pwd');
  b.answer(id, 'allow');
  await settle();
  assert.equal(c.status, 'idle');
  assert.deepEqual(c.events.filter(e => e.type === 'question').map(e => e.answer), ['Allow', 'Allow']);

  await b.say(id, 'TWICE again');
  await settle();
  await b.stop(id);
  await settle();
  assert.equal(c.status, 'idle');
  assert.equal(c.question, null);
  assert.equal(c.queue.length, 0);
  assert.equal(c.events.at(-1).text, 'Stopped.');
});

test('the page never sees the request id of a question', async () => {
  const goose = fakeGoose();
  const b = broker(goose);
  const { id } = await b.create();
  const w = watcher();
  await b.watch(id, w);
  await b.say(id, 'TOOL');
  await settle();
  const status = w.frames.find(f => f.kind === 'status' && f.status === 'waiting');
  assert.deepEqual(Object.keys(status.question), ['title', 'options', 'index']);
  assert.equal(b.chats.get(id).events[status.question.index].type, 'question');
});

test('a conversation goose does not know is a 404, and is not kept', async () => {
  const b = broker(fakeGoose());
  await assert.rejects(b.open('nope'), err => err.status === 404);
  await assert.rejects(b.say('nope', 'hoi'), err => err.status === 404);
  assert.equal(b.chats.has('nope'), false);
});

test('a goose that does not answer runs into a deadline, and nothing is kept', async () => {
  const b = createChatBroker({ connect: fakeGoose().connect, cwd: '/w', answerMs: 30 });
  await assert.rejects(b.watch('hang', watcher()), /did not answer session\/load in 0 s/);
  assert.equal(b.chats.has('hang'), false);
});

test('deleted while it loads: the stream that waited for it is refused', async () => {
  const goose = fakeGoose({ loadDelayMs: 30 });
  const id = await kept(goose);
  const b = broker(goose);
  const w = watcher();
  const watching = b.watch(id, w);
  await b.remove(id);
  await assert.rejects(watching, err => err.status === 404);
  assert.equal(w.frames.length, 0);
});

test('idle conversations nobody watches are forgotten, the newest kept', async () => {
  const b = broker(fakeGoose());
  const ids = [];
  for (let i = 0; i < 35; i++) ids.push((await b.create()).id);
  assert.ok(b.chats.size <= 31, `${b.chats.size} kept`);
  assert.ok(b.chats.has(ids.at(-1)));
  assert.equal(b.chats.has(ids[0]), false);
});

test('a message goose garbles is skipped, and a request this side cannot serve is refused', async () => {
  const goose = fakeGoose();
  const sent = [];
  const lines = [];
  let socket;
  const b = createChatBroker({
    log: l => lines.push(l),
    connect: () => {
      socket = goose.connect();
      const send = socket.send;
      socket.send = raw => { sent.push(JSON.parse(raw)); send(raw); };
      return socket;
    },
    cwd: '/w',
  });
  await b.list();
  socket.onmessage({ data: '{"jsonrpc":"2.0","method":"session/update"}' });
  socket.onmessage({ data: 'not json' });
  socket.onmessage({ data: '{"jsonrpc":"2.0","id":"qx","method":"session/request_permission","params":{"sessionId":"s9","options":"x"}}' });
  assert.match(lines.join('\n'), /not understood/);
  socket.onmessage({ data: '{"jsonrpc":"2.0","id":7,"method":"fs/read_text_file","params":{"path":"/etc/passwd"}}' });
  assert.deepEqual(sent.at(-1), { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'not supported' } });
  assert.equal((await b.list()).length, 0, 'still connected');
});

test('a goose that refuses to start is closed, and the next call tries again', async () => {
  const goose = fakeGoose();
  let refuse = true;
  const b = createChatBroker({
    connect: () => {
      const ws = goose.connect();
      const send = ws.send;
      ws.send = raw => {
        const m = JSON.parse(raw);
        if (m.method === 'initialize' && refuse) {
          refuse = false;
          return queueMicrotask(() => ws.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'not now' } }) }));
        }
        return send(raw);
      };
      return ws;
    },
    cwd: '/w',
  });
  await assert.rejects(b.list(), /not now/);
  await settle();
  assert.equal(goose.sockets[0].closed, true);
  assert.deepEqual(await b.list(), []);
  assert.equal(goose.sockets.length, 2);
});

test('goose\'s words go to the page as rendered Markdown, drawn while somebody watches', async () => {
  const goose = fakeGoose();
  const renders = [];
  const b = createChatBroker({ connect: goose.connect, cwd: '/w', render: t => { renders.push(t); return `<p>${t}</p>`; }, renderMs: 5 });
  const { id } = await b.create();
  await b.say(id, 'Hoi');
  await settle();
  assert.deepEqual(renders, [], 'nobody watching, nothing drawn');
  const w = watcher();
  await b.watch(id, w);
  assert.deepEqual(w.frames[0].events.map(e => e.html ?? null), [null, '<p>Hallo zäme</p>'], 'the snapshot carries it');
  await b.say(id, 'Hoi nomau');
  await settle();
  assert.ok(w.frames.filter(f => f.kind === 'append').every(f => f.html === undefined), 'pieces go as text');
  const drawn = w.frames.filter(f => f.kind === 'replace' && f.event.type === 'agent');
  assert.equal(drawn.at(-1).event.html, '<p>Hallo zäme</p>', 'the whole answer, drawn once it is there');
  assert.ok(drawn.length <= 2, `${drawn.length} drawings for one answer`);
  assert.equal(w.frames.find(f => f.kind === 'event' && f.event.type === 'user' && f.event.text === 'Hoi nomau').event.html, undefined, 'what was typed stays text');
  assert.equal(b.chats.get(id).events.at(-1).html, undefined, 'the stored event keeps only its text');
});

test('an answer is drawn whole when it ends, however long the wait between drawings', async () => {
  const goose = fakeGoose();
  const b = createChatBroker({ connect: goose.connect, cwd: '/w', render: t => `<p>${t}</p>`, renderMs: 60_000 });
  const { id } = await b.create();
  const w = watcher();
  await b.watch(id, w);
  await b.say(id, 'Hoi');
  await settle();
  const drawn = w.frames.filter(f => f.kind === 'replace' && f.event.type === 'agent');
  assert.deepEqual(drawn.map(f => f.event.html), ['<p>Hallo zäme</p>']);
  b.close();
});
