import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobCards, mark } from '../src/run/cards.mjs';

/** The kanban tools a job uses, over a board kept in memory. */
function fakeKanban({ boards = [] } = {}) {
  const calls = [];
  const cards = [];
  const columns = ['To Do', 'In Progress', 'Done'];
  let next = 1;
  const tools = {
    kanban_create_board: ({ name }) => {
      const there = boards.find(b => b.toLowerCase() === name.toLowerCase());
      if (!there) boards.push(name);
      return { slug: (there ?? name).toLowerCase().replace('ä', 'ae'), name: there ?? name, created: !there };
    },
    kanban_search: ({ query }) => ({ hits: cards.filter(c => `${c.title}\n${c.description}`.toLowerCase().includes(query)).map(c => ({ id: c.archived ? null : c.id, title: c.title, column: c.column, archived: c.archived })) }),
    kanban_create_card: a => {
      const c = { id: next++, title: a.title, description: a.description, due: a.due ?? null, column: a.column ?? columns[0], archived: false };
      cards.push(c);
      return c;
    },
    kanban_read_board: () => ({ columns: columns.map((name, i) => ({ id: 10 + i, name, cards: cards.filter(c => c.column === name && !c.archived).map(c => ({ id: c.id })) })) }),
    kanban_move_card: ({ card_id: id, column }) => { const name = columns[Number(column) - 10]; cards.find(c => c.id === id).column = name; return { id, column: name }; },
  };
  const client = { json: async (name, args) => { calls.push([name, args]); return structuredClone(tools[name](args)); } };
  return { client, calls, cards, boards };
}

test('a reference is lower case, without spaces, and in brackets', () => {
  assert.equal(mark(' ePost 4711 '), '[ämtli:epost-4711]');
});

test('a card is made once, however often the job runs, and the board with it', async () => {
  const k = fakeKanban();
  const lines = [];
  const cards = jobCards(k.client, { log: l => lines.push(l) });
  const first = await cards.ensure('epost-A1', { title: 'Rechnung Swisscom', description: 'Zahlbar bis 31.10.\n', due: '2026-10-31' });
  const again = await cards.ensure('epost-A1', { title: 'Rechnung Swisscom' });
  assert.deepEqual(first, { id: 1, created: true, archived: false, url: null });
  assert.deepEqual(again, { id: 1, created: false, archived: false, url: null }, 'no address without KANBAN_PUBLIC_URL');
  assert.equal(k.cards.length, 1);
  assert.equal(k.cards[0].description, 'Zahlbar bis 31.10.\n\n[ämtli:epost-a1]');
  assert.equal(k.cards[0].due, '2026-10-31');
  assert.deepEqual(k.boards, ['Ämtli']);
  assert.equal(k.calls.filter(([n]) => n === 'kanban_create_board').length, 1, 'asked for once per run');
  assert.match(lines.join('\n'), /made the board Ämtli/);
  assert.match(lines.join('\n'), /card 1 for epost-A1/);
});

test('a reference never finds a longer one', async () => {
  const k = fakeKanban({ boards: ['Ämtli'] });
  const cards = jobCards(k.client);
  await cards.ensure('epost-12', { title: 'zwölf' });
  assert.equal((await cards.ensure('epost-1', { title: 'eins' })).created, true);
  assert.equal(k.cards.length, 2);
});

test('an archived card counts as dealt with and is not made again', async () => {
  const k = fakeKanban({ boards: ['Ämtli'] });
  const cards = jobCards(k.client);
  await cards.ensure('frist-x', { title: 'Frist' });
  k.cards[0].archived = true;
  assert.deepEqual(await cards.ensure('frist-x', { title: 'Frist' }), { id: null, created: false, archived: true, url: null });
  assert.equal(k.cards.length, 1);
  assert.equal(await cards.done('frist-x'), false, 'nothing to move in the archive');
});

test('done moves the card to the last column, once', async () => {
  const k = fakeKanban({ boards: ['Ämtli'] });
  const cards = jobCards(k.client, { board: 'ämtli' });
  await cards.ensure('epost-B2', { title: 'Rechnung', column: 'In Progress' });
  assert.equal(k.cards[0].column, 'In Progress');
  assert.equal(await cards.done('epost-B2'), true);
  assert.equal(k.cards[0].column, 'Done');
  assert.deepEqual(k.calls.find(([n]) => n === 'kanban_move_card')[1], { card_id: 1, column: '12' }, 'by column id');
  // Already in the last column, which the board says, whatever the search
  // page made of the column's name.
  await cards.ensure('epost-C3', { title: 'Schon erledigt', column: 'Done' });
  assert.equal(await cards.done('epost-C3'), false);
  assert.equal(await cards.done('epost-none'), false);
  assert.equal(k.calls.find(([n]) => n === 'kanban_create_board')[1].name, 'ämtli');
});

test('fields not given are not sent', async () => {
  const k = fakeKanban({ boards: ['Ämtli'] });
  await jobCards(k.client).ensure('x', { title: 'Nur Titel' });
  assert.deepEqual(k.calls.find(([n]) => n === 'kanban_create_card')[1], { board: 'aemtli', title: 'Nur Titel', description: '[ämtli:x]' });
});

test('a board that did not answer is asked again by the next call', async () => {
  const k = fakeKanban({ boards: ['Ämtli'] });
  let down = true;
  const client = { json: async (name, args) => { if (name === 'kanban_create_board' && down) throw new Error('kanban_create_board: fetch failed'); return k.client.json(name, args); } };
  const cards = jobCards(client);
  await assert.rejects(cards.ensure('a', { title: 'A' }), /fetch failed/);
  down = false;
  assert.equal((await cards.ensure('a', { title: 'A' })).created, true);
});

test('with a public address a card carries the link to look it up', async () => {
  const k = fakeKanban();
  const cards = jobCards(k.client, { board: 'Ämtli', baseUrl: 'https://kanban.example/' });
  const made = await cards.ensure('epost-A1', { title: 'Rechnung' });
  assert.deepEqual(made, { id: 1, created: true, archived: false, url: 'https://kanban.example/b/aemtli#card-1' });
  assert.equal((await cards.ensure('epost-A1', { title: 'Rechnung' })).url, 'https://kanban.example/b/aemtli#card-1', 'the card that was there already too');
  assert.equal(await cards.url(7), 'https://kanban.example/b/aemtli#card-7');
  // An archived card has no anchor on the board, and no card id either.
  k.cards[0].archived = true;
  assert.equal((await cards.ensure('epost-A1', { title: 'Rechnung' })).url, null);
  assert.equal(await cards.url(null), null);
});
