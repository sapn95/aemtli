import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunId, runDir, createRunDir, writeJsonAtomic, readRun, readRunFile, listRuns, pruneRuns, RUN_ID } from '../src/store/runs.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'aemtli-runs-'));

test('run ids sort by time and match their own pattern', () => {
  const a = newRunId(new Date('2026-10-11T08:13:00.123Z'));
  const b = newRunId(new Date('2026-10-11T09:00:00Z'));
  assert.match(a, /^20261011T081300Z-[0-9a-f]{4}$/);
  assert.ok(RUN_ID.test(b));
  assert.ok(a < b);
});

test('names and ids that could leave the tree are refused', () => {
  const data = tmp();
  for (const bad of ['../x', 'A', '', 'a/b', '-a']) assert.throws(() => runDir(data, bad, newRunId()));
  assert.throws(() => runDir(data, 'ok', '../../etc'));
  assert.throws(() => readRunFile(data, 'ok', newRunId(), '../run.json'));
  assert.equal(readRun(data, '../x', newRunId()), null);
  assert.deepEqual(listRuns(data, '../x'), []);
});

test('runs list newest first, and pruning keeps the newest', () => {
  const data = tmp();
  const ids = ['20261001T000000Z-0001', '20261002T000000Z-0002', '20261003T000000Z-0003'];
  for (const id of ids) writeJsonAtomic(join(createRunDir(data, 'hello', id), 'run.json'), { id });
  writeFileSync(join(runDir(data, 'hello', ids[2]), 'result.md'), 'hi');
  assert.deepEqual(listRuns(data, 'hello').map(r => r.id), [...ids].reverse());
  assert.deepEqual(listRuns(data, 'hello', 1).map(r => r.id), [ids[2]]);
  assert.equal(readRunFile(data, 'hello', ids[2], 'result.md'), 'hi');
  assert.equal(readRunFile(data, 'hello', ids[1], 'result.md'), '');
  assert.equal(pruneRuns(data, 'hello', 2), 1);
  assert.equal(existsSync(runDir(data, 'hello', ids[0])), false);
  assert.deepEqual(listRuns(data, 'nothing'), []);
});

test('an unreadable run.json reads as no run', () => {
  const data = tmp();
  const id = newRunId();
  writeFileSync(join(createRunDir(data, 'hello', id), 'run.json'), '{half');
  assert.equal(readRun(data, 'hello', id), null);
  assert.deepEqual(listRuns(data, 'hello'), []);
});

test('what a run planted cannot make the UI follow a link, block or read gigabytes', async () => {
  const { symlinkSync, mkdirSync: mk } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const data = tmp();
  const outside = join(data, 'secret.txt');
  writeFileSync(outside, 'token-from-the-ui-pod');
  // run.json as a symlink to something only the UI can read
  const a = '20261001T000000Z-000a';
  symlinkSync(outside, join(createRunDir(data, 'hello', a), 'run.json'));
  symlinkSync(outside, join(runDir(data, 'hello', a), 'result.md'));
  assert.equal(readRun(data, 'hello', a), null);
  assert.equal(readRunFile(data, 'hello', a, 'result.md'), '');
  // a FIFO where the log should be
  const b = '20261002T000000Z-000b';
  writeJsonAtomic(join(createRunDir(data, 'hello', b), 'run.json'), { id: b });
  execFileSync('mkfifo', [join(runDir(data, 'hello', b), 'run.log')]);
  assert.equal(readRunFile(data, 'hello', b, 'run.log'), '');
  // a huge log: only the tail comes back
  const c = '20261003T000000Z-000c';
  writeJsonAtomic(join(createRunDir(data, 'hello', c), 'run.json'), { id: c });
  writeFileSync(join(runDir(data, 'hello', c), 'run.log'), `${'x'.repeat(1024 * 1024)}THE END`);
  const log = readRunFile(data, 'hello', c, 'run.log');
  assert.equal(log.length, 256 * 1024);
  assert.ok(log.endsWith('THE END'));
  // a run directory that is itself a symlink
  const d = '20261004T000000Z-000d';
  mk(join(data, 'elsewhere'));
  writeJsonAtomic(join(data, 'elsewhere', 'run.json'), { id: d });
  symlinkSync(join(data, 'elsewhere'), runDir(data, 'hello', d));
  assert.equal(readRun(data, 'hello', d), null);
});
