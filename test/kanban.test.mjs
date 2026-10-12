import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createKanban, kanbanTools, parseBoards, parseBoard, parseCardForm, parseSearch, formatSubtasks, decode } from '../src/mcp/kanban.mjs';
import { serveStdio } from '../src/mcp/stdio.mjs';
import { jobCards } from '../src/run/cards.mjs';

// The pages in fixtures/kanban were rendered by upstream golang-kanban at
// 5307c5c, the commit the cluster runs, from boards made for the purpose.
// When the cluster moves to another commit, record them again from that one.
const page = name => readFileSync(new URL(`./fixtures/kanban/${name}`, import.meta.url), 'utf8');

test('the front page: each board with its slug and its card count', () => {
  assert.deepEqual(parseBoards(page('boards.html')), [
    { slug: 'main', name: 'Kanban Board', cards: 0 },
    { slug: 'aemtli', name: 'Ämtli', cards: 2 },
  ]);
});

test('a board: columns in order, cards with what html/template escaped put back', () => {
  const board = parseBoard(page('board.html'));
  assert.equal(board.name, 'Ämtli');
  assert.deepEqual(board.columns.map(c => [c.id, c.name, c.cards.length]), [[4, 'To Do', 1], [5, 'In Progress', 1], [6, 'Done', 0]]);
  assert.deepEqual(board.columns[0].cards[0], {
    id: 1,
    title: 'Rechnung <Swisscom> & "Co"',
    // The link the board makes of the address is taken out again.
    description: 'Zahlbar bis 31.10.\nhttps://example.com/a?b=1&c=2 ok',
    due: '2026-10-31',
    assignee: null,
    subtasks: [{ done: false, text: 'QR lesen' }, { done: true, text: 'zahlen | Valiant' }],
  });
  assert.equal(board.columns[1].cards[0].title, 'Steuererklärung');
  assert.equal(parseBoard(page('board-assigned.html')).columns[0].cards[0].assignee, 'helper@example.com');
});

test('the edit form: every field as stored, the column it is in and the ones it can go to', () => {
  assert.deepEqual(parseCardForm(page('card-edit.html')), {
    id: 1,
    title: 'Rechnung <Swisscom> & "Co"',
    description: 'Zahlbar bis 31.10.\nhttps://example.com/a?b=1&c=2 ok',
    due: '2026-10-31',
    subtasks: [{ done: false, text: 'QR lesen' }, { done: true, text: 'zahlen | Valiant' }],
    column: 'To Do',
    columnId: 4,
    columns: [{ id: 4, name: 'To Do' }, { id: 5, name: 'In Progress' }, { id: 6, name: 'Done' }],
    assignee: undefined,
  });
  assert.equal(parseCardForm(page('card-edit-assigned.html')).assignee, 'helper@example.com');
});

test('search: where each hit is, and no id for one in the archive', () => {
  assert.deepEqual(parseSearch(page('search.html')), [
    { id: 1, title: 'Rechnung <Swisscom> & "Co"', board: 'aemtli', boardName: 'Ämtli', column: 'To Do', archived: false },
    { id: 2, title: 'Steuererklärung', board: 'aemtli', boardName: 'Ämtli', column: 'In Progress', archived: false },
    { id: null, title: 'Weg damit', board: 'aemtli', boardName: 'Ämtli', column: 'Done', archived: true },
  ]);
});

test('subtasks go back in the stored form, one line each, whitespace folded', () => {
  assert.equal(formatSubtasks(['QR lesen', { text: 'zahlen\n  | Valiant', done: true }, '  ', { text: '' }]), '0|QR lesen\n1|zahlen | Valiant');
  assert.equal(formatSubtasks(undefined), '');
  assert.equal(decode('&#x41;&#66;&amp;&nbsp;&bogus;'), 'AB& &bogus;');
});

/** A board behind a fetch: the recorded pages, and every post written down. */
function fakeBoard({ edit = 'card-edit.html', status = {} } = {}) {
  const posts = [];
  const seen = [];
  const fetchImpl = async (url, init) => {
    const { pathname, search } = new URL(url);
    seen.push({ method: init.method, path: pathname + search, headers: init.headers });
    if (status[pathname]) return new Response(status[pathname].body, { status: status[pathname].code });
    if (init.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      posts.push({ path: pathname, form, htmx: init.headers['hx-request'] === 'true' });
      if (pathname === '/boards') return new Response(null, { status: 303, headers: { location: '/b/post' } });
      if (/\/card$|\/update$|\/subtask$|\/restore$/.test(pathname)) return new Response(page('card-created.html'));
      return new Response('OK');
    }
    const routes = { '/': 'boards.html', '/b/aemtli': 'board.html', '/card/1/edit': edit, '/search': 'search.html' };
    return routes[pathname] ? new Response(page(routes[pathname])) : new Response('404 page not found\n', { status: 404 });
  };
  return { posts, seen, kanban: createKanban({ baseUrl: 'http://kanban:17808/', fetchImpl }) };
}

test('a card goes into the column named, by name in any case or by id', async () => {
  const { kanban, posts } = fakeBoard();
  const made = await kanban.createCard('Ämtli', { title: 'Rechnung', description: 'bis Ende Monat', due: '2026-11-30', subtasks: ['zahlen'], column: 'in progress' });
  assert.deepEqual(posts[0], { path: '/b/aemtli/card', htmx: true, form: { title: 'Rechnung', description: 'bis Ende Monat', subtasks: '0|zahlen', due: '2026-11-30', lane: '5' } });
  assert.equal(made.id, 4, 'read back from the card the board answered');
  assert.equal(made.title, 'Neu');
  assert.equal(made.column, 'In Progress');
  await kanban.createCard('aemtli', { title: 'Ohne Spalte' });
  assert.equal(posts[1].form.lane, '4', 'the first column');
  await kanban.createCard('aemtli', { title: 'Nach Id', column: '6' });
  assert.equal(posts[2].form.lane, '6');
});

test('wrong board, column, date or id: refused with what there is, nothing posted', async () => {
  const { kanban, posts } = fakeBoard();
  await assert.rejects(kanban.createCard('Nirgends', { title: 'x' }), /no board "Nirgends"; there are: Kanban Board, Ämtli/);
  await assert.rejects(kanban.createCard('aemtli', { title: 'x', column: 'Doing' }), /no column "Doing"; there are: To Do, In Progress, Done/);
  await assert.rejects(kanban.createCard('aemtli', { title: 'x', due: '31.10.2026' }), /not a date/);
  await assert.rejects(kanban.getCard('1/../../boards'), err => err.status === 400);
  await assert.rejects(kanban.archiveCard(0), err => err.status === 400);
  assert.equal(posts.length, 0);
});

test('an update keeps every field it was not given', async () => {
  const { kanban, posts } = fakeBoard();
  await kanban.updateCard(1, { title: 'Rechnung Swisscom' });
  assert.deepEqual(posts[0].form, { title: 'Rechnung Swisscom', description: 'Zahlbar bis 31.10.\nhttps://example.com/a?b=1&c=2 ok', subtasks: '0|QR lesen\n1|zahlen | Valiant', due: '2026-10-31' });
  await kanban.updateCard(1, { due: '', subtasks: [], column: 'Done' });
  assert.deepEqual(posts[1].form, { title: 'Rechnung <Swisscom> & "Co"', description: 'Zahlbar bis 31.10.\nhttps://example.com/a?b=1&c=2 ok', subtasks: '', due: '', lane: '6' });
});

test('on a board that knows who is signed in, an update keeps the assignee', async () => {
  const { kanban, posts } = fakeBoard({ edit: 'card-edit-assigned.html' });
  await kanban.updateCard(1, { description: 'neu' });
  assert.equal(posts[0].form.assignee, 'helper@example.com');
});

test('move, tick, archive and restore post what the board expects', async () => {
  const { kanban, posts } = fakeBoard();
  assert.deepEqual(await kanban.moveCard(1, 'done'), { id: 1, column: 'Done' });
  await kanban.setSubtask(1, 1, false);
  await kanban.archiveCard(1);
  await kanban.restoreCard(1);
  assert.deepEqual(posts.map(p => [p.path, p.form]), [
    ['/card/1/move', { lane: '6' }],
    ['/card/1/subtask', { index: '1', text: 'zahlen | Valiant', done: '0' }],
    ['/card/1/archive', {}],
    ['/card/1/restore', {}],
  ]);
  await assert.rejects(kanban.setSubtask(1, 5, true), /has 2 subtasks; there is no number 5/);
});

test('a board is made once: the name that is there already is handed back', async () => {
  const { kanban, posts } = fakeBoard();
  assert.deepEqual(await kanban.createBoard('ämtli'), { slug: 'aemtli', name: 'Ämtli', created: false });
  assert.equal(posts.length, 0);
  assert.deepEqual(await kanban.createBoard(' Post '), { slug: 'post', name: 'Post', created: true });
  assert.deepEqual(posts[0].form, { name: ' Post ' });
});

test('search on one board passes its slug; an error answer carries the board\'s reason', async () => {
  const { kanban, seen } = fakeBoard({ status: { '/card/2/update': { code: 400, body: 'Empty card not allowed\n' } } });
  const { hits, truncated } = await kanban.search('Rechnung & Co', 'Ämtli');
  assert.equal(hits.length, 3);
  assert.equal(truncated, false);
  assert.equal(seen.at(-1).path, '/search?q=Rechnung+%26+Co&board=aemtli');
  const failing = createKanban({ baseUrl: 'http://k', fetchImpl: async () => new Response('Empty card not allowed\n', { status: 400 }) });
  await assert.rejects(failing.boards(), err => err.status === 400 && /answered 400: Empty card not allowed/.test(err.message));
});

test('a signed-in identity goes along with both its address and header, and one without the other is refused', async () => {
  const headers = [];
  const fetchImpl = async (url, init) => { headers.push(init.headers); return new Response(page('boards.html')); };
  await createKanban({ baseUrl: 'http://k', fetchImpl, as: 'owner@example.com', userHeader: 'Cf-Access-Authenticated-User-Email' }).boards();
  await createKanban({ baseUrl: 'http://k', fetchImpl }).boards();
  assert.equal(headers[0]['Cf-Access-Authenticated-User-Email'], 'owner@example.com');
  assert.deepEqual(headers[1], {});
  assert.throws(() => createKanban({ baseUrl: 'http://k', fetchImpl, as: 'owner@example.com' }), /go together/);
  assert.throws(() => createKanban({ baseUrl: 'http://k', fetchImpl, userHeader: 'X-User' }), /go together/);
});

test('a search the board cut at 100 says so', async () => {
  const cut = page('search.html').replace('</ul>', '</ul>\n  <p class="search-scope">Showing the first 100; add a word to narrow it down.</p>');
  const kanban = createKanban({ baseUrl: 'http://k', fetchImpl: async () => new Response(cut) });
  assert.equal((await kanban.search('e')).truncated, true);
});

test('an empty column is not the first column, and null leaves a field as it is', async () => {
  const { kanban, posts } = fakeBoard();
  await assert.rejects(kanban.moveCard(1, ''), /no column ""/);
  await assert.rejects(kanban.moveCard(1, undefined), /no column ""/);
  await assert.rejects(kanban.updateCard(1, { column: '' }), /no column ""/);
  assert.equal(posts.length, 0);
  await kanban.updateCard(1, { due: null, description: null, column: null, title: 'Neu' });
  assert.deepEqual(posts[0].form, { title: 'Neu', description: 'Zahlbar bis 31.10.\nhttps://example.com/a?b=1&c=2 ok', subtasks: '0|QR lesen\n1|zahlen | Valiant', due: '2026-10-31' });
});

test('on a board with one column a card cannot be sent to another', async () => {
  const single = page('card-edit.html').replace(/<label class="field">\s*<span>Column<\/span>[\s\S]*?<\/label>/, '');
  assert.equal(parseCardForm(single).columns.length, 0);
  const posts = [];
  const kanban = createKanban({ baseUrl: 'http://k', fetchImpl: async (url, init) => { if (init.method === 'POST') posts.push(url); return new Response(single); } });
  await assert.rejects(kanban.updateCard(1, { column: 'Done' }), /only one column/);
  await assert.rejects(kanban.moveCard(1, 'Done'), /only one column/);
  assert.equal(posts.length, 0);
});

test('two changes to one card at once run one after the other', async () => {
  const order = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    order.push(`${init.method} ${path}`);
    if (init.method === 'GET') {
      if (order.length === 1) await gate;
      return new Response(page('card-edit.html'));
    }
    return new Response(page('card-created.html'));
  };
  const kanban = createKanban({ baseUrl: 'http://k', fetchImpl });
  const both = Promise.all([kanban.updateCard(1, { title: 'A' }), kanban.setSubtask(1, 0, true), kanban.archiveCard(1), kanban.updateCard(2, { title: 'other card' }).catch(() => {})]);
  await new Promise(r => setTimeout(r, 10));
  release();
  await both;
  const one = order.filter(o => o.includes('/card/1/'));
  assert.deepEqual(one, ['GET /card/1/edit', 'POST /card/1/update', 'GET /card/1/edit', 'POST /card/1/subtask', 'POST /card/1/archive']);
  assert.equal(order[1], 'GET /card/2/edit', 'another card does not wait');
  // A failed change does not hold up the next.
  const failing = createKanban({ baseUrl: 'http://k', fetchImpl: async () => new Response('down', { status: 500 }) });
  await assert.rejects(failing.updateCard(3, { title: 'x' }));
  await assert.rejects(failing.updateCard(3, { title: 'y' }), /answered 500/);
});

test('a job finds its card through the real search page', async () => {
  const { kanban, seen, posts } = fakeBoard();
  const tools = Object.fromEntries(kanbanTools(kanban).map(t => [t.name, t]));
  const client = { json: async (name, args) => JSON.parse(JSON.stringify(await tools[name].run(args))) };
  const found = await jobCards(client, { board: 'Ämtli' }).ensure('epost-A1', { title: 'Rechnung' });
  assert.deepEqual(found, { id: 1, created: false, archived: false });
  assert.ok(seen.some(r => r.path === `/search?q=${encodeURIComponent('[ämtli:epost-a1]')}&board=aemtli`));
  assert.equal(posts.length, 0);
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
  const { kanban } = fakeBoard();
  const s = stdio(kanbanTools(kanban));
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kanban_list_boards', arguments: {} } });
  s.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'kanban_move_card', arguments: { card_id: 1, column: 'Nirgends' } } });
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
  assert.equal(JSON.parse(by(3).result.content[0].text).boards[1].slug, 'aemtli');
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
  await tools.kanban_get_card.run({ card_id: 1 });
  await tools.kanban_search.run({ query: 'q', board: 'b' });
  await tools.kanban_create_card.run({ board: 'b', title: 't' });
  await tools.kanban_update_card.run({ card_id: 1, title: 't' });
  await tools.kanban_move_card.run({ card_id: 1, column: 'c' });
  await tools.kanban_set_subtask.run({ card_id: 1, index: 0, done: true });
  await tools.kanban_archive_card.run({ card_id: 1 });
  await tools.kanban_restore_card.run({ card_id: 1 });
  await tools.kanban_create_board.run({ name: 'n' });
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [
    ['boards'], ['readBoard', 'b'], ['getCard', 1], ['search', 'q', 'b'],
    ['createCard', 'b', { board: 'b', title: 't' }], ['updateCard', 1, { card_id: 1, title: 't' }],
    ['moveCard', 1, 'c'], ['setSubtask', 1, 0], ['archiveCard', 1], ['restoreCard', 1], ['createBoard', 'n'],
  ]);
  assert.equal(calls[7][3], true);
});
