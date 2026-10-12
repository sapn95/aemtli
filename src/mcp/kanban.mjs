// The kanban board (upstream golang-kanban v2), for goose and the jobs.
//
// v2 has no API. What a person does on the board is a form post, and what
// they see is a page rendered from fixed templates; this client posts the
// same forms and reads the same pages. It is written against the commit the
// cluster runs, and a test reads pages that commit rendered, so a template
// change upstream shows up as a failing test before it reaches the board.
//
// Upstream refuses a cross-site browser post (Sec-Fetch-Site, Origin). A
// request from a server carries neither header and is let through; the
// NetworkPolicy in front of the board is what keeps everything else out.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML text or an attribute value, as html/template escaped it, back to text. */
export function decode(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

/** The text of a piece of HTML: tags out, entities decoded. */
const textOf = html => decode(String(html ?? '').replace(/<[^>]*>/g, '')).trim();

const first = (re, s) => re.exec(s)?.[1];

/** The front page: every board with its slug and how many cards it holds. */
export function parseBoards(html) {
  return [...html.matchAll(/<a class="board-link" href="\/b\/([^"]+)">([^<]*)<\/a>\s*<span class="board-meta">(\d+) card/g)]
    .map(([, slug, name, cards]) => ({ slug: decode(slug), name: decode(name), cards: Number(cards) }));
}

/** One card as the board shows it. `chunk` starts right after `id="card-`. */
function parseCardFace(chunk) {
  const subtasks = [];
  const list = first(/<ul class="subtasks">([\s\S]*?)<\/ul>/, chunk) ?? '';
  // Each line is a form asking for the opposite of its state: done=0 on a
  // line that is done.
  for (const [, text, done] of list.matchAll(/name="text" value="([^"]*)">\s*<input type="hidden" name="done" value="([01])">/g)) {
    subtasks.push({ done: done === '0', text: decode(text) });
  }
  return {
    id: Number(first(/^(\d+)/, chunk)),
    title: textOf(first(/<h5 class="card-title">([\s\S]*?)<\/h5>/, chunk)),
    description: textOf(first(/<p class="card-desc">([\s\S]*?)<\/p>/, chunk)),
    due: first(/title="Due (\d{4}-\d{2}-\d{2})"/, chunk) ?? null,
    assignee: decode(first(/title="Assigned to ([^"]*)"/, chunk) ?? '') || null,
    subtasks,
  };
}

/** A board page: its name and its columns, left to right, with their cards. */
export function parseBoard(html) {
  const main = html.slice(html.indexOf('<main class="board"'), html.indexOf('</main>'));
  const columns = main.split('<section class="lane').slice(1).map(section => ({
    id: Number(first(/data-tab="(\d+)"/, section)),
    name: textOf(first(/<h3 class="lane-title">([\s\S]*?)<span/, section)),
    cards: section.split('<div class="card" id="card-').slice(1).map(parseCardFace),
  }));
  return { name: textOf(first(/<h1 class="board-title">([\s\S]*?)<\/h1>/, html)), columns };
}

/** The edit form of a card: every field as stored, and the columns it can go to. */
export function parseCardForm(html) {
  const subtasks = [];
  for (const [, row] of html.matchAll(/<div class="subtask-row">([\s\S]*?)<\/div>/g)) {
    subtasks.push({ done: /class="subtask-complete"[^>]*\schecked/.test(row), text: decode(first(/class="subtask-text" value="([^"]*)"/, row) ?? '') });
  }
  const select = name => first(new RegExp(`<select name="${name}">([\\s\\S]*?)</select>`), html);
  const options = s => [...(s ?? '').matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map(([, value, selected, label]) => ({ value: decode(value), selected: Boolean(selected), label: decode(label) }));
  const lanes = options(select('lane'));
  const assignee = select('assignee');
  const current = lanes.find(o => o.selected);
  return {
    id: Number(first(/hx-post="\/card\/(\d+)\/update"/, html)),
    title: decode(first(/name="title" value="([^"]*)"/, html) ?? ''),
    description: decode(first(/<textarea name="description"[^>]*>([\s\S]*?)<\/textarea>/, html) ?? ''),
    due: first(/name="due" value="([^"]*)"/, html) || null,
    subtasks,
    // A board with a single column has no column field in the form.
    column: current?.label ?? null,
    columnId: current ? Number(current.value) : null,
    columns: lanes.map(o => ({ id: Number(o.value), name: o.label })),
    // Present only when the board knows who is signed in; null otherwise.
    assignee: assignee === undefined ? undefined : options(assignee).find(o => o.selected)?.value ?? '',
  };
}

/** Search results: title, where the card is, and its id while it is on a board. */
export function parseSearch(html) {
  return [...html.matchAll(/<a class="board-link" href="\/b\/([^"#/]+)(?:#card-(\d+)|\/archive)">([^<]*)<\/a>\s*<span class="board-meta">([\s\S]*?)<\/span>\s*<\/div>/g)]
    .map(([, slug, id, title, meta]) => {
      const where = textOf(meta);
      const [board, rest = ''] = where.split(' › ');
      const [column] = rest.split(' · ');
      return { id: id ? Number(id) : null, title: decode(title), board: slug, boardName: board, column, archived: !id };
    });
}

/** Subtasks in the one-line-each form the board stores: "1|done", "0|open". */
export const formatSubtasks = list => (list ?? [])
  .map(s => (typeof s === 'string' ? { done: false, text: s } : s))
  .map(s => ({ done: Boolean(s.done), text: String(s.text ?? '').split(/\s+/).filter(Boolean).join(' ') }))
  .filter(s => s.text)
  .map(s => `${s.done ? 1 : 0}|${s.text}`)
  .join('\n');

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `baseUrl` is the board's address inside the cluster. `as` and
 * `userHeader` are for a board that reads who is signed in from a header
 * (upstream's AUTH_HEADER): the address the cards are written as, and the
 * header's name.
 */
export function createKanban({ baseUrl, fetchImpl = fetch, as, userHeader, timeoutMs = 15_000 }) {
  if (Boolean(as) !== Boolean(userHeader)) throw new Error('KANBAN_AS and KANBAN_USER_HEADER go together: set both or neither');
  const base = String(baseUrl).replace(/\/+$/, '');
  const identity = as ? { [userHeader]: as } : {};
  // Calls that read a card and post it back run one after the other per
  // card, so two changes at once cannot undo each other.
  const locks = new Map();
  function oneAtATime(card, fn) {
    let id;
    try {
      id = cardPath(card);
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

  async function send(path, { method = 'GET', form, htmx = false } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...identity,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(htmx ? { 'hx-request': 'true' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    if (res.status >= 400) {
      const err = new Error(`the board answered ${res.status}: ${body.trim().slice(0, 200) || res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return { status: res.status, body, location: res.headers.get('location') };
  }

  const boards = async () => parseBoards((await send('/')).body);

  /** A board by slug or by name, or an error that lists the boards there are. */
  async function board(which) {
    const all = await boards();
    const want = String(which ?? '').trim().toLowerCase();
    const hit = all.find(b => b.slug === which) ?? all.find(b => b.name.toLowerCase() === want || b.slug.toLowerCase() === want);
    if (!hit) throw Object.assign(new Error(`no board "${which}"; there are: ${all.map(b => b.name).join(', ') || 'none'}`), { status: 404 });
    return hit;
  }

  async function readBoard(which) {
    const b = await board(which);
    return { slug: b.slug, ...parseBoard((await send(`/b/${encodeURIComponent(b.slug)}`)).body) };
  }

  /** A column by id or by name; the first one when none is named (undefined or null). */
  function column(columns, which) {
    if (!columns.length) throw new Error('the board has no columns');
    if (which === undefined || which === null) return columns[0];
    const want = String(which).trim().toLowerCase();
    const hit = columns.find(c => String(c.id) === want) ?? columns.find(c => c.name.toLowerCase() === want);
    if (!hit) throw Object.assign(new Error(`no column "${which}"; there are: ${columns.map(c => c.name).join(', ')}`), { status: 404 });
    return hit;
  }

  const cardPath = id => {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error(`"${id}" is not a card id`), { status: 400 });
    return `/card/${n}`;
  };

  async function getCard(id) {
    return parseCardForm((await send(`${cardPath(id)}/edit`)).body);
  }

  /** The columns a card can go to; a board with one column has no choice to offer. */
  const onlyOne = card => {
    if (!card.columns.length) throw Object.assign(new Error('the board has only one column'), { status: 400 });
    return card.columns;
  };

  const checkDue = due => {
    if (due && !DATE.test(due)) throw Object.assign(new Error(`"${due}" is not a date (YYYY-MM-DD)`), { status: 400 });
    return due ?? '';
  };

  return {
    boards,
    readBoard,
    getCard,

    /** The hits, and whether the board stopped at its 100. */
    async search(query, which) {
      const params = new URLSearchParams({ q: query });
      if (which) params.set('board', (await board(which)).slug);
      const { body } = await send(`/search?${params}`);
      return { hits: parseSearch(body), truncated: /Showing the first \d+/.test(body) };
    },

    /**
     * Adds a board, or hands back the one of that name. The board itself
     * would make a second one with the same name, which a job that runs
     * every day must not do.
     */
    async createBoard(name) {
      const there = (await boards()).find(b => b.name.toLowerCase() === String(name).trim().toLowerCase());
      if (there) return { slug: there.slug, name: there.name, created: false };
      const { location } = await send('/boards', { method: 'POST', form: { name } });
      const slug = decodeURIComponent(first(/^\/b\/([^/?#]+)/, location ?? '') ?? '');
      return { slug, name: String(name).trim(), created: true };
    },

    async createCard(which, { title, description = '', due, subtasks, column: lane } = {}) {
      const b = await readBoard(which);
      const target = column(b.columns, lane);
      const { body } = await send(`/b/${encodeURIComponent(b.slug)}/card`, {
        method: 'POST',
        htmx: true,
        form: { title: title ?? '', description, subtasks: formatSubtasks(subtasks), due: checkDue(due), lane: String(target.id) },
      });
      const card = parseCardFace(body.slice(body.indexOf('id="card-') + 'id="card-'.length));
      return { ...card, board: b.slug, column: target.name };
    },

    /**
     * Changes the fields given and keeps every other one as it is; a field
     * that is undefined or null is not given.
     */
    updateCard(id, change = {}) {
      return oneAtATime(id, async () => {
        const now = await getCard(id);
        const form = {
          title: change.title ?? now.title,
          description: change.description ?? now.description,
          subtasks: formatSubtasks(change.subtasks ?? now.subtasks),
          due: change.due === undefined || change.due === null ? now.due ?? '' : checkDue(change.due),
        };
        if (change.column !== undefined && change.column !== null) form.lane = String(column(onlyOne(now), change.column).id);
        // A board that knows who is signed in clears the assignee of a post
        // without one, so the one there is sent back.
        if (now.assignee !== undefined) form.assignee = now.assignee;
        const { body } = await send(`${cardPath(id)}/update`, { method: 'POST', htmx: true, form });
        return parseCardFace(body.slice(body.indexOf('id="card-') + 'id="card-'.length));
      });
    },

    /** Puts a card at the end of another column of its board. */
    moveCard(id, lane) {
      return oneAtATime(id, async () => {
        const target = column(onlyOne(await getCard(id)), lane ?? '');
        await send(`${cardPath(id)}/move`, { method: 'POST', form: { lane: String(target.id) } });
        return { id: Number(id), column: target.name };
      });
    },

    /** Ticks or unticks one subtask, counted from 0. */
    setSubtask(id, index, done) {
      return oneAtATime(id, async () => {
        const now = await getCard(id);
        const s = now.subtasks[index];
        if (!s) throw Object.assign(new Error(`card ${id} has ${now.subtasks.length} subtasks; there is no number ${index}`), { status: 400 });
        const { body } = await send(`${cardPath(id)}/subtask`, { method: 'POST', htmx: true, form: { index: String(index), text: s.text, done: done ? '1' : '0' } });
        return parseCardFace(body.slice(body.indexOf('id="card-') + 'id="card-'.length));
      });
    },

    archiveCard(id) {
      return oneAtATime(id, async () => {
        await send(`${cardPath(id)}/archive`, { method: 'POST', form: {} });
        return { id: Number(id), archived: true };
      });
    },

    restoreCard(id) {
      return oneAtATime(id, async () => {
        await send(`${cardPath(id)}/restore`, { method: 'POST', htmx: true, form: {} });
        return { id: Number(id), archived: false };
      });
    },
  };
}

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const BOARD = { type: 'string', description: 'The board, by name or by the slug in its address.' };
const CARD = { type: 'integer', description: 'The card id, as kanban_read_board or kanban_search give it.' };
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
    { name: 'kanban_list_boards', description: 'Lists the boards with how many cards each holds.', inputSchema: obj({}), annotations: read, run: async () => ({ boards: await kanban.boards() }) },
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
