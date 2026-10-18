// The kanban board, for goose and the jobs. It works with byge
// (github.com/sapn95/byge) only, the owner's fork of golang-kanban v2, and
// talks to its JSON API under /api/v1 (byge's internal/api/openapi.json is
// the contract). Earlier versions read the board's pages; byge v2.18 changed
// those, and the API is the part it publishes as stable.
//
// Who is asking: the gateway reaches the board pod to pod, with no Cloudflare
// assertion, and carries byge's service header (AUTH_SERVICE_HEADER) instead.
// From byge v2.17 the board enforces grants, and that header makes the caller
// a member of one group (AUTH_SERVICE_GROUP). The caller sees and changes only
// the boards that grant that group a role, which the owner gives on each
// board's access page. A board without that grant is invisible here, so a
// missing board says how to grant it.
//
// The board refuses a cross-site browser post (Sec-Fetch-Site, Origin). A
// request from a server carries neither header and is let through; the
// NetworkPolicy in front of the board is what keeps everything else out.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// byge's ids are 26 lower-case base32 characters; anything else is refused
// before it goes into a path.
const ID = /^[a-z0-9]{1,64}$/i;
const MAX_HITS = 100;

const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0);

/** The checklist as the tools show it: in order, done or not, and its text. */
const checklist = card => [...(card.subtasks ?? [])].sort(byPosition).map(s => ({ done: Boolean(s.done), text: s.title }));

/** A card as the tools show it, from byge's card. */
function face(card) {
  return {
    id: card.id,
    title: card.title ?? '',
    description: card.description ?? '',
    due: card.due_date || null,
    assignee: card.assignee || null,
    subtasks: checklist(card),
  };
}

/**
 * A checklist given to a tool, as byge takes it: a string is an open item,
 * whitespace is folded, empty lines go. An item with the text of one already
 * on the card keeps that one's id, so the board keeps it as the same line.
 */
export function toSubtasks(list, existing = []) {
  const unused = [...existing];
  return (list ?? [])
    .map(s => (typeof s === 'string' ? { done: false, text: s } : s))
    .map(s => ({ done: Boolean(s.done), title: String(s.text ?? '').split(/\s+/).filter(Boolean).join(' ') }))
    .filter(s => s.title)
    .map(s => {
      const at = unused.findIndex(e => e.title === s.title);
      const [same] = at >= 0 ? unused.splice(at, 1) : [];
      return { ...(same ? { id: same.id } : {}), title: s.title, done: s.done };
    });
}

/**
 * `baseUrl` is the board's address inside the cluster. `as` and
 * `userHeader` are byge's service identity: the header's value and its
 * name. byge reads only that the header is there; `as` names the group it
 * stands for, which is what the owner grants.
 */
export function createKanban({ baseUrl, fetchImpl = fetch, as, userHeader, timeoutMs = 15_000 }) {
  if (Boolean(as) !== Boolean(userHeader)) throw new Error('KANBAN_AS and KANBAN_USER_HEADER go together: set both or neither');
  const base = `${String(baseUrl).replace(/\/+$/, '')}/api/v1`;
  const identity = as ? { [userHeader]: as } : {};
  const grantHint = `grant the group ${as ? `"${as}"` : 'of this service'} write on the board's access page (Settings, Access, as an idp group)`;
  // Calls that read a card and write it back run one after the other per
  // card, so two changes at once cannot undo each other.
  const locks = new Map();
  function oneAtATime(card, fn) {
    let id;
    try {
      id = cardId(card);
    } catch (err) {
      return Promise.reject(err);
    }
    const before = locks.get(id) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const settled = run.catch(() => {});
    locks.set(id, settled);
    settled.then(() => { if (locks.get(id) === settled) locks.delete(id); });
    return run;
  }

  /** One API call; the answer's JSON, or an error with byge's own reason. */
  async function send(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: { ...identity, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.status >= 300) {
      const reason = data?.error ? `${data.error}${data.field ? ` (${data.field})` : ''}` : text.trim().slice(0, 200) || res.statusText;
      const err = new Error(`the board answered ${res.status}: ${reason}${res.status === 403 ? `; ${grantHint}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const listBoards = async () => (await send('/boards')) ?? [];
  const cardsOf = slug => send(`/boards/${encodeURIComponent(slug)}/cards`);
  const archiveOf = slug => send(`/boards/${encodeURIComponent(slug)}/archive`);

  /** Every board this caller may read, with how many cards each holds. */
  async function boards() {
    const all = await listBoards();
    return Promise.all(all.map(async b => ({ slug: b.slug, name: b.name, cards: ((await cardsOf(b.slug)) ?? []).length })));
  }

  /**
   * A board by slug or by name, as byge has it (columns in order), or an
   * error that lists the boards there are and says how to grant one.
   */
  async function board(which) {
    const all = await listBoards();
    const want = String(which ?? '').trim().toLowerCase();
    const hit = all.find(b => b.slug === which) ?? all.find(b => b.name.toLowerCase() === want || b.slug.toLowerCase() === want);
    if (hit) return { ...hit, columns: [...(hit.columns ?? [])].sort(byPosition) };
    // Not among the boards it may read: there may still be one by that slug
    // that grants this caller nothing, and byge says which with 403.
    let hidden = false;
    if (want && /^[a-z0-9-]+$/.test(want)) {
      try {
        await send(`/boards/${encodeURIComponent(want)}`);
      } catch (err) {
        hidden = err.status === 403;
      }
    }
    const there = all.map(b => b.name).join(', ');
    const why = hidden
      ? `the board "${which}" is there, but this service may not read it; ${grantHint}`
      : `no board "${which}" this service may read; there are: ${there || `none. A board shows here once it grants this service: ${grantHint}`}`;
    throw Object.assign(new Error(why), { status: hidden ? 403 : 404 });
  }

  /** The board a card is on, by the card's board id. */
  async function boardOf(card) {
    const b = (await listBoards()).find(x => x.id === card.board_id);
    if (!b) throw Object.assign(new Error(`card ${card.id} is on a board this service may not read; ${grantHint}`), { status: 403 });
    return { ...b, columns: [...(b.columns ?? [])].sort(byPosition) };
  }

  /** A column by id or by name; the first one when none is named (undefined or null). */
  function column(columns, which) {
    if (!columns.length) throw new Error('the board has no columns');
    if (which === undefined || which === null) return columns[0];
    const want = String(which).trim().toLowerCase();
    const hit = columns.find(c => String(c.id).toLowerCase() === want) ?? columns.find(c => c.name.toLowerCase() === want);
    if (!hit) throw Object.assign(new Error(`no column "${which}"; there are: ${columns.map(c => c.name).join(', ')}`), { status: 404 });
    return hit;
  }

  const cardId = id => {
    const s = String(id ?? '').trim();
    if (!ID.test(s)) throw Object.assign(new Error(`"${id}" is not a card id`), { status: 400 });
    return s.toLowerCase();
  };

  async function fetchCard(id) {
    try {
      return await send(`/cards/${cardId(id)}`);
    } catch (err) {
      throw err.status === 404 ? Object.assign(new Error(`no card ${id} on the board`), { status: 404 }) : err;
    }
  }

  const checkDue = due => {
    if (due && !DATE.test(due)) throw Object.assign(new Error(`"${due}" is not a date (YYYY-MM-DD)`), { status: 400 });
    return due ?? '';
  };

  /** A whole card for PUT: byge replaces every field, so the ones kept go along. */
  const whole = (card, change = {}) => ({
    title: change.title ?? card.title ?? '',
    description: change.description ?? card.description ?? '',
    due_date: change.due_date ?? card.due_date ?? '',
    assignee: card.assignee ?? '',
    labels: card.labels ?? [],
    subtasks: change.subtasks ?? (card.subtasks ?? []).slice().sort(byPosition).map(s => ({ id: s.id, title: s.title, done: s.done })),
  });

  /** Puts a card at the end of a column: the column's whole order, the card last. */
  async function toEnd(b, cardIdValue, target) {
    const order = ((await cardsOf(b.slug)) ?? [])
      .filter(c => c.column_id === target.id && c.id !== cardIdValue)
      .sort(byPosition)
      .map(c => c.id);
    await send(`/boards/${encodeURIComponent(b.slug)}/columns/${encodeURIComponent(target.id)}/cards/order`, { method: 'PUT', body: { order: [...order, cardIdValue] } });
  }

  /** The columns a card can go to; a board with one column has no choice to offer. */
  const otherColumns = b => {
    if (b.columns.length < 2) throw Object.assign(new Error('the board has only one column'), { status: 400 });
    return b.columns;
  };

  async function readBoard(which) {
    const b = await board(which);
    const cards = ((await cardsOf(b.slug)) ?? []).slice().sort(byPosition);
    return {
      slug: b.slug,
      name: b.name,
      columns: b.columns.map(c => ({ id: c.id, name: c.name, cards: cards.filter(x => x.column_id === c.id).map(face) })),
    };
  }

  async function getCard(id) {
    const card = await fetchCard(id);
    const b = await boardOf(card);
    const current = b.columns.find(c => c.id === card.column_id);
    return {
      ...face(card),
      column: current?.name ?? null,
      columnId: current?.id ?? null,
      columns: b.columns.map(c => ({ id: c.id, name: c.name })),
      archived: Boolean(card.archived_at),
    };
  }

  return {
    boards,
    readBoard,
    getCard,

    /**
     * Cards that have all of the words in their title, description or
     * checklist, on the board named or on every board this caller may read,
     * archived ones too. At most 100; truncated says there were more.
     */
    async search(query, which) {
      const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) throw Object.assign(new Error('a search needs at least one word'), { status: 400 });
      const where = which ? [await board(which)] : (await listBoards()).map(b => ({ ...b, columns: b.columns ?? [] }));
      const hits = [];
      for (const b of where) {
        const [live, archived] = await Promise.all([cardsOf(b.slug), archiveOf(b.slug)]);
        for (const card of [...(live ?? []).slice().sort(byPosition), ...(archived ?? [])]) {
          const text = [card.title, card.description, ...(card.subtasks ?? []).map(s => s.title)].join('\n').toLowerCase();
          if (!words.every(w => text.includes(w))) continue;
          hits.push({ id: card.id, title: card.title, board: b.slug, boardName: b.name, column: b.columns.find(c => c.id === card.column_id)?.name ?? null, archived: Boolean(card.archived_at) });
        }
      }
      return { hits: hits.slice(0, MAX_HITS), truncated: hits.length > MAX_HITS };
    },

    /**
     * Adds a board, or hands back the one of that name. A job that runs every
     * day must not make a second one; byge refuses a name that is taken, and
     * one taken by a board this caller cannot see says how to grant it.
     */
    async createBoard(name) {
      const want = String(name ?? '').trim();
      const there = (await listBoards()).find(b => b.name.toLowerCase() === want.toLowerCase());
      if (there) return { slug: there.slug, name: there.name, created: false };
      try {
        const made = await send('/boards', { method: 'POST', body: { name: want } });
        return { slug: made.slug, name: made.name, created: true };
      } catch (err) {
        if (err.status === 409) throw Object.assign(new Error(`a board "${want}" is there, but this service may not read it; ${grantHint}`), { status: 409 });
        throw err;
      }
    },

    async createCard(which, { title, description = '', due, subtasks, column: lane } = {}) {
      const b = await board(which);
      const target = column(b.columns, lane);
      const card = await send(`/boards/${encodeURIComponent(b.slug)}/cards`, {
        method: 'POST',
        body: { column_id: target.id, title: title ?? '', description, due_date: checkDue(due), assignee: '', labels: [], subtasks: toSubtasks(subtasks) },
      });
      return { ...face(card), board: b.slug, column: target.name };
    },

    /**
     * Changes the fields given and keeps every other one as it is; a field
     * that is undefined or null is not given. Naming a column moves the card
     * to the end of it.
     */
    updateCard(id, change = {}) {
      return oneAtATime(id, async () => {
        const now = await fetchCard(id);
        const b = change.column === undefined || change.column === null ? null : await boardOf(now);
        const target = b ? column(otherColumns(b), change.column) : null;
        const body = whole(now, {
          title: change.title ?? undefined,
          description: change.description ?? undefined,
          due_date: change.due === undefined || change.due === null ? undefined : checkDue(change.due),
          subtasks: change.subtasks === undefined || change.subtasks === null ? undefined : toSubtasks(change.subtasks, now.subtasks ?? []),
        });
        let card = await send(`/cards/${cardId(id)}`, { method: 'PUT', body });
        if (target && now.column_id !== target.id) {
          await toEnd(b, now.id, target);
          card = await fetchCard(id);
        }
        return face(card);
      });
    },

    /** Puts a card at the end of another column of its board. */
    moveCard(id, lane) {
      return oneAtATime(id, async () => {
        const now = await fetchCard(id);
        const b = await boardOf(now);
        const target = column(otherColumns(b), lane ?? '');
        await toEnd(b, now.id, target);
        return { id: now.id, column: target.name };
      });
    },

    /** Ticks or unticks one subtask, counted from 0. */
    setSubtask(id, index, done) {
      return oneAtATime(id, async () => {
        const now = await fetchCard(id);
        const list = (now.subtasks ?? []).slice().sort(byPosition);
        if (!list[index]) throw Object.assign(new Error(`card ${id} has ${list.length} subtasks; there is no number ${index}`), { status: 400 });
        const subtasks = list.map((s, i) => ({ id: s.id, title: s.title, done: i === index ? Boolean(done) : s.done }));
        return face(await send(`/cards/${cardId(id)}`, { method: 'PUT', body: whole(now, { subtasks }) }));
      });
    },

    archiveCard(id) {
      return oneAtATime(id, async () => {
        await send(`/cards/${cardId(id)}/archive`, { method: 'POST' });
        return { id: cardId(id), archived: true };
      });
    },

    restoreCard(id) {
      return oneAtATime(id, async () => {
        await send(`/cards/${cardId(id)}/restore`, { method: 'POST' });
        return { id: cardId(id), archived: false };
      });
    },
  };
}

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const BOARD = { type: 'string', description: 'The board, by name or by the slug in its address.' };
const CARD = { type: 'string', description: 'The card id, as kanban_read_board or kanban_search give it.' };
const COLUMN = { type: 'string', description: 'A column of the board, by name (for example "To Do") or by id.' };
const DUE = { type: 'string', description: 'Due date, YYYY-MM-DD. An empty string removes it.' };
const SUBTASKS = {
  type: 'array',
  description: 'The whole checklist, in order. A string is an open item.',
  items: { anyOf: [{ type: 'string' }, obj({ text: { type: 'string' }, done: { type: 'boolean' } }, ['text'])] },
};

/** The tools, for an MCP server: name, description, schema, and what each does. */
export function kanbanTools(kanban) {
  const read = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  return [
    { name: 'kanban_list_boards', description: 'Lists the boards this service may read, with how many cards each holds. A board shows only once it grants this service on its access page.', inputSchema: obj({}), annotations: read, run: async () => ({ boards: await kanban.boards() }) },
    { name: 'kanban_read_board', description: 'Reads one board: its columns from left to right, and the cards in each with their description, due date and checklist. Archived cards are not on it.', inputSchema: obj({ board: BOARD }, ['board']), annotations: read, run: a => kanban.readBoard(a.board) },
    { name: 'kanban_get_card', description: 'Reads one card with every field as stored, and the columns it can move to.', inputSchema: obj({ card_id: CARD }, ['card_id']), annotations: read, run: a => kanban.getCard(a.card_id) },
    { name: 'kanban_search', description: 'Finds cards that have all of the words in their title, description or checklist; archived ones too. At most 100; truncated says there were more.', inputSchema: obj({ query: { type: 'string' }, board: BOARD }, ['query']), annotations: read, run: a => kanban.search(a.query, a.board) },
    { name: 'kanban_create_card', description: 'Adds a card at the end of a column, the first one unless a column is named.', inputSchema: obj({ board: BOARD, title: { type: 'string' }, description: { type: 'string' }, due: DUE, subtasks: SUBTASKS, column: COLUMN }, ['board', 'title']), annotations: write, run: a => kanban.createCard(a.board, a) },
    { name: 'kanban_update_card', description: 'Changes the fields given and keeps the others. A checklist given replaces the whole checklist. Naming a column moves the card there.', inputSchema: obj({ card_id: CARD, title: { type: 'string' }, description: { type: 'string' }, due: DUE, subtasks: SUBTASKS, column: COLUMN }, ['card_id']), annotations: write, run: a => kanban.updateCard(a.card_id, a) },
    { name: 'kanban_move_card', description: 'Moves a card to the end of another column of its board.', inputSchema: obj({ card_id: CARD, column: COLUMN }, ['card_id', 'column']), annotations: write, run: a => kanban.moveCard(a.card_id, a.column) },
    { name: 'kanban_set_subtask', description: 'Ticks or unticks one checklist item, counted from 0.', inputSchema: obj({ card_id: CARD, index: { type: 'integer', minimum: 0 }, done: { type: 'boolean' } }, ['card_id', 'index', 'done']), annotations: write, run: a => kanban.setSubtask(a.card_id, a.index, a.done) },
    { name: 'kanban_archive_card', description: 'Takes a card off its board into the archive. kanban_restore_card brings it back.', inputSchema: obj({ card_id: CARD }, ['card_id']), annotations: write, run: a => kanban.archiveCard(a.card_id) },
    { name: 'kanban_restore_card', description: 'Puts an archived card back where it was.', inputSchema: obj({ card_id: CARD }, ['card_id']), annotations: write, run: a => kanban.restoreCard(a.card_id) },
    { name: 'kanban_create_board', description: 'Adds a board, or returns the one that already has this name. A new board starts with the columns To Do, In Progress and Done.', inputSchema: obj({ name: { type: 'string' } }, ['name']), annotations: write, run: a => kanban.createBoard(a.name) },
  ];
}
