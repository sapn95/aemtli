// A goose serve in the test process, for the chat broker's tests.

/** The first bytes of a PNG, which is all the checks look at. */
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64');
/** The same for a JPEG. */
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49]).toString('base64');

/**
 * A goose serve in the test process, speaking ACP over a WebSocket-like
 * object: sessions it keeps across connections, replay on session/load, a
 * question before a tool when the prompt says TOOL (two side by side for
 * TWICE), a turn that waits when the prompt says SLOW, and a session/load
 * that never answers for a session called "hang". A prompt keeps all its
 * blocks, images too, and is replayed block by block; one that says PICTURE
 * is answered with an image as well.
 */
export function fakeGoose({ loadDelayMs = 0 } = {}) {
  const sessions = new Map();
  let n = 0;
  const sockets = [];
  const prompts = [];
  const connect = () => {
    const ws = { closed: false };
    sockets.push(ws);
    let turn = null;
    const deliver = message => queueMicrotask(() => { if (!ws.closed) ws.onmessage?.({ data: JSON.stringify(message) }); });
    const update = (sessionId, u) => deliver({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
    const finish = stopReason => {
      if (!turn) return;
      const t = turn;
      turn = null;
      if (stopReason === 'end_turn' && t.picture) {
        const image = { type: 'image', mimeType: 'image/png', data: PNG };
        sessions.get(t.sid).push({ role: 'agent', text: '', blocks: [image] });
        update(t.sid, { sessionUpdate: 'agent_message_chunk', content: image });
      } else if (stopReason === 'end_turn') {
        sessions.get(t.sid).push({ role: 'agent', text: 'Hallo zäme' });
        update(t.sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hallo ' } });
        update(t.sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'zäme' } });
      }
      deliver({ jsonrpc: '2.0', id: t.id, result: { stopReason } });
    };
    ws.send = raw => {
      const m = JSON.parse(raw);
      const reply = result => deliver({ jsonrpc: '2.0', id: m.id, result });
      if (typeof m.id === 'string' && m.id.startsWith('q') && turn) {
        // The answer to a question: allowed runs the tool, anything else not.
        // The turn ends once every question it asked is answered.
        const allowed = m.result?.outcome?.optionId === 'allow';
        update(turn.sid, { sessionUpdate: 'tool_call_update', toolCallId: `t${m.id.slice(1)}`, status: allowed ? 'completed' : 'failed' });
        turn.answers = [...(turn.answers ?? []), m.id];
        return turn.answers.length === turn.asked ? finish('end_turn') : undefined;
      }
      switch (m.method) {
        case 'initialize': return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
        case 'session/new': {
          const sessionId = `s${++n}`;
          sessions.set(sessionId, []);
          return reply({ sessionId, modes: { currentModeId: 'smart_approve' } });
        }
        case 'session/set_mode': return reply({});
        case 'session/list': return reply({ sessions: [...sessions.keys()].map((id, i) => ({ sessionId: id, title: `Chat ${id}`, updatedAt: `2026-10-12T0${i}:00:00Z`, _meta: { messageCount: sessions.get(id).length } })) });
        case 'session/load': {
          if (m.params.sessionId === 'hang') return undefined;
          if (!sessions.has(m.params.sessionId)) return deliver({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'Session not found' } });
          const replay = () => {
            for (const msg of sessions.get(m.params.sessionId) ?? []) {
              for (const content of msg.blocks ?? [{ type: 'text', text: msg.text }]) {
                update(m.params.sessionId, { sessionUpdate: msg.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content });
              }
            }
            reply({ modes: { currentModeId: 'auto' } });
          };
          return loadDelayMs ? void setTimeout(replay, loadDelayMs) : replay();
        }
        case 'session/delete': sessions.delete(m.params.sessionId); return reply({});
        case 'session/cancel': return finish('cancelled');
        case 'session/prompt': {
          const blocks = m.params.prompt;
          prompts.push(blocks);
          const text = blocks.find(b => b.type === 'text')?.text ?? '';
          sessions.get(m.params.sessionId).push({ role: 'user', text, blocks });
          turn = { id: m.id, sid: m.params.sessionId, picture: text.includes('PICTURE') };
          const ask = (k, title) => {
            update(turn.sid, { sessionUpdate: 'tool_call', toolCallId: `t${k}`, title, status: 'pending' });
            deliver({ jsonrpc: '2.0', id: `q${k}`, method: 'session/request_permission', params: { sessionId: turn.sid, toolCall: { title }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }] } });
          };
          if (text.includes('TWICE')) {
            turn.asked = 2;
            ask(1, 'shell: ls');
            return ask(2, 'shell: pwd');
          }
          if (text.includes('TOOL')) {
            turn.asked = 1;
            return ask(1, 'shell: ls');
          }
          if (text.includes('SLOW')) return undefined;
          return queueMicrotask(() => finish('end_turn'));
        }
        default: return deliver({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
      }
    };
    ws.close = () => { ws.closed = true; queueMicrotask(() => ws.onclose?.()); };
    queueMicrotask(() => ws.onopen?.());
    return ws;
  };
  return { connect, sessions, sockets, prompts };
}

