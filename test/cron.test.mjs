import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextRun, describeCron, runsBetween, weekOf, wallClock } from '../src/web/cron.mjs';

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

test('the day fields combine as in robfig/cron, which the CronJob controller uses', () => {
  const from = at('2026-10-11T12:00:00Z'); // a Sunday
  const next = expression => nextRun(expression, from).toISOString().slice(0, 10);
  // A star ("*", "?", "*/1") on either side: a day must match both.
  assert.equal(next('0 9 */1 * 5'), '2026-10-16', 'Fridays only');
  assert.equal(next('0 9 ? * 5'), '2026-10-16');
  assert.equal(next('0 6 */2 * *'), '2026-10-13', 'odd days only, not every day');
  assert.equal(next('0 6 * * */2'), '2026-10-13', 'Sun, Tue, Thu, Sat');
  // No star: either is enough.
  assert.equal(next('0 6 */2 * 1'), '2026-10-12', 'a Monday, though an even day');
  assert.equal(next('0 6 20 * 1'), '2026-10-12');
});

test('a schedule reads as words, and as itself when there are none for it', () => {
  const cases = {
    '13 8 * * 1': 'Mondays at 08:13',
    '13 8 * * *': 'Every day at 08:13',
    '0 7 * * 1-5': 'Weekdays at 07:00',
    '0 9 * * 6,0': 'Weekends at 09:00',
    '0 7,19 * * 2,4': 'Tuesdays and Thursdays at 07:00 and 19:00',
    '*/15 * * * *': 'Every 15 minutes',
    '5 * * * *': 'Every hour at :05',
    '0 6 1 * *': 'On the 1st of each month at 06:00',
    '30 6 2,23 * *': 'On the 2nd and 23rd of each month at 06:30',
    '@daily': 'Every day at 00:00',
    '0 19,7 * * *': 'Every day at 07:00 and 19:00',
    '0 6 * * */2': 'Sundays, Tuesdays, Thursdays and Saturdays at 06:00',
    '0 6 ? * 1': 'Mondays at 06:00',
    '0 6 1,15 * *': 'On the 1st and 15th of each month at 06:00',
    '0 6 1-31 * 1': 'Every day at 06:00',
    // No good words for these: say what it is rather than something wrong.
    '0 6 1 1 *': 'On the 1st of January at 06:00',
    '0 6 1 1,4,7,10 *': 'On the 1st of January, April, July and October at 06:00',
    '0 8 * 12 *': 'Every day in December at 08:00',
    '10 7,12,17,21 * * *': 'Every day at 07:10, 12:10, 17:10 and 21:10',
    '0 */6 * * *': 'Every day at 00:00, 06:00, 12:00 and 18:00',
    '0 */2 * * *': 'Every 2 hours from 00:00',
    '10 1-23/2 * * *': 'Every 2 hours from 01:10',
    '0 6-13 * * *': 'Every hour from 06:00 to 13:00',
    '0 9-17 * * 1-5': 'Weekdays, every hour from 09:00 to 17:00',
    '*/15 8-17 * * 1-5': 'Weekdays, every 15 minutes from 08:00 to 17:45',
    '0,30 9 * * *': 'Every day at 09:00 and 09:30',
    '0 7,9,10,13,15,16,20 * * *': 'Every day, 7 times between 07:00 and 20:00',
    '5 * * 6 *': 'Every hour at :05 in June',
    '7,8 * * * *': '7,8 * * * *',
    '0 6 1 * 1': '0 6 1 * 1',
    '0 6 */2 * *': '0 6 */2 * *',
    '*/15 * */2 * *': '*/15 * */2 * *',
    '0 6 31 * *': '0 6 31 * *',
    '0 6 28,29 * *': '0 6 28,29 * *',
    'nonsense': 'nonsense',
  };
  for (const [expression, words] of Object.entries(cases)) assert.equal(describeCron(expression), words, expression);
});

test('runs in a window include its start and stop before its end', () => {
  const runs = runsBetween('0 */6 * * *', at('2026-10-11T00:00:00Z'), at('2026-10-12T00:00:00Z'));
  assert.deepEqual(runs.map(r => r.toISOString().slice(11, 16)), ['00:00', '06:00', '12:00', '18:00']);
  assert.equal(runsBetween('* * * * *', at('2026-10-11T00:00:00Z'), at('2026-10-12T00:00:00Z'), 'UTC', 5).length, 5, 'capped');
  assert.deepEqual(runsBetween('0 12 * * *', at('2026-10-11T12:00:30Z'), at('2026-10-12T00:00:00Z')), [], 'a minute already begun is past');
});

test('the week runs Monday to Sunday in the zone, and the autumn Sunday has 25 hours', () => {
  const week = weekOf(at('2026-10-25T10:00:00Z'), 'Europe/Zurich');
  assert.equal(week.length, 7);
  assert.equal(week[0].start.toISOString(), '2026-10-18T22:00:00.000Z', 'Monday 19 Oct, 00:00 summer time');
  assert.equal(week[6].start.toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(week[6].end.toISOString(), '2026-10-25T23:00:00.000Z', 'Monday 26 Oct, 00:00 winter time');
  assert.equal(week[6].end - week[6].start, 25 * 3600_000);
  assert.deepEqual(week.map(d => d.today), [false, false, false, false, false, false, true]);
  for (let i = 1; i < 7; i++) assert.equal(week[i].start.getTime(), week[i - 1].end.getTime());
  // Late Sunday evening UTC is already Monday in Zurich: a new week.
  assert.equal(weekOf(at('2026-10-11T22:30:00Z'), 'Europe/Zurich')[0].today, true);
});

test('a wall-clock time in a zone maps to its instant, also on the switch days', () => {
  assert.equal(wallClock('Europe/Zurich', 2026, 10, 12, 8, 13).toISOString(), '2026-10-12T06:13:00.000Z');
  assert.equal(wallClock('Europe/Zurich', 2026, 12, 1).toISOString(), '2026-11-30T23:00:00.000Z');
  assert.equal(wallClock('Europe/Zurich', 2026, 3, 29, 4).toISOString(), '2026-03-29T02:00:00.000Z', 'after spring forward');
  assert.equal(wallClock('UTC', 2026, 10, 32).toISOString(), '2026-11-01T00:00:00.000Z', 'day 32 rolls over');
});
