// When does a CronJob run next? Kubernetes keeps the last schedule time in
// the CronJob's status but not the next one, so the dashboard works it out.
//
// Standard five fields (minute hour day-of-month month day-of-week) with
// lists, ranges and steps, plus the @hourly/@daily/@weekly/@monthly/@yearly
// shorthands, evaluated in the CronJob's timeZone like the controller does.

const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
];

/** Expands one field (a list "0,30", a range "1-5", a step over a range) into a Set of numbers. */
function expand(text, { min, max }) {
  const values = new Set();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    let lo = min;
    let hi = max;
    if (range !== '*') {
      [lo, hi] = range.split('-').map(Number);
      if (hi === undefined) hi = stepText === undefined ? lo : max;
    }
    if (![lo, hi, step].every(Number.isInteger) || step < 1 || lo < min || hi > max || lo > hi) {
      throw new Error(`bad cron field "${text}"`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** Parses a cron expression into sets; throws on anything malformed. */
export function parseCron(expression) {
  const fields = (MACROS[expression.trim()] ?? expression).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron needs five fields: "${expression}"`);
  const [minute, hour, dom, month, dow] = fields.map((f, i) => expand(f, FIELDS[i]));
  if (dow.has(7)) dow.add(0);
  return {
    minute, hour, dom, month, dow,
    // Classic cron: when both day fields are restricted, either may match.
    // A field that starts with "*" ("*", "*/2") counts as unrestricted, as
    // in Vixie cron, which Kubernetes follows.
    domAny: fields[2].startsWith('*'),
    dowAny: fields[4].startsWith('*'),
  };
}

/** The wall-clock parts of `date` in `timeZone`. */
function partsIn(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, weekday };
}

/** Whether the day of `p` matches the day-of-month and day-of-week fields. */
function dayMatches(cron, p) {
  const byDom = cron.dom.has(p.day);
  const byDow = cron.dow.has(p.weekday);
  if (cron.domAny && cron.dowAny) return true;
  if (cron.domAny) return byDow;
  if (cron.dowAny) return byDom;
  return byDom || byDow;
}

/**
 * The first time after `from` that `expression` fires in `timeZone`, or null
 * if there is none within a year and a day. Steps a minute at a time but
 * skips whole hours and days that cannot match, which keeps it to a few
 * thousand iterations even for a yearly schedule.
 */
export function nextRun(expression, from = new Date(), timeZone = 'UTC') {
  const cron = parseCron(expression);
  let t = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const end = t + 366 * 24 * 3_600_000;
  while (t < end) {
    const p = partsIn(new Date(t), timeZone);
    if (!cron.month.has(p.month) || !dayMatches(cron, p)) {
      // To 23:00 of the same day, not to midnight: on the day a clock goes
      // forward the day has 23 hours, and "the rest of the day" measured in
      // real minutes would overshoot past 00:xx of the next one. The hour
      // branch takes the last step.
      t += Math.max((23 - p.hour) * 60 - p.minute, 60 - p.minute) * 60_000;
    } else if (!cron.hour.has(p.hour)) {
      t += (60 - p.minute) * 60_000;
    } else if (!cron.minute.has(p.minute)) {
      t += 60_000;
    } else {
      return new Date(t);
    }
  }
  return null;
}
