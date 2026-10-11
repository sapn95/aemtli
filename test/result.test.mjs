import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readGooseResult } from '../src/run/result.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('a model answer is a success with its text and tokens', () => {
  const r = readGooseResult(fixture('goose-success.json'));
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.match(r.text, /Fake-Modell/);
  assert.deepEqual(r.tokens, { input: 10, output: 5, total: 15 });
});

test('a provider failure that goose calls "completed" is a failure', () => {
  // The real output of goose 1.54 with an unreachable provider: exit 0,
  // status "completed", and the error only in the assistant's text.
  const r = readGooseResult(fixture('goose-network-error.json'));
  assert.equal(r.ok, false);
  assert.match(r.error, /Network error/);
  assert.equal(r.tokens.total, 0);
});

test('a banner before the JSON is skipped', () => {
  assert.equal(readGooseResult(`banner line\n${fixture('goose-success.json')}`).ok, true);
});

test('no JSON at all is a failure with a reason', () => {
  for (const out of ['', 'plain text', '{broken']) {
    const r = readGooseResult(out);
    assert.equal(r.ok, false);
    assert.match(r.error, /no JSON/);
  }
});

test('a status other than completed is a failure even with tokens', () => {
  const doc = JSON.parse(fixture('goose-success.json'));
  doc.metadata.status = 'max_turns_reached';
  const r = readGooseResult(JSON.stringify(doc));
  assert.equal(r.ok, false);
  assert.match(r.error, /Fake-Modell/);
});

test('no assistant message names the status', () => {
  const r = readGooseResult(JSON.stringify({ messages: [{ role: 'user', content: [] }], metadata: { status: 'error' } }));
  assert.equal(r.ok, false);
  assert.match(r.error, /status "error"/);
});
