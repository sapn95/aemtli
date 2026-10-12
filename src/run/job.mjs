// A job: a chore done by code, with the model asked only where judgement is
// needed. `aemtli job <name>` imports `<name>.mjs` from the recipes
// directory and calls its default export with a context:
//
//   ctx.mcp('epost')         an MCP client for a gateway (approvals still apply)
//   ctx.cards()              cards on the kanban board for what waits for the
//                            owner, through the kanban gateway (see cards.mjs)
//   ctx.ask({ prompt, ... }) one message to the model through the model proxy;
//                            a small model by default, tokens counted
//   ctx.notify({...})        one push through ntfy, when the run is worth a
//                            look on a phone
//   ctx.pdfText(bytes)       a PDF's text, laid out as on the page
//   ctx.state                JSON kept between runs of this job (save with
//                            ctx.saveState()), e.g. what was already reported
//   ctx.fetch, ctx.log, ctx.now, ctx.params
//
// It returns the result as Markdown. A job that throws has failed, with the
// error as its reason. The run is recorded like a goose run, so the dashboard
// shows both alike.
//
// The model gets text and returns text: no tools, so whatever a letter or a
// web page says cannot make it do anything.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createRunDir, newRunId, pruneRuns, writeJsonAtomic, RECIPE_NAME } from '../store/runs.mjs';
import { createMcpClient } from './mcp-client.mjs';
import { jobCards } from './cards.mjs';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
const THINKING_ROOM = 2048;

/** The model client, through the model proxy that holds the real key. */
function anthropicFrom(env) {
  // Two minutes a call: a run has half an hour in all, and a hung call must
  // not take it, or the run is killed before it can record why.
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? 'placeholder', baseURL: env.ANTHROPIC_HOST, maxRetries: 2, timeout: 120_000 });
}

/**
 * Runs job `name`, writing run.json, result.md and run.log under `dataDir`.
 * Resolves with the run record.
 */
export async function runJob({
  name,
  recipesDir,
  dataDir,
  trigger = 'manual',
  params = {},
  keep = 50,
  env = process.env,
  gateways = {},
  anthropic = anthropicFrom(env),
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  if (!RECIPE_NAME.test(name)) throw new Error(`not a job name: ${name}`);
  const file = join(recipesDir, `${name}.mjs`);
  if (!existsSync(file)) throw new Error(`no job file ${file}`);

  const started = now();
  const id = newRunId(started);
  const dir = createRunDir(dataDir, name, id);
  const record = { recipe: name, id, trigger, kind: 'job', status: 'running', startedAt: started.toISOString(), model: null };
  writeJsonAtomic(join(dir, 'run.json'), record);
  const logPath = join(dir, 'run.log');
  const log = line => appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);

  // Next to the job's runs, on the one volume a run may write.
  const statePath = join(dataDir, 'runs', name, 'state.json');
  let state = {};
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (err) {
      // Started empty, which may repeat what was reported before: say so.
      log(`the state could not be read and starts empty: ${err.message}`);
    }
  }

  // Where a job may push, if the pod was given the settings for it.
  const ntfy = env.NTFY_URL && env.NTFY_TOPIC && env.NTFY_TOKEN_FILE
    ? { url: new URL(env.NTFY_URL).origin + new URL(env.NTFY_URL).pathname.replace(/\/$/, ''), topic: env.NTFY_TOPIC, tokenFile: env.NTFY_TOKEN_FILE }
    : null;

  const tokens = { input: 0, output: 0, total: 0 };
  const models = new Set();
  const clients = [];
  const ctx = {
    params,
    state,
    log,
    fetch: fetchImpl,
    now,
    saveState() {
      writeJsonAtomic(statePath, ctx.state);
    },
    /**
     * Sends one push. `title` and `message` are the whole of it: a phone
     * shows little, and what a job read may be nobody else's business.
     * Resolves to true when it went out, false when the pod has no ntfy
     * settings or ntfy refused, which never fails the run.
     */
    async notify({ title, message, click = env.PUBLIC_ORIGIN, tags = 'bell' }) {
      if (!ntfy) {
        log('nothing to notify with: NTFY_URL, NTFY_TOPIC and NTFY_TOKEN_FILE are not all set');
        return false;
      }
      try {
        // Published as JSON, which carries UTF-8 in the title too; a header
        // could only carry latin-1, and "Frist: Prämie" would lose its ä.
        const res = await fetchImpl(ntfy.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${readFileSync(ntfy.tokenFile, 'utf8').trim()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            topic: ntfy.topic,
            title: String(title).replace(/\s+/g, ' ').slice(0, 120),
            message: String(message).slice(0, 2000),
            tags: String(tags).split(',').map(t => t.trim()).filter(Boolean),
            ...(click ? { click } : {}),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
        log('notified');
        return true;
      } catch (err) {
        log(`could not notify: ${err.message}`);
        return false;
      }
    },
    /** A PDF's text as pdftotext -layout sees it: columns stay columns. */
    pdfText(bytes) {
      return new Promise((resolve, reject) => {
        const child = execFile('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
          (err, stdout) => (err ? reject(new Error(`pdftotext: ${err.message.split('\n')[0]}`)) : resolve(stdout)));
        child.stdin.on('error', () => {});
        child.stdin.end(Buffer.from(bytes));
      });
    },
    mcp(gateway) {
      const url = gateways[gateway];
      if (!url) throw new Error(`no gateway "${gateway}" in MCP_GATEWAYS`);
      const client = createMcpClient(url, { fetchImpl });
      clients.push(client);
      return client;
    },
    /** Cards on the board `board` (Ämtli unless named), one per reference. */
    cards({ board } = {}) {
      return jobCards(ctx.mcp('kanban'), { board, log });
    },
    /**
     * Asks the model once and resolves with its text. `maxTokens` is the room
     * for the answer; current models think first by default and that counts
     * too, so the request gets THINKING_ROOM on top, and `effort` (low by
     * default) keeps the thinking short.
     */
    async ask({ prompt, system, model = DEFAULT_MODEL, maxTokens = 1024, effort = 'low' }) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens + THINKING_ROOM,
        output_config: { effort },
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
      });
      models.add(model);
      tokens.input += response.usage?.input_tokens ?? 0;
      tokens.output += response.usage?.output_tokens ?? 0;
      tokens.total = tokens.input + tokens.output;
      log(`asked ${model}: ${response.usage?.input_tokens ?? 0} in, ${response.usage?.output_tokens ?? 0} out`);
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (response.stop_reason !== 'max_tokens') return text;
      // Thinking took it all: there is no answer to keep. Failing leaves the
      // job's state as it was, so the next run asks again.
      if (!text.trim()) throw new Error(`the model used its ${maxTokens + THINKING_ROOM} tokens before it answered`);
      log(`the answer was cut at ${maxTokens + THINKING_ROOM} tokens`);
      return `${text}\n\n*The answer was cut at its length limit.*`;
    },
  };

  let status = 'succeeded';
  let error = null;
  let markdown = '';
  try {
    const job = await import(pathToFileURL(file).href);
    if (typeof job.default !== 'function') throw new Error(`${name}.mjs has no default export to run`);
    const out = await job.default(ctx);
    markdown = typeof out === 'string' ? out : String(out?.markdown ?? '');
  } catch (err) {
    status = 'failed';
    error = err.message;
    log(`failed: ${err.stack ?? err.message}`);
  } finally {
    await Promise.allSettled(clients.map(c => c.close()));
  }

  const finished = now();
  writeFileSync(join(dir, 'result.md'), markdown ? `${markdown.trimEnd()}\n` : '');
  Object.assign(record, {
    status,
    finishedAt: finished.toISOString(),
    durationMs: finished - started,
    tokens,
    model: models.size ? [...models].join(', ') : null,
    error,
  });
  writeJsonAtomic(join(dir, 'run.json'), record);
  pruneRuns(dataDir, name, keep);
  return record;
}
