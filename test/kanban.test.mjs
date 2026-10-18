import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createKanban, kanbanTools, toSubtasks } from '../src/mcp/kanban.mjs';
import { serveStdio } from '../src/mcp/stdio.mjs';
import { jobCards } from '../src/run/cards.mjs';
import { fakeByge } from './fixtures/fake-byge.mjs';

const SERVICE = { as: 'aemtli', userHeader: 'X-Byge-Service' };

/** The board the tests start from: Ämtli with three cards, and a board the service is not granted. */
function setUp({ grants = ['aemtli', 'haus'], readOnly = [] } = {}) {
  const byge = fakeByge({ boards: [{ name: 'Ämtli', slug: 'aemtli' }, { name: 'Haus', slug: 'haus', columns: ['Offen'] }, { name: 'Privat', slug: 'privat' }], grants, readOnly });
  const bill = byge.addCard('aemtli', { title: 'Rechnung', description: 'Zahlbar bis 31.10.\n[ämtli:epost-a1]', due_date: '2026-10-31', assignee: 'owner@example.com', labels: ['l1'], subtasks: ['QR lesen', { title: 'zahlen', done: true }] });
  const later = byge.addCard('aemtli', { title: 'Später', column: 1 });
  const old = byge.addCard('aemtli', { title: 'Alte Frist', description: '[ämtli:frist-x]', archived: true });
  byge.addCard('privat', { title: 'Geheim [ämtli:epost-a1]' });
  const kanban = createKanban({ baseUrl: 'http://kanban:17808/', fetchImpl: byge.fetchImpl, ...SERVICE });
  return { byge, kanban, bill, later, old };
}

const writes = byge => byge.seen.filter(r => r.method !== 'GET');

test('the boards the service may read, with their card counts, and the header on every request', async () => {
  const { byge, kanban } = setUp();
  assert.deepEqual(await kanban.boards(), [{ slug: 'aemtli', name: 'Ämtli', cards: 2 }, { slug: 'haus', name: 'Haus', cards: 0 }]);
  assert.ok(byge.seen.every(r => r.headers['X-Byge-Service'] === 'aemtli' && r.path.startsWith('/api/v1/')));
  assert.equal(byge.seen[0].path, '/api/v1/boards');
});

test('a board it may not read, or none at all: the error says how to grant one', async () => {
  const { kanban } = setUp();
  await assert.rejects(kanban.readBoard('privat'), /the board "privat" is there, but this service may not read it; grant the group "aemtli" write on the board's access page/);
  await assert.rejects(kanban.readBoard('Nirgends'), /no board "Nirgends" this service may read; there are: Ämtli, Haus$/);
  const none = setUp({ grants: [] });
  await assert.rejects(none.kanban.readBoard('home-improvement'), /no board "home-improvement" this service may read; there are: none\. A board shows here once it grants this service: grant the group "aemtli"/);
  assert.deepEqual(await none.kanban.boards(), []);
  // Without the service header byge sees an anonymous caller and grants it nothing.
  const anonymous = createKanban({ baseUrl: 'http://k', fetchImpl: none.byge.fetchImpl });
  await assert.rejects(anonymous.readBoard('aemtli'), /grant the group of this service/);
});

test('a board: columns left to right, cards in order, each as the tools show it', async () => {
  const { kanban, bill, later } = setUp();
  const board = await kanban.readBoard('Ämtli');
  assert.equal(board.slug, 'aemtli');
  assert.equal(board.name, 'Ämtli');
  assert.deepEqual(board.columns.map(c => [c.name, c.cards.map(x => x.title)]), [['To Do', ['Rechnung']], ['In Progress', ['Später']], ['Done', []]]);
  assert.deepEqual(board.columns[0].cards[0], {
    id: bill.id, title: 'Rechnung', description: 'Zahlbar bis 31.10.\n[ämtli:epost-a1]', due: '2026-10-31', assignee: 'owner@example.com',
    subtasks: [{ done: false, text: 'QR lesen' }, { done: true, text: 'zahlen' }],
  });
  assert.deepEqual(board.columns[1].cards[0], { id: later.id, title: 'Später', description: '', due: null, assignee: null, subtasks: [] });
  assert.equal((await kanban.readBoard('AEMTLI')).slug, 'aemtli', 'a slug in any case');
});

test('a card with every field, the column it is in, and the ones it can go to', async () => {
  const { kanban, bill, old } = setUp();
  const card = await kanban.getCard(bill.id.toUpperCase());
  assert.equal(card.column, 'To Do');
  assert.deepEqual(card.columns.map(c => c.name), ['To Do', 'In Progress', 'Done']);
  assert.equal(card.columnId, card.columns[0].id);
  assert.equal(card.archived, false);
  assert.equal((await kanban.getCard(old.id)).archived, true);
  await assert.rejects(kanban.getCard('zzzzzzzzzzzzzzzzzzzzzzzzzz'), /no card zzzz.* on the board/);
});

test('a card goes into the column named, by name in any case or by id, with only the fields byge takes', async () => {
  const { byge, kanban } = setUp();
  const made = await kanban.createCard('Ämtli', { title: 'Rechnung 2', description: 'bis Ende Monat', due: '2026-11-30', subtasks: ['zahlen', { text: '  quittung   ablegen ', done: true }, '  '], column: 'in progress' });
  assert.equal(made.column, 'In Progress');
  assert.equal(made.board, 'aemtli');
  assert.deepEqual(made.subtasks, [{ done: false, text: 'zahlen' }, { done: true, text: 'quittung ablegen' }]);
  assert.deepEqual(writes(byge)[0].body, {
    column_id: (await kanban.getCard(made.id)).columnId, title: 'Rechnung 2', description: 'bis Ende Monat', due_date: '2026-11-30', assignee: '', labels: [],
    subtasks: [{ title: 'zahlen', done: false }, { title: 'quittung ablegen', done: true }],
  });
  const first = await kanban.createCard('aemtli', { title: 'Ohne Spalte' });
  assert.equal(first.column, 'To Do', 'the first column');
  const columns = (await kanban.readBoard('aemtli')).columns;
  assert.equal((await kanban.createCard('aemtli', { title: 'Nach Id', column: columns[2].id })).column, 'Done');
});

test('wrong board, column, date or id: refused with what there is, nothing written', async () => {
  const { byge, kanban, bill } = setUp();
  await assert.rejects(kanban.createCard('aemtli', { title: 'x', column: 'Nirgends' }), /no column "Nirgends"; there are: To Do, In Progress, Done/);
  await assert.rejects(kanban.createCard('aemtli', { title: 'x', due: '31.10.2026' }), /not a date/);
  await assert.rejects(kanban.updateCard(bill.id, { due: 'morgen' }), /not a date/);
  for (const id of ['../boards', '1 2', '', null, 'x'.repeat(65)]) await assert.rejects(kanban.archiveCard(id), /is not a card id/, String(id));
  await assert.rejects(kanban.getCard('a/b'), /is not a card id/);
  assert.equal(writes(byge).length, 0);
});

test('an update keeps every field it was not given, and a checklist keeps its lines where the text is the same', async () => {
  const { byge, kanban, bill } = setUp();
  const before = byge.state.cards.find(c => c.id === bill.id).subtasks;
  const zahlen = before.find(s => s.title === 'zahlen').id;
  const updated = await kanban.updateCard(bill.id, { title: 'Rechnung Swisscom', subtasks: [{ text: 'zahlen', done: true }, 'ablegen'] });
  assert.equal(updated.title, 'Rechnung Swisscom');
  assert.equal(updated.due, '2026-10-31');
  assert.equal(updated.assignee, 'owner@example.com');
  const put = writes(byge)[0];
  assert.equal(put.method, 'PUT');
  assert.deepEqual(put.body, {
    title: 'Rechnung Swisscom', description: 'Zahlbar bis 31.10.\n[ämtli:epost-a1]', due_date: '2026-10-31', assignee: 'owner@example.com', labels: ['l1'],
    subtasks: [{ id: zahlen, title: 'zahlen', done: true }, { title: 'ablegen', done: false }],
  });
  // null and undefined leave a field alone; an empty date takes it off.
  const again = await kanban.updateCard(bill.id, { due: '', description: null, title: undefined, column: null });
  assert.equal(again.due, null);
  assert.equal(again.description, 'Zahlbar bis 31.10.\n[ämtli:epost-a1]');
  assert.deepEqual(writes(byge)[1].body.subtasks.map(s => s.title), ['zahlen', 'ablegen'], 'the checklist as it was');
});

test('naming a column moves the card to the end of it', async () => {
  const { byge, kanban, bill, later } = setUp();
  const moved = await kanban.updateCard(bill.id, { column: 'in progress' });
  assert.equal(moved.title, 'Rechnung');
  const board = await kanban.readBoard('aemtli');
  assert.deepEqual(board.columns[1].cards.map(c => c.id), [later.id, bill.id]);
  const order = writes(byge).find(r => r.method === 'PUT' && r.path.endsWith('/cards/order'));
  assert.deepEqual(order.body, { order: [later.id, bill.id] });
  assert.deepEqual(await kanban.moveCard(later.id, 'Done'), { id: later.id, column: 'Done' });
  assert.deepEqual((await kanban.readBoard('aemtli')).columns.map(c => c.cards.length), [0, 1, 1]);
});

test('an empty column is not the first column, and a board with one column offers no other', async () => {
  const { byge, kanban, bill } = setUp();
  await assert.rejects(kanban.moveCard(bill.id, ''), /no column ""/);
  await assert.rejects(kanban.moveCard(bill.id, undefined), /no column ""/);
  await assert.rejects(kanban.updateCard(bill.id, { column: '' }), /no column ""/);
  const single = await kanban.createCard('haus', { title: 'Fenster' });
  await assert.rejects(kanban.updateCard(single.id, { column: 'Done' }), /only one column/);
  await assert.rejects(kanban.moveCard(single.id, 'Done'), /only one column/);
  assert.equal(writes(byge).length, 1, 'only the card that was made');
});

test('ticking a checklist line counts from 0 in the order on the card and keeps the others', async () => {
  const { byge, kanban, bill } = setUp();
  const ticked = await kanban.setSubtask(bill.id, 0, true);
  assert.deepEqual(ticked.subtasks, [{ done: true, text: 'QR lesen' }, { done: true, text: 'zahlen' }]);
  assert.ok(writes(byge)[0].body.subtasks.every(s => s.id), 'every line by its id');
  assert.deepEqual((await kanban.setSubtask(bill.id, 1, false)).subtasks.map(s => s.done), [true, false]);
  await assert.rejects(kanban.setSubtask(bill.id, 2, true), /has 2 subtasks; there is no number 2/);
});

test('archive and restore', async () => {
  const { byge, kanban, bill } = setUp();
  assert.deepEqual(await kanban.archiveCard(bill.id), { id: bill.id, archived: true });
  assert.equal((await kanban.readBoard('aemtli')).columns[0].cards.length, 0);
  assert.deepEqual(await kanban.restoreCard(bill.id), { id: bill.id, archived: false });
  assert.deepEqual(writes(byge).map(r => `${r.method} ${r.path}`), [`POST /api/v1/cards/${bill.id}/archive`, `POST /api/v1/cards/${bill.id}/restore`]);
});

test('search: every word, in title, description or checklist, archived ones too, on the boards it may read', async () => {
  const { kanban, bill, old } = setUp();
  assert.deepEqual(await kanban.search('[ämtli:epost-a1]'), { hits: [{ id: bill.id, title: 'Rechnung', board: 'aemtli', boardName: 'Ämtli', column: 'To Do', archived: false }], truncated: false }, 'not the card on the board it may not read');
  assert.deepEqual((await kanban.search('QR rechnung')).hits.map(h => h.id), [bill.id], 'all words, any case, the checklist too');
  assert.deepEqual((await kanban.search('[ämtli:frist-x]', 'Ämtli')).hits.map(h => [h.id, h.archived]), [[old.id, true]]);
  assert.deepEqual((await kanban.search('rechnung', 'haus')).hits, []);
  assert.deepEqual((await kanban.search('[ämtli:epost-a]')).hits, [], 'a reference never finds a longer one');
  await assert.rejects(kanban.search('   '), /at least one word/);
});

test('a search stops at 100 and says so', async () => {
  const { byge, kanban } = setUp();
  for (let i = 0; i < 101; i += 1) byge.addCard('haus', { title: `Fenster ${i}` });
  const found = await kanban.search('fenster');
  assert.equal(found.hits.length, 100);
  assert.equal(found.truncated, true);
});

test('a board is made once: the name that is there already is handed back, one hidden from the service says so', async () => {
  const { byge, kanban } = setUp();
  assert.deepEqual(await kanban.createBoard('ämtli'), { slug: 'aemtli', name: 'Ämtli', created: false });
  assert.equal(writes(byge).length, 0);
  assert.deepEqual(await kanban.createBoard('Garten'), { slug: 'garten', name: 'Garten', created: true });
  assert.deepEqual(writes(byge)[0].body, { name: 'Garten' });
  await assert.rejects(kanban.createBoard('Privat'), /a board "Privat" is there, but this service may not read it; grant the group "aemtli"/);
  await assert.rejects(kanban.createBoard(''), /answered 400: a board needs a name \(name\)/);
});

test('a board the service may read but not write: the refusal says what to grant', async () => {
  const { kanban, bill } = setUp({ readOnly: ['aemtli'] });
  await assert.rejects(kanban.updateCard(bill.id, { title: 'x' }), /answered 403: forbidden; grant the group "aemtli" write/);
  await assert.rejects(kanban.createCard('aemtli', { title: 'x' }), /answered 403/);
});

test('an answer that is not JSON still carries its reason', async () => {
  const kanban = createKanban({ baseUrl: 'http://k', ...SERVICE, fetchImpl: async () => ({ status: 502, statusText: 'Bad Gateway', text: async () => '<html>bad gateway</html>' }) });
  await assert.rejects(kanban.boards(), /answered 502: <html>bad gateway<\/html>/);
  const empty = createKanban({ baseUrl: 'http://k', ...SERVICE, fetchImpl: async () => ({ status: 500, statusText: 'Internal Server Error', text: async () => '' }) });
  await assert.rejects(empty.boards(), /answered 500: Internal Server Error/);
});

test('the service identity goes along as its header, and one setting without the other is refused', async () => {
  const headers = [];
  const fetchImpl = async (url, init) => { headers.push(init.headers); return { status: 200, text: async () => '[]' }; };
  await createKanban({ baseUrl: 'http://k', fetchImpl, ...SERVICE }).boards();
  await createKanban({ baseUrl: 'http://k', fetchImpl }).boards();
  assert.equal(headers[0]['X-Byge-Service'], 'aemtli');
  assert.equal(headers[1]['X-Byge-Service'], undefined);
  assert.throws(() => createKanban({ baseUrl: 'http://k', fetchImpl, as: 'aemtli' }), /go together/);
  assert.throws(() => createKanban({ baseUrl: 'http://k', fetchImpl, userHeader: 'X-Byge-Service' }), /go together/);
});

test('a checklist given to a tool: strings are open items, whitespace folded, empty lines gone, same text keeps its id', () => {
  assert.deepEqual(toSubtasks(['a', { text: ' b  c ', done: 1 }, '', { text: '' }]), [{ title: 'a', done: false }, { title: 'b c', done: true }]);
  assert.deepEqual(toSubtasks(['x', 'x'], [{ id: 's1', title: 'x' }]), [{ id: 's1', title: 'x', done: false }, { title: 'x', done: false }], 'each existing line once');
  assert.deepEqual(toSubtasks(undefined), []);
});

test('two changes to one card at once run one after the other', async () => {
  const { byge, kanban, bill, later } = setUp();
  const order = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const slow = createKanban({
    baseUrl: 'http://k', ...SERVICE,
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      order.push(`${init.method} ${path}`);
      if (order.length === 1) await gate;
      return byge.fetchImpl(url, init);
    },
  });
  const both = Promise.all([slow.updateCard(bill.id, { title: 'A' }), slow.setSubtask(bill.id, 0, true), slow.archiveCard(bill.id), slow.updateCard(later.id, { title: 'other card' })]);
  await new Promise(r => setTimeout(r, 10));
  release();
  await both;
  const one = order.filter(o => o.includes(bill.id));
  assert.deepEqual(one, [`GET /api/v1/cards/${bill.id}`, `PUT /api/v1/cards/${bill.id}`, `GET /api/v1/cards/${bill.id}`, `PUT /api/v1/cards/${bill.id}`, `POST /api/v1/cards/${bill.id}/archive`]);
  assert.equal(order[1], `GET /api/v1/cards/${later.id}`, 'another card does not wait');
  assert.equal(kanban !== slow, true);
  // A failed change does not hold up the next.
  const failing = createKanban({ baseUrl: 'http://k', ...SERVICE, fetchImpl: async () => ({ status: 500, text: async () => '{"error":"internal error"}' }) });
  await assert.rejects(failing.updateCard(bill.id, { title: 'x' }));
  await assert.rejects(failing.updateCard(bill.id, { title: 'y' }), /answered 500: internal error/);
});

test('a job keeps its card through the tools: made once, found again, not made again once archived', async () => {
  const { byge, kanban, bill } = setUp();
  const tools = Object.fromEntries(kanbanTools(kanban).map(t => [t.name, t]));
  const client = { json: async (name, args) => JSON.parse(JSON.stringify(await tools[name].run(args))) };
  const cards = jobCards(client, { board: 'Ämtli', baseUrl: 'https://kanban.example' });
  assert.deepEqual(await cards.ensure('epost-A1', { title: 'Rechnung' }), { id: bill.id, created: false, archived: false, url: `https://kanban.example/b/aemtli#card-${bill.id}` });
  const made = await cards.ensure('epost-B2', { title: 'Neue Rechnung', column: 'In Progress' });
  assert.equal(made.created, true);
  assert.equal(await cards.done('epost-B2'), true);
  assert.equal((await kanban.getCard(made.id)).column, 'Done');
  await kanban.archiveCard(made.id);
  assert.deepEqual(await cards.ensure('epost-B2', { title: 'Neue Rechnung' }), { id: made.id, created: false, archived: true, url: null });
  assert.equal(byge.state.cards.filter(c => c.description.includes('[ämtli:epost-b2]')).length, 1);
});

/** Talks to a stdio server: lines in, lines out. */
function stdio(tools) {
  const input = new PassThrough();
  const output = new PassThrough();
  const logged = [];
  const out = [];
  output.on('data', d => out.push(...d.toString().split('\n').filter(Boolean).map(l => JSON.parse(l))));
  const done = serveStdio({ name: 't', version: '1', tools, input, output, log: l => logged.push(l) });
  const send = m => input.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
  return { send, out, logged, done, end: () => input.end() };
}

const settle = () => new Promise(r => setTimeout(r, 20));

test('the stdio server: initialize, the tool list, a call, a failing call, and what it does not know', async () => {
  const { kanban, bill } = setUp();
  const s = stdio(kanbanTools(kanban));
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kanban_list_boards', arguments: {} } });
  s.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'kanban_move_card', arguments: { card_id: bill.id, column: 'Nirgends' } } });
  s.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'kanban_delete_card', arguments: {} } });
  s.send({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
  s.send({ jsonrpc: '2.0', id: 7, method: 'ping' });
  s.send({ jsonrpc: '2.0', id: 8, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  s.send('not json');
  s.send('null');
  s.send('[1]');
  await settle();
  const by = id => s.out.find(m => m.id === id);
  assert.deepEqual(by(1).result, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } });
  assert.deepEqual(by(2).result.tools.map(t => t.name), ['kanban_list_boards', 'kanban_read_board', 'kanban_get_card', 'kanban_search', 'kanban_create_card', 'kanban_update_card', 'kanban_move_card', 'kanban_set_subtask', 'kanban_archive_card', 'kanban_restore_card', 'kanban_create_board']);
  assert.ok(by(2).result.tools.every(t => t.inputSchema.type === 'object' && t.description && t.annotations));
  assert.equal(by(2).result.tools.find(t => t.name === 'kanban_get_card').inputSchema.properties.card_id.type, 'string', "byge's ids are strings");
  assert.equal(JSON.parse(by(3).result.content[0].text).boards[0].slug, 'aemtli');
  assert.equal(by(4).result.isError, true);
  assert.match(by(4).result.content[0].text, /no column "Nirgends"/);
  assert.match(s.logged[0], /kanban_move_card: no column/);
  assert.equal(by(5).error.code, -32602);
  assert.equal(by(6).error.code, -32601);
  assert.deepEqual(by(7).result, {});
  assert.equal(by(8).result.protocolVersion, '2025-06-18', 'a version it does not speak gets its own');
  assert.deepEqual(s.out.filter(m => m.id === null).map(m => m.error.code), [-32700, -32600, -32600]);
  assert.equal(s.out.length, 11, 'nothing for the notification');
  s.end();
  await s.done;
});

test('every tool reaches the client with its arguments', async () => {
  const calls = [];
  const spy = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); return name === 'boards' || name === 'search' ? [] : {}; } });
  const tools = Object.fromEntries(kanbanTools(spy).map(t => [t.name, t]));
  await tools.kanban_list_boards.run({});
  await tools.kanban_read_board.run({ board: 'b' });
  await tools.kanban_get_card.run({ card_id: 'c1' });
  await tools.kanban_search.run({ query: 'q', board: 'b' });
  await tools.kanban_create_card.run({ board: 'b', title: 't' });
  await tools.kanban_update_card.run({ card_id: 'c1', title: 't' });
  await tools.kanban_move_card.run({ card_id: 'c1', column: 'c' });
  await tools.kanban_set_subtask.run({ card_id: 'c1', index: 0, done: true });
  await tools.kanban_archive_card.run({ card_id: 'c1' });
  await tools.kanban_restore_card.run({ card_id: 'c1' });
  await tools.kanban_create_board.run({ name: 'n' });
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [
    ['boards'], ['readBoard', 'b'], ['getCard', 'c1'], ['search', 'q', 'b'],
    ['createCard', 'b', { board: 'b', title: 't' }], ['updateCard', 'c1', { card_id: 'c1', title: 't' }],
    ['moveCard', 'c1', 'c'], ['setSubtask', 'c1', 0], ['archiveCard', 'c1'], ['restoreCard', 'c1'], ['createBoard', 'n'],
  ]);
  assert.equal(calls[7][3], true);
});
