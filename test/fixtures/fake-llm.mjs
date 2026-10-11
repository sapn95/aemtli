#!/usr/bin/env node
// A fake OpenAI-compatible model server for tests. It answers every chat
// completion with a fixed text (or the text in FAKE_LLM_REPLY), streamed or
// not, and logs each request body to FAKE_LLM_LOG when that is set.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const REPLY = process.env.FAKE_LLM_REPLY ?? 'Hallo vom Fake-Modell.';
const port = Number(process.env.FAKE_LLM_PORT ?? 0);

/** Collects a request body. */
function body(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => resolve(data));
  });
}

/**
 * The Anthropic Messages API, enough of it for goose's anthropic provider:
 * a text answer, streamed as server-sent events or as one JSON body. With
 * FAKE_LLM_REQUIRE_KEY set, any other x-api-key is a 401, which is how the
 * tests prove the key came from the proxy and not from goose.
 */
function anthropic(req, res, text) {
  const required = process.env.FAKE_LLM_REQUIRE_KEY;
  if (required && req.headers['x-api-key'] !== required) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  }
  const request = text ? JSON.parse(text) : {};
  const usage = { input_tokens: 10, output_tokens: 5 };
  if (!request.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: request.model, content: [{ type: 'text', text: REPLY }], stop_reason: 'end_turn', stop_sequence: null, usage }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (const word of REPLY.split(/(?<= )/)) event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: word } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  event('message_stop', {});
  return res.end();
}

const server = createServer(async (req, res) => {
  const text = await body(req);
  if (process.env.FAKE_LLM_LOG) appendFileSync(process.env.FAKE_LLM_LOG, `${req.method} ${req.url} ${text.slice(0, 4000)}\n`);
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
  }
  if (req.url.split('?')[0].endsWith('/v1/messages')) return anthropic(req, res, text);
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
  const request = text ? JSON.parse(text) : {};
  const id = 'chatcmpl-fake';
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  // "TOOL" in the last user message makes the model call the first shell-like
  // tool once; after the tool's result comes back, it answers with that result.
  const messages = request.messages ?? [];
  const last = messages.at(-1) ?? {};
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const wantsTool = JSON.stringify(lastUser?.content ?? '').includes('TOOL') && last.role !== 'tool';
  const shell = (request.tools ?? []).find(t => /shell/.test(t.function?.name ?? ''));
  if (wantsTool && shell && request.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: shell.function.name, arguments: '' } }] }));
    res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: 'echo tool-ran-here' }) } }] }));
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: request.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  const reply = last.role === 'tool' ? `Tool said: ${JSON.stringify(last.content).slice(0, 200)}` : REPLY;
  if (request.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = delta => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: request.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
    res.write(chunk({ role: 'assistant', content: '' }));
    for (const word of reply.split(/(?<= )/)) res.write(chunk({ content: word }));
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: request.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id, object: 'chat.completion', created: 0, model: request.model, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake-llm listening on ${server.address().port}`);
});
