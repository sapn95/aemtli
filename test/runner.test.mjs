import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRecipe } from '../src/run/runner.mjs';
import { listRuns, readRunFile } from '../src/store/runs.mjs';

const FAKE = new URL('./fixtures/fake-goose.mjs', import.meta.url).pathname;

/** A data dir, a recipes dir with "hello", and the env for the fake goose. */
function setup(mode) {
  const root = mkdtempSync(join(tmpdir(), 'aemtli-runner-'));
  const recipesDir = join(root, 'recipes');
  mkdirSync(recipesDir);
  writeFileSync(join(recipesDir, 'hello.yaml'), 'title: Hello\nprompt: hi\n');
  const argsFile = join(root, 'args.jsonl');
  const env = { PATH: process.env.PATH, FAKE_GOOSE_MODE: mode, FAKE_GOOSE_ARGS: argsFile, GOOSE_PROVIDER: 'openai', GOOSE_MODEL: 'fake-model' };
  const args = () => readFileSync(argsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { root, recipesDir, dataDir: join(root, 'data'), env, args };
}

test('a successful run records its answer, tokens and model', async () => {
  const s = setup('success');
  const r = await runRecipe({ recipe: 'hello', recipesDir: s.recipesDir, dataDir: s.dataDir, goose: FAKE, env: s.env, trigger: 'schedule', maxTurns: 7, params: ['who=world'] });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.error, null);
  assert.equal(r.trigger, 'schedule');
  assert.equal(r.model, 'fake-model');
  assert.equal(r.tokens.total, 15);
  assert.equal(listRuns(s.dataDir, 'hello')[0].status, 'succeeded');
  assert.match(readRunFile(s.dataDir, 'hello', r.id, 'result.md'), /Fake-Modell/);
  const [args] = s.args();
  assert.deepEqual(args.slice(0, 3), ['run', '--recipe', join(s.recipesDir, 'hello.yaml')]);
  for (const flag of ['--no-session', '--quiet', '--output-format', 'json', '--max-turns', '7', '--params=who=world']) assert.ok(args.includes(flag), flag);
});

test('a provider failure that exits 0 is recorded as failed', async () => {
  const s = setup('network');
  const r = await runRecipe({ recipe: 'hello', recipesDir: s.recipesDir, dataDir: s.dataDir, goose: FAKE, env: s.env });
  assert.equal(r.status, 'failed');
  assert.equal(r.exitCode, 0);
  assert.match(r.error, /Network error/);
});

test('a crash keeps the exit code and the log', async () => {
  const s = setup('crash');
  const r = await runRecipe({ recipe: 'hello', recipesDir: s.recipesDir, dataDir: s.dataDir, goose: FAKE, env: s.env });
  assert.equal(r.status, 'failed');
  assert.equal(r.exitCode, 3);
  assert.match(r.error, /exited with 3/);
  assert.match(readRunFile(s.dataDir, 'hello', r.id, 'run.log'), /panicked/);
});

test('output that is not JSON is a failure', async () => {
  const s = setup('garbage');
  const r = await runRecipe({ recipe: 'hello', recipesDir: s.recipesDir, dataDir: s.dataDir, goose: FAKE, env: s.env });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /no JSON/);
});

test('a missing goose binary is a failure, not a crash', async () => {
  const s = setup('success');
  const r = await runRecipe({ recipe: 'hello', recipesDir: s.recipesDir, dataDir: s.dataDir, goose: '/nonexistent/goose', env: s.env });
  assert.equal(r.status, 'failed');
  assert.equal(r.exitCode, 127);
  assert.match(readRunFile(s.dataDir, 'hello', r.id, 'run.log'), /could not start goose/);
});

test('an abort stops goose and records the run as cancelled', async () => {
  const s = setup('slow');
  const controller = new AbortController();
  const pending = runRecipe({ recipe: 'hello', recipesDir: s.recipesDir, dataDir: s.dataDir, goose: FAKE, env: s.env, signal: controller.signal });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(listRuns(s.dataDir, 'hello')[0].status, 'running');
  controller.abort();
  const r = await pending;
  assert.equal(r.status, 'cancelled');
  assert.equal(r.error, 'stopped before it finished');
});

test('a bad name or a missing recipe file throws before anything runs', async () => {
  const s = setup('success');
  await assert.rejects(runRecipe({ recipe: '../etc', recipesDir: s.recipesDir, dataDir: s.dataDir, goose: FAKE, env: s.env }), /recipe name/);
  await assert.rejects(runRecipe({ recipe: 'nope', recipesDir: s.recipesDir, dataDir: s.dataDir, goose: FAKE, env: s.env }), /no recipe file/);
});

test('old runs are pruned down to "keep"', async () => {
  const s = setup('success');
  for (let i = 0; i < 3; i++) await runRecipe({ recipe: 'hello', recipesDir: s.recipesDir, dataDir: s.dataDir, goose: FAKE, env: s.env, keep: 2 });
  assert.equal(listRuns(s.dataDir, 'hello', 10).length, 2);
});
