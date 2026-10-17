import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatBroker, readImages } from '../src/web/chats.mjs';
import { fakeGoose, PNG, JPEG } from './fixtures/fake-goose-acp.mjs';

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

test('a goose that will not even say it stopped leaves the conversation usable', async () => {
  const goose = fakeGoose();
  const b = createChatBroker({ connect: goose.connect, cwd: '/w', answerMs: 40 });
  const { id } = await b.create();
  const w = watcher();
  await b.watch(id, w);
  await b.say(id, 'SLOW');
  await settle();
  const c = b.chats.get(id);
  assert.equal(c.status, 'running');
  // The fake answers session/cancel, so take that away first.
  goose.sockets.at(-1).send = () => {};
  await b.stop(id);
  assert.equal(c.status, 'running', 'nothing said yet');
  await new Promise(r => setTimeout(r, 80));
  assert.equal(c.status, 'idle');
  assert.match(c.events.at(-1).text, /did not say that it stopped/);
  b.close();
});

test('a stop that goose never answers does not reach the next turn', async () => {
  const goose = fakeGoose();
  const b = createChatBroker({ connect: goose.connect, cwd: '/w', answerMs: 60 });
  const { id } = await b.create();
  const c = b.chats.get(id);
  await b.say(id, 'SLOW');
  await settle();
  const quiet = goose.sockets.at(-1).send;
  goose.sockets.at(-1).send = () => {};
  await b.stop(id);
  // The turn ends by itself after all, and the next one starts.
  goose.sockets.at(-1).send = quiet;
  c.status = 'idle';
  await b.say(id, 'SLOW again');
  await settle();
  assert.equal(c.status, 'running');
  await new Promise(r => setTimeout(r, 110));
  assert.equal(c.status, 'running', 'the old stop left this turn alone');
  assert.ok(!c.events.some(e => /did not say that it stopped/.test(e.text ?? '')));
  b.close();
});

test('images: checked by their bytes, at most six, small enough for the model', () => {
  const png = { mimeType: 'image/png', data: PNG };
  assert.deepEqual(readImages(undefined), []);
  assert.deepEqual(readImages([png, { mimeType: 'image/jpeg', data: JPEG }]), [png, { mimeType: 'image/jpeg', data: JPEG }]);
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1').toString('base64');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]).toString('base64');
  assert.equal(readImages([{ mimeType: 'image/gif', data: gif }, { mimeType: 'image/webp', data: webp }]).length, 2);
  const refused = (images, pattern) => assert.throws(() => readImages(images), err => err.status === 400 && pattern.test(err.message), String(pattern));
  refused('x', /must be a list/);
  refused(Array(7).fill(png), /at most 6 images/);
  refused([{ mimeType: 'image/svg+xml', data: PNG }], /image 1: only JPEG, PNG, GIF and WebP/);
  refused([{ mimeType: 'toString', data: PNG }], /only JPEG/);
  refused([{ mimeType: ['image/png'], data: PNG }], /only JPEG/);
  refused([null], /only JPEG/);
  refused([png, { mimeType: 'image/png', data: 'not base64!' }], /image 2: the data must be base64/);
  refused([{ mimeType: 'image/png', data: 'abc' }], /must be base64/);
  refused([{ mimeType: 'image/jpeg', data: PNG }], /image 1 is not the JPEG it says it is/);
  refused([{ mimeType: 'image/png', data: PNG + 'A'.repeat(5 * 1024 * 1024) }], /larger than the model takes/);
  const big = { mimeType: 'image/png', data: PNG + 'A'.repeat(4.5 * 1024 * 1024) };
  refused([big, big, big], /together are larger than one message can carry/);
});

test('a message with images: the prompt carries them after the text, the page gets them by id', async () => {
  const goose = fakeGoose();
  const pushes = [];
  const b = broker(goose, pushes);
  const { id } = await b.create();
  const w = watcher();
  await b.watch(id, w);
  await b.say(id, 'Was steht da?', [{ mimeType: 'image/jpeg', data: JPEG }]);
  await settle();
  assert.deepEqual(goose.prompts.at(-1), [{ type: 'text', text: 'Was steht da?' }, { type: 'image', mimeType: 'image/jpeg', data: JPEG }]);
  const said = b.chats.get(id).events[0];
  assert.equal(said.images.length, 1);
  assert.equal(said.images[0].mimeType, 'image/jpeg');
  assert.doesNotMatch(JSON.stringify(w.frames), new RegExp(JPEG.slice(0, 8).replace(/[+/]/g, '\\$&')), 'the stream carries ids, not the bytes');
  const got = b.image(id, said.images[0].id);
  assert.deepEqual(got, { mimeType: 'image/jpeg', data: Buffer.from(JPEG, 'base64') });
  assert.equal(b.image('another', said.images[0].id), null, 'only for the conversation it belongs to');

  // An image alone is a message too.
  b.chats.get(id).watchers.clear();
  await b.say(id, '', [{ mimeType: 'image/png', data: PNG }]);
  await settle();
  assert.deepEqual(goose.prompts.at(-1), [{ type: 'image', mimeType: 'image/png', data: PNG }]);
  assert.equal(pushes.at(-1).message, 'Bild', 'a push for an image alone, before goose named the chat');
});

test('images come back with the history, and an answer can carry one', async () => {
  const goose = fakeGoose();
  const first = broker(goose);
  const { id } = await first.create();
  await first.say(id, 'Show me a PICTURE', [{ mimeType: 'image/png', data: PNG }]);
  await settle();
  const answer = first.chats.get(id).events.at(-1);
  assert.equal(answer.type, 'agent');
  assert.equal(answer.images.length, 1, 'an image in the answer is shown');
  first.close();

  const second = broker(goose);
  const w = watcher();
  await second.watch(id, w);
  const [user, agent] = w.frames[0].events;
  assert.equal(user.text, 'Show me a PICTURE');
  assert.equal(user.images.length, 1, 'the image stays with the message it came with');
  assert.equal(agent.images.length, 1);
  assert.equal(second.image(id, user.images[0].id).mimeType, 'image/png');
  // Loaded again: the old ids go, the new ones replace them.
  const before = second.images.size;
  second.chats.get(id).loaded = false;
  second.chats.get(id).watchers.clear();
  await second.open(id);
  assert.equal(second.images.size, before);
  assert.equal(second.image(id, user.images[0].id), null);
  await second.remove(id);
  assert.equal(second.images.size, 0, 'a deleted conversation keeps no images');
});

test('an image goose sends that the page cannot show, or that is not what it says, is left out', async () => {
  const goose = fakeGoose();
  const b = broker(goose);
  const { id } = await b.create();
  goose.sessions.get(id).push({ role: 'user', text: '', blocks: [
    { type: 'image', mimeType: 'image/svg+xml', data: PNG },
    { type: 'image', mimeType: 'image/jpeg', data: PNG },
    { type: 'image', mimeType: ['image/png'], data: PNG },
    { type: 'image', mimeType: 'image/png', data: PNG + 'A'.repeat(5 * 1024 * 1024) },
    { type: 'text', text: 'and words' },
  ] });
  b.chats.get(id).loaded = false;
  await b.open(id);
  assert.deepEqual(b.chats.get(id).events.map(e => [e.type, e.text, e.images]), [['user', 'and words', undefined]]);
  assert.equal(b.images.size, 0);
});

test('images past the memory they may take go oldest first', async () => {
  const goose = fakeGoose();
  const b = createChatBroker({ connect: goose.connect, cwd: '/w', imageMemory: 20 });
  const { id } = await b.create();
  await b.say(id, 'one', [{ mimeType: 'image/png', data: PNG }]);
  await settle();
  await b.say(id, 'two', [{ mimeType: 'image/jpeg', data: JPEG }]);
  await settle();
  const [one, , two] = b.chats.get(id).events;
  assert.equal(b.image(id, one.images[0].id), null, '12 + 9 bytes is over 20');
  assert.equal(b.image(id, two.images[0].id).mimeType, 'image/jpeg');
});
