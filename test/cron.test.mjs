import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextRun } from '../src/web/cron.mjs';

const at = iso => new Date(iso);

test('parses lists, ranges, steps and the shorthands', () => {
  const c = parseCron('0,30 8-10 */10 1-12/6 1-5');
  assert.deepEqual([...c.minute], [0, 30]);
  assert.deepEqual([...c.hour], [8, 9, 10]);
  assert.deepEqual([...c.dom], [1, 11, 21, 31]);
  assert.deepEqual([...c.month], [1, 7]);
  assert.deepEqual([...c.dow], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron('5/20 * * * *').minute], [5, 25, 45]);
  assert.ok(parseCron('* * * * 7').dow.has(0), 'Sunday as 7');
  assert.deepEqual([...parseCron('@daily').hour], [0]);
});

test('rejects what cron would reject', () => {
  for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '*/0 * * * *', '5-1 * * * *', 'a * * * *']) {
    assert.throws(() => parseCron(bad), bad);
  }
});

test('next run in UTC', () => {
  assert.equal(nextRun('13 8 * * 1', at('2026-10-11T12:00:00Z')).toISOString(), '2026-10-12T08:13:00.000Z');
  assert.equal(nextRun('*/15 * * * *', at('2026-10-11T12:07:30Z')).toISOString(), '2026-10-11T12:15:00.000Z');
  // Strictly after `from`, never the same minute.
  assert.equal(nextRun('0 12 * * *', at('2026-10-11T12:00:00Z')).toISOString(), '2026-10-12T12:00:00.000Z');
});

test('next run in a time zone, across the switch to winter time', () => {
  // 08:13 in Zurich is 06:13 UTC in summer and 07:13 UTC in winter.
  assert.equal(nextRun('13 8 * * *', at('2026-10-11T12:00:00Z'), 'Europe/Zurich').toISOString(), '2026-10-12T06:13:00.000Z');
  assert.equal(nextRun('13 8 * * *', at('2026-10-25T12:00:00Z'), 'Europe/Zurich').toISOString(), '2026-10-26T07:13:00.000Z');
});

test('day of month and day of week combine with OR, as in cron', () => {
  // The 13th, or any Friday: Friday 16 October comes before 13 November.
  assert.equal(nextRun('0 9 13 * 5', at('2026-10-14T00:00:00Z')).toISOString(), '2026-10-16T09:00:00.000Z');
});

test('a yearly schedule is found, an impossible one is null', () => {
  assert.equal(nextRun('@yearly', at('2026-10-11T00:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(nextRun('0 0 30 2 *', at('2026-10-11T00:00:00Z')), null);
});

test('a day skip over the spring-forward night does not miss 00:30 the day after', () => {
  // Sunday 29 March 2026 has 23 hours in Zurich. A Monday 00:30 schedule,
  // looked up from that Sunday, is Monday 30 March 00:30 CEST (22:30 UTC).
  assert.equal(nextRun('30 0 * * 1', at('2026-03-28T23:00:00Z'), 'Europe/Zurich').toISOString(), '2026-03-29T22:30:00.000Z');
});

test('a day field starting with * counts as unrestricted, like Vixie cron', () => {
  // */1 for day of month: only the weekday restricts, so the next Friday.
  assert.equal(nextRun('0 9 */1 * 5', at('2026-10-11T00:00:00Z')).toISOString(), '2026-10-16T09:00:00.000Z');
});
