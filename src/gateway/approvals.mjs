// Calls held for the owner's decision, one JSON file each in the gateway's
// state directory, so a restart loses nothing. A request goes from pending
// to running and then done or failed when approved, or to rejected, or to
// expired when nobody decided within the time to live.
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeJsonAtomic } from '../store/runs.mjs';

/** A request id: when it was held, and 64 random bits so ids never collide. */
export const APPROVAL_ID = /^\d{8}T\d{6}Z-[0-9a-f]{16}$/;
const newId = date => `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomBytes(8).toString('hex')}`;

const MAX_ARGUMENTS = 64 * 1024;
const MAX_RESULT = 32 * 1024;
const MAX_PENDING = 200;

/** The same JSON for the same value, whatever order its keys came in. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Cuts text to `max` characters, saying so. */
function cap(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n[cut after ${max} characters]` : s;
}

export function createApprovals({ dir, ttlMs = 7 * 24 * 3600_000, keep = 500, now = () => new Date() }) {
  mkdirSync(dir, { recursive: true });
  const path = id => join(dir, `${id}.json`);
  // The files are the record; this map is what is in them, so a busy
  // gateway does not read five hundred files for every held call.
  const cache = new Map();
  for (const file of readdirSync(dir)) {
    const id = file.slice(0, -5);
    if (!file.endsWith('.json') || !APPROVAL_ID.test(id)) continue;
    try {
      cache.set(id, JSON.parse(readFileSync(path(id), 'utf8')));
    } catch {
      // A half-written file from a crash: not a request.
    }
  }
  const save = record => {
    writeJsonAtomic(path(record.id), record);
    cache.set(record.id, record);
    return record;
  };
  const read = id => (APPROVAL_ID.test(String(id)) && cache.has(id) ? structuredClone(cache.get(id)) : null);

  /** Every request, newest first; pending ones past their time expire here. */
  function list() {
    const cutoff = now().getTime() - ttlMs;
    for (const r of cache.values()) {
      if (r.status === 'pending' && Date.parse(r.requestedAt) < cutoff) save({ ...r, status: 'expired', decidedAt: now().toISOString() });
    }
    return [...cache.keys()].sort().reverse().map(read);
  }

  /** Drops the oldest decided requests beyond `keep`. Pending and running ones stay. */
  function prune() {
    if (cache.size <= keep) return;
    const open = r => r.status === 'pending' || r.status === 'running';
    const decided = [...cache.keys()].sort().reverse().filter(id => !open(cache.get(id)));
    const room = keep - (cache.size - decided.length);
    for (const id of decided.slice(Math.max(0, room))) {
      try { unlinkSync(path(id)); } catch { /* already gone */ }
      cache.delete(id);
    }
  }

  // A call that was running when the gateway stopped may or may not have
  // happened. Say so instead of leaving it "running" for ever.
  for (const r of cache.values()) {
    if (r.status === 'running') {
      save({ ...r, status: 'failed', finishedAt: now().toISOString(), result: 'The gateway restarted while this call ran. Check whether it happened before asking again.' });
    }
  }

  return {
    list,
    get: read,

    /**
     * Holds a call. An identical call that is already pending is not held
     * twice: the agent gets the same request back.
     */
    hold(tool, args = {}) {
      const key = stable({ tool, args });
      if (key.length > MAX_ARGUMENTS) throw new Error(`the arguments are over ${MAX_ARGUMENTS / 1024} KB`);
      const cutoff = now().getTime() - ttlMs;
      const same = [...cache.values()].find(r => r.status === 'pending' && Date.parse(r.requestedAt) >= cutoff
        && stable({ tool: r.tool, args: r.arguments }) === key);
      if (same) return structuredClone(same);
      // A flood of calls must not fill the volume or the owner's phone.
      const pending = [...cache.values()].filter(r => r.status === 'pending' && Date.parse(r.requestedAt) >= cutoff).length;
      if (pending >= MAX_PENDING) throw new Error(`${MAX_PENDING} calls are waiting for the owner already; try again after they decided`);
      let id = newId(now());
      while (cache.has(id)) id = newId(now());
      const record = save({ id, tool, arguments: args, status: 'pending', requestedAt: now().toISOString() });
      prune();
      return structuredClone(record);
    },

    /**
     * Moves a pending request to `status` ("running" or "rejected"), or
     * returns null if it is not pending any more. The gateway is one process
     * and this runs without awaiting, so two decisions cannot both win.
     */
    claim(id, status) {
      const record = read(id);
      if (!record || record.status !== 'pending') return null;
      if (Date.parse(record.requestedAt) < now().getTime() - ttlMs) return null;
      return structuredClone(save({ ...record, status, decidedAt: now().toISOString() }));
    },

    /** Records how an approved call ended. */
    finish(id, { ok, text }) {
      const record = read(id);
      if (!record) return null;
      return structuredClone(save({ ...record, status: ok ? 'done' : 'failed', finishedAt: now().toISOString(), result: cap(text, MAX_RESULT) }));
    },
  };
}
