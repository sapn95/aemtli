// A job: a chore done by code, with the model asked only where judgement is
// needed. `aemtli job <name>` imports `<name>.mjs` from the recipes
// directory and calls its default export with a context:
//
//   ctx.mcp('epost')         an MCP client for a gateway (approvals still apply)
//   ctx.ask({ prompt, ... }) one message to the model through the model proxy;
//                            a small model by default, tokens counted
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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createRunDir, newRunId, pruneRuns, writeJsonAtomic, RECIPE_NAME } from '../store/runs.mjs';
import { createMcpClient } from './mcp-client.mjs';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

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
    mcp(gateway) {
      const url = gateways[gateway];
      if (!url) throw new Error(`no gateway "${gateway}" in MCP_GATEWAYS`);
      const client = createMcpClient(url, { fetchImpl });
      clients.push(client);
      return client;
    },
    /** Asks the model once and resolves with its text. */
    async ask({ prompt, system, model = DEFAULT_MODEL, maxTokens = 1024 }) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
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
      log(`the answer was cut at ${maxTokens} tokens`);
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
