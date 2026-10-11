// Where runs are kept: one directory per run under the shared data volume.
//
//   <data>/runs/<recipe>/<run id>/run.json   status, times, tokens, error
//                                 result.md  the last answer of the model
//                                 run.log    goose's stderr
//
// Run ids sort by time, so "newest first" is a reverse name sort and needs
// no index. Everything that turns a name from a URL into a path goes through
// the two patterns below first.
import { mkdirSync, readdirSync, writeFileSync, renameSync, rmSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const RECIPE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;

/** A new, sortable run id for the moment `date`: 20261011T081300Z-1a2b. */
export function newRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

/** The directory of one run; throws on a name or id that could leave the tree. */
export function runDir(dataDir, recipe, id) {
  if (!RECIPE_NAME.test(recipe)) throw new Error(`not a recipe name: ${recipe}`);
  if (!RUN_ID.test(id)) throw new Error(`not a run id: ${id}`);
  return join(dataDir, 'runs', recipe, id);
}

/** Writes a JSON file in one step, so a reader never sees half of it. */
export function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Creates the directory for a new run and returns its path. */
export function createRunDir(dataDir, recipe, id) {
  const dir = runDir(dataDir, recipe, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The web UI reads what runs wrote, and a run is an agent that may have been
// talked into planting something: a symlink to the UI's own token, a FIFO
// that blocks a synchronous read forever, a log of a few gigabytes. So run
// files are read through this, never with a plain readFileSync.
const LIMITS = { 'run.json': 64 * 1024, 'result.md': 1024 * 1024, 'run.log': 256 * 1024 };

/** Whether `path` is a real directory, not a symlink to one. */
function realDir(path) {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Reads at most `max` bytes of a regular file without following a symlink or
 * blocking on a FIFO; with `tail`, the last `max` bytes. Null if it is not a
 * regular file or cannot be read.
 */
function readCapped(path, max, tail = false) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const length = Math.min(st.size, max);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, tail ? st.size - length : 0);
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The run's directory if both it and its recipe directory are real directories. */
function checkedRunDir(dataDir, recipe, id) {
  const dir = runDir(dataDir, recipe, id);
  return realDir(join(dataDir, 'runs', recipe)) && realDir(dir) ? dir : null;
}

/** Reads run.json of one run, or null when it does not exist or is unreadable. */
export function readRun(dataDir, recipe, id) {
  try {
    const dir = checkedRunDir(dataDir, recipe, id);
    const text = dir && readCapped(join(dir, 'run.json'), LIMITS['run.json']);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Reads one file of a run ('result.md', or the tail of 'run.log'); empty
 * string if it is missing or not a regular file.
 */
export function readRunFile(dataDir, recipe, id, file) {
  if (!['result.md', 'run.log'].includes(file)) throw new Error(`not a run file: ${file}`);
  const dir = checkedRunDir(dataDir, recipe, id);
  return (dir && readCapped(join(dir, file), LIMITS[file], file === 'run.log')) ?? '';
}

/** Run ids of a recipe, newest first. */
function runIds(dataDir, recipe) {
  if (!RECIPE_NAME.test(recipe)) return [];
  try {
    return readdirSync(join(dataDir, 'runs', recipe)).filter(id => RUN_ID.test(id)).sort().reverse();
  } catch {
    return [];
  }
}

/** The newest `limit` runs of a recipe, each as its run.json. */
export function listRuns(dataDir, recipe, limit = 20) {
  return runIds(dataDir, recipe)
    .slice(0, limit)
    .map(id => readRun(dataDir, recipe, id))
    .filter(Boolean);
}

/** Deletes all but the newest `keep` runs of a recipe; returns how many went. */
export function pruneRuns(dataDir, recipe, keep) {
  // slice(NaN) is everything: a bad count must never delete every run.
  if (!Number.isInteger(keep) || keep < 1) return 0;
  const old = runIds(dataDir, recipe).slice(keep);
  for (const id of old) rmSync(runDir(dataDir, recipe, id), { recursive: true, force: true });
  return old.length;
}
