// Cards a job keeps on the kanban board: one for each thing that waits for
// the owner, such as a bill in the ePost inbox or a deadline. Each card
// carries a reference at the end of its description, "[ämtli:<ref>]", and
// the job finds it again by that, so a job that runs every day adds a card
// once. A card the owner archived counts as dealt with and is not made
// again; one the job sees resolved goes to the board's last column.
//
// Everything goes through the kanban gateway, as goose's own calls do.

/** The reference as it is written into a card: lower case, no spaces. */
export const mark = ref => `[ämtli:${String(ref).trim().toLowerCase().replace(/\s+/g, '-')}]`;

/** `client` is ctx.mcp('kanban'). `board` is created when it is not there yet. */
export function jobCards(client, { board = 'Ämtli', log = () => {} } = {}) {
  let ready = null;

  /** The board, made on first use; its slug from then on. */
  const slug = () => (ready ??= client.json('kanban_create_board', { name: board }).then(b => {
    if (b.created) log(`kanban: made the board ${b.name}`);
    return b.slug;
  }));

  /**
   * The cards with this reference, on the board and in its archive. The
   * search matches any part of the text; the brackets make the reference
   * match only itself, so "[ämtli:epost-1]" never finds "[ämtli:epost-12]".
   */
  const find = async ref => (await client.json('kanban_search', { query: mark(ref), board: await slug() })).hits;

  return {
    mark,

    /**
     * Adds a card unless one with this reference is on the board or in its
     * archive. Resolves with { id, created, archived }.
     */
    async ensure(ref, { title, description = '', due, subtasks, column }) {
      const [there] = await find(ref);
      if (there) return { id: there.id, created: false, archived: there.archived };
      const card = await client.json('kanban_create_card', {
        board: await slug(),
        title,
        description: [description.trim(), mark(ref)].filter(Boolean).join('\n\n'),
        ...(due ? { due } : {}),
        ...(subtasks ? { subtasks } : {}),
        ...(column ? { column } : {}),
      });
      log(`kanban: card ${card.id} for ${ref}`);
      return { id: card.id, created: true, archived: false };
    },

    /**
     * Moves the card with this reference to the board's last column, when it
     * is on the board and not there already. Resolves with true when it moved.
     */
    async done(ref) {
      const live = (await find(ref)).filter(h => !h.archived);
      if (!live.length) return false;
      // Where a card is comes from the board itself, by card id, read now:
      // a column name in the search page's text could be read wrong.
      const { columns } = await client.json('kanban_read_board', { board: await slug() });
      const last = columns.at(-1);
      let moved = false;
      for (const h of live) {
        if (!last || last.cards?.some(c => c.id === h.id)) continue;
        await client.json('kanban_move_card', { card_id: h.id, column: String(last.id ?? last.name) });
        log(`kanban: card ${h.id} for ${ref} to ${last.name}`);
        moved = true;
      }
      return moved;
    },
  };
}
