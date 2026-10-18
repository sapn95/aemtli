// byge's JSON API in memory, behind a fetch, for the kanban client's tests.
// The shapes are byge v2.18's (internal/api/dto.go): string ids, positions,
// due dates as YYYY-MM-DD, archived_at null on the board. Like byge it refuses
// a body with a field it does not know, so a client that sends one fails here
// before it fails on the Pi. Grants are a list of slugs the service may read
// (and write); a board not on it answers 403, as byge's grant check does.

const CARD_FIELDS = new Set(['column_id', 'title', 'description', 'due_date', 'assignee', 'labels', 'subtasks']);
const SUBTASK_FIELDS = new Set(['id', 'title', 'done']);

let serial = 0;
/** A byge-like id: 26 lower-case characters. */
const newId = prefix => `${prefix}${String((serial += 1)).padStart(25 - prefix.length + 1, '0')}`.slice(0, 26);

export function fakeByge({ header = 'X-Byge-Service', boards = [], grants = null, readOnly = [] } = {}) {
  const seen = [];
  const state = { boards: [], cards: [] };

  function addBoard(name, slug = String(name).toLowerCase().replace(/ä/g, 'ae').replace(/[^a-z0-9]+/g, '-'), columns = ['To Do', 'In Progress', 'Done']) {
    const b = {
      id: newId('b'), slug, name, layout: 'columns', sla: { response_hours: 0, days: [], start: '08:00', end: '17:00', zone: '' },
      // Stored out of order on purpose: the client sorts by position.
      columns: columns.map((n, i) => ({ id: newId('k'), name: n, position: i, wip_limit: 0, stops_clock: false })).reverse(),
      labels: [{ id: newId('l'), name: 'urgent', color: 'red' }],
      created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:00:00Z',
    };
    state.boards.push(b);
    return b;
  }

  function addCard(board, { column = 0, title, description = '', due_date = '', assignee = '', labels = [], subtasks = [], archived = false }) {
    const b = typeof board === 'string' ? state.boards.find(x => x.slug === board) : board;
    const col = [...b.columns].sort((x, y) => x.position - y.position)[column];
    const position = Math.max(-1, ...state.cards.filter(c => c.column_id === col.id && !c.archived_at).map(c => c.position)) + 1;
    const card = {
      id: newId('c'), board_id: b.id, column_id: col.id, title, description, position, due_date, assignee, labels,
      subtasks: subtasks.map((s, i) => ({ id: newId('s'), title: s.title ?? s, done: Boolean(s.done), position: i })).reverse(),
      archived_at: archived ? '2026-10-10T08:00:00Z' : null,
      created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:00:00Z',
    };
    state.cards.push(card);
    return card;
  }

  for (const b of boards) addBoard(b.name, b.slug, b.columns);

  const json = (status, body) => ({ status, statusText: '', text: async () => (body === undefined ? '' : JSON.stringify(body)), headers: new Map() });
  const unknown = (obj, allowed) => Object.keys(obj ?? {}).find(k => !allowed.has(k));

  async function fetchImpl(url, init = {}) {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    seen.push({ method: init.method ?? 'GET', path: pathname, headers: init.headers ?? {}, body });
    const service = Boolean(init.headers?.[header]);
    const may = b => service && (grants === null || grants.includes(b.slug));
    const mayWrite = b => may(b) && !readOnly.includes(b.slug);
    const route = pathname.replace(/^\/api\/v1/, '');
    let m;
    const boardOf = slug => state.boards.find(b => b.slug === slug);
    const guard = (b, write = false) => {
      if (!b) return json(404, { error: 'not found' });
      if (!(write ? mayWrite(b) : may(b))) return json(403, { error: 'forbidden' });
      return null;
    };

    if (route === '/boards' && init.method === 'GET') return json(200, state.boards.filter(may));
    if (route === '/boards' && init.method === 'POST') {
      if (!body?.name) return json(400, { error: 'a board needs a name', field: 'name' });
      if (state.boards.some(b => b.name.toLowerCase() === body.name.toLowerCase())) return json(409, { error: 'already exists' });
      const b = addBoard(body.name);
      if (grants) grants.push(b.slug);
      return json(201, b);
    }
    if ((m = route.match(/^\/boards\/([^/]+)$/)) && init.method === 'GET') {
      const b = boardOf(decodeURIComponent(m[1]));
      return guard(b) ?? json(200, b);
    }
    if ((m = route.match(/^\/boards\/([^/]+)\/(cards|archive)$/)) && init.method === 'GET') {
      const b = boardOf(decodeURIComponent(m[1]));
      return guard(b) ?? json(200, state.cards.filter(c => c.board_id === b.id && Boolean(c.archived_at) === (m[2] === 'archive')));
    }
    if ((m = route.match(/^\/boards\/([^/]+)\/cards$/)) && init.method === 'POST') {
      const b = boardOf(decodeURIComponent(m[1]));
      const no = guard(b, true);
      if (no) return no;
      const bad = unknown(body, CARD_FIELDS) ?? (body.subtasks ?? []).map(s => unknown(s, SUBTASK_FIELDS)).find(Boolean);
      if (bad) return json(400, { error: `json: unknown field "${bad}"` });
      if (!body.title) return json(400, { error: 'a card needs a title', field: 'title' });
      const index = [...b.columns].sort((x, y) => x.position - y.position).findIndex(c => c.id === (body.column_id || b.columns.find(x => x.position === 0).id));
      if (index < 0) return json(404, { error: 'not found' });
      return json(201, addCard(b, { ...body, column: index }));
    }
    if ((m = route.match(/^\/boards\/([^/]+)\/columns\/([^/]+)\/cards\/order$/)) && init.method === 'PUT') {
      const b = boardOf(decodeURIComponent(m[1]));
      const no = guard(b, true);
      if (no) return no;
      const col = b.columns.find(c => c.id === decodeURIComponent(m[2]));
      if (!col) return json(404, { error: 'not found' });
      const named = body.order.map(id => state.cards.find(c => c.id === id));
      const rest = state.cards.filter(c => c.column_id === col.id && !body.order.includes(c.id) && !c.archived_at).sort((x, y) => x.position - y.position);
      [...named, ...rest].forEach((c, i) => { c.column_id = col.id; c.position = i; });
      return json(204);
    }
    if ((m = route.match(/^\/cards\/([^/]+)(\/archive|\/restore)?$/))) {
      const card = state.cards.find(c => c.id === decodeURIComponent(m[1]));
      if (!card) return json(404, { error: 'not found' });
      const b = state.boards.find(x => x.id === card.board_id);
      if (!m[2] && init.method === 'GET') return guard(b) ?? json(200, card);
      const no = guard(b, true);
      if (no) return no;
      if (m[2] === '/archive') { card.archived_at = '2026-10-18T08:00:00Z'; return json(204); }
      if (m[2] === '/restore') { card.archived_at = null; return json(204); }
      if (init.method === 'PUT') {
        const bad = unknown(body, CARD_FIELDS) ?? (body.subtasks ?? []).map(s => unknown(s, SUBTASK_FIELDS)).find(Boolean);
        if (bad) return json(400, { error: `json: unknown field "${bad}"` });
        if (!body.title) return json(400, { error: 'a card needs a title', field: 'title' });
        Object.assign(card, {
          title: body.title, description: body.description ?? '', due_date: body.due_date ?? '', assignee: body.assignee ?? '', labels: body.labels ?? [],
          subtasks: (body.subtasks ?? []).map((s, i) => ({ id: s.id || newId('s'), title: s.title, done: Boolean(s.done), position: i })),
        });
        return json(200, card);
      }
    }
    return json(404, { error: 'not found' });
  }

  return { fetchImpl, seen, state, addBoard, addCard };
}
