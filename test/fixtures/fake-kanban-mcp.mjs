// A kanban MCP server over stdio, with the board in memory: enough for a job
// that keeps cards. Started by the gateway in the job's tests.
import { serveStdio } from '../../src/mcp/stdio.mjs';
import { kanbanTools } from '../../src/mcp/kanban.mjs';

const cards = [];
let next = 1;
const slug = name => String(name).toLowerCase().replace('ä', 'ae');

const board = {
  async boards() { return [{ slug: 'aemtli', name: 'Ämtli', cards: cards.length }]; },
  async createBoard(name) { return { slug: slug(name), name, created: false }; },
  async search(query) {
    return { hits: cards.filter(c => c.description.includes(query)).map(c => ({ id: c.id, title: c.title, board: 'aemtli', column: c.column, archived: false })), truncated: false };
  },
  async createCard(which, { title, description = '' }) {
    const card = { id: next++, title, description, column: 'To Do' };
    cards.push(card);
    return { ...card, board: slug(which) };
  },
};

await serveStdio({ name: 'fake-kanban', version: '1', tools: kanbanTools(board), log: () => {} });
