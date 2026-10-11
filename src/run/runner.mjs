// Runs one recipe with goose and records the outcome where the web UI looks.
//
// This is what a CronJob's container executes. It never decides anything
// about the recipe itself; goose does the work, this only starts it, waits,
// and writes down what happened in a shape the dashboard can read.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGooseResult } from './result.mjs';
import { RECIPE_NAME, newRunId, createRunDir, writeJsonAtomic, pruneRuns } from '../store/runs.mjs';

// goose's JSON on stdout is buffered to parse it at the end; a run that
// prints more than this is not a run anybody wants a result page for. stderr
// goes to run.log, which the UI only ever shows the tail of, so past its cap
// the rest is dropped rather than filling the volume.
const MAX_STDOUT = 32 * 1024 * 1024;
const MAX_LOG = 8 * 1024 * 1024;

/**
 * Starts goose for `recipe` and resolves with `{ code, stdout }` once it
 * exits. stderr streams into `logPath` as it comes. `signal` aborts the run
 * (the CronJob's pod is being stopped).
 */
function runGoose({ goose, args, env, logPath, signal }) {
  return new Promise(resolve => {
    const log = createWriteStream(logPath);
    const child = spawn(goose, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let truncated = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      // Once a chunk is dropped, nothing after it is kept either: half a
      // JSON document with a gap in the middle would parse as something else.
      if (truncated || stdout.length + chunk.length > MAX_STDOUT) truncated = true;
      else stdout += chunk;
    });
    let logged = 0;
    child.stderr.on('data', chunk => {
      if (logged >= MAX_LOG) return;
      logged += chunk.length;
      log.write(logged > MAX_LOG ? chunk.subarray(0, chunk.length - (logged - MAX_LOG)) : chunk);
      if (logged >= MAX_LOG) log.write('\n[log cut at 8 MB]\n');
    });
    // A full disk must not take the runner down before it records the run.
    log.on('error', () => {});
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    let done = false;
    /** Settles once: the log is flushed to disk before anyone reads it. */
    const finish = (code, note) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', stop);
      log.on('finish', () => resolve({ code, stdout, truncated }));
      log.end(note);
    };
    // A binary that cannot start emits 'error' (and on some versions 'close'
    // as well); the first one wins.
    child.on('error', err => finish(127, `could not start goose: ${err.message}\n`));
    child.on('close', code => finish(code ?? 1));
  });
}

/**
 * Runs `recipe` from `recipesDir`, writing run.json, result.md and run.log
 * under `dataDir`. Resolves with the run record; `record.status` is
 * "succeeded" or "failed" (or "cancelled" when `signal` fired).
 */
export async function runRecipe({
  recipe,
  recipesDir,
  dataDir,
  goose = 'goose',
  params = [],
  maxTurns,
  keep = 50,
  trigger = 'manual',
  env = process.env,
  signal,
  now = () => new Date(),
}) {
  if (!RECIPE_NAME.test(recipe)) throw new Error(`not a recipe name: ${recipe}`);
  const recipePath = join(recipesDir, `${recipe}.yaml`);
  if (!existsSync(recipePath)) throw new Error(`no recipe file ${recipePath}`);

  const started = now();
  const id = newRunId(started);
  const dir = createRunDir(dataDir, recipe, id);
  const record = {
    recipe,
    id,
    trigger,
    status: 'running',
    startedAt: started.toISOString(),
    provider: env.GOOSE_PROVIDER ?? null,
    model: env.GOOSE_MODEL ?? null,
  };
  writeJsonAtomic(join(dir, 'run.json'), record);

  const args = ['run', '--recipe', recipePath, '--no-session', '--quiet', '--output-format', 'json'];
  if (maxTurns) args.push('--max-turns', String(maxTurns));
  // --name=value, so a value starting with a dash is not read as a flag.
  for (const p of params) args.push(`--params=${p}`);

  const { code, stdout, truncated } = await runGoose({ goose, args, env, logPath: join(dir, 'run.log'), signal });
  const result = readGooseResult(stdout);
  const finished = now();

  let status = result.ok && code === 0 ? 'succeeded' : 'failed';
  if (signal?.aborted) status = 'cancelled';
  let error = result.error;
  if (code !== 0) error = `goose exited with ${code}${error ? `: ${error}` : ''}`;
  if (truncated) error = `${error ?? ''} (output over ${MAX_STDOUT} bytes was cut)`.trim();
  if (signal?.aborted) error = 'stopped before it finished';

  writeFileSync(join(dir, 'result.md'), result.text ? `${result.text}\n` : '');
  Object.assign(record, {
    status,
    exitCode: code,
    finishedAt: finished.toISOString(),
    durationMs: finished - started,
    tokens: result.tokens,
    error: status === 'succeeded' ? null : error,
  });
  writeJsonAtomic(join(dir, 'run.json'), record);
  pruneRuns(dataDir, recipe, keep);
  return record;
}
