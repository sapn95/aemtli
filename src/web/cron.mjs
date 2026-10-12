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
    if (range !== '*' && range !== '?') {
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
    // How the two day fields combine, as robfig/cron v3 (the parser the
    // Kubernetes CronJob controller uses) has it: if either is a "star",
    // a day must match both; otherwise either one is enough. A star is "*"
    // or "?", also with step 1; "*/2" is not one.
    domStar: isStar(fields[2]),
    dowStar: isStar(fields[4]),
  };
}

/** Whether a day field is a star in robfig/cron's sense (see parseCron). */
function isStar(field) {
  return field.split(',').some(part => {
    const [range, step] = part.split('/');
    return (range === '*' || range === '?') && (step === undefined || Number(step) <= 1);
  });
}

// Building a formatter is far dearer than using one, and a week chart asks
// for the parts of a few thousand instants per render.
const formatters = new Map();

/** The wall-clock parts of `date` in `timeZone`. */
function partsIn(date, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', weekday: 'short',
    });
    formatters.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, weekday };
}

/** Whether the day of `p` matches the day-of-month and day-of-week fields. */
function dayMatches(cron, p) {
  const byDom = cron.dom.has(p.day);
  const byDow = cron.dow.has(p.weekday);
  return cron.domStar || cron.dowStar ? byDom && byDow : byDom || byDow;
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

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

/** "08:13" from an hour and a minute. */
function clock(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** "1st", "2nd", "3rd", "4th" … for a day of the month. */
function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th';
  return `${n}${s}`;
}

const capital = text => text[0].toUpperCase() + text.slice(1);

/**
 * When in a day a schedule fires, in words: { at: "07:10, 12:10 and 21:10" }
 * for up to six times, or { other: "every 2 hours from 00:10" } or
 * { other: "every 15 minutes from 08:00 to 17:45" } or, for anything
 * irregular, { other: "8 times between 07:00 and 21:00" }. Never the cron
 * expression itself.
 */
function timesOfDay(hours, minutes) {
  const all = hours.flatMap(h => minutes.map(m => clock(h, m)));
  if (all.length <= 6) return { at: list(all) };
  const evenly = (values, span) => values.length > 1 && span % (values[1] - values[0]) === 0
    && values.every((v, i) => v === values[0] + i * (values[1] - values[0])) && values.length === span / (values[1] - values[0]);
  const contiguous = hours.every((h, i) => h === hours[0] + i);
  if (minutes.length > 1 && minutes[0] === 0 && evenly(minutes, 60) && contiguous) {
    return { other: `every ${minutes[1]} minutes from ${clock(hours[0], 0)} to ${clock(hours.at(-1), minutes.at(-1))}` };
  }
  if (minutes.length === 1 && contiguous) return { other: `every hour from ${all[0]} to ${all.at(-1)}` };
  if (minutes.length === 1 && evenly(hours, 24)) return { other: `every ${hours[1] - hours[0]} hours from ${all[0]}` };
  return { other: `${all.length} times between ${all[0]} and ${all.at(-1)}`, count: true };
}

/** Joins ["a", "b", "c"] as "a, b and c". */
function list(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * The schedule in words: "Mondays at 07:17", "Every day at 08:13",
 * "Weekdays at 07:00", "Every 15 minutes", "On the 1st of each month at
 * 06:00". Falls back to the expression itself for anything it cannot say
 * plainly, so it is never wrong, only sometimes terse.
 */
export function describeCron(expression) {
  let cron;
  try {
    cron = parseCron(expression);
  } catch {
    return expression;
  }
  const minutes = [...cron.minute].sort((a, b) => a - b);
  const hours = [...cron.hour].sort((a, b) => a - b);
  // " in January and July" when not every month.
  const months = cron.month.size === 12 ? '' : ` in ${list([...cron.month].sort((a, b) => a - b).map(m => MONTH_NAMES[m - 1]))}`;
  const allDom = cron.dom.size === 31;
  const allDow = [0, 1, 2, 3, 4, 5, 6].every(d => cron.dow.has(d));
  const both = cron.domStar || cron.dowStar;
  const everyDay = (allDom && allDow) || (!both && (allDom || allDow));

  // Sub-hourly: every N minutes, every hour.
  if (hours.length === 24 && everyDay) {
    if (minutes.length === 1) return `Every hour at :${String(minutes[0]).padStart(2, '0')}${months}`;
    const step = minutes[1] - minutes[0];
    if (minutes[0] === 0 && minutes.every((m, i) => m === i * step) && 60 % step === 0) return `Every ${step} minutes${months}`;
    return expression;
  }
  const times = timesOfDay(hours, minutes);
  const say = days => (times.at ? `${days}${months} at ${times.at}` : `${days}${months}, ${times.other}`);

  if (everyDay) {
    if (times.at || times.count || months) return say('Every day');
    return capital(times.other);
  }
  if (both && allDom) {
    const days = [...cron.dow].filter(d => d < 7).sort((a, b) => a - b);
    if (days.join() === '1,2,3,4,5') return say('Weekdays');
    if (days.join() === '0,6') return say('Weekends');
    return say(list(days.map(d => DAY_NAMES[d])));
  }
  // The 29th to the 31st are skipped in the months without them, which
  // "of each month" would hide.
  if (both && allDow) {
    const days = [...cron.dom].sort((a, b) => a - b);
    if (days.at(-1) <= 28) {
      if (!months) return say(`On the ${list(days.map(ordinal))} of each month`);
      const names = list([...cron.month].sort((a, b) => a - b).map(m => MONTH_NAMES[m - 1]));
      return times.at ? `On the ${list(days.map(ordinal))} of ${names} at ${times.at}` : `On the ${list(days.map(ordinal))} of ${names}, ${times.other}`;
    }
  }
  return expression;
}

/**
 * Every time `expression` fires in [from, to), at most `max` of them.
 * Used to draw the week on the dashboard.
 */
export function runsBetween(expression, from, to, timeZone = 'UTC', max = 50) {
  const runs = [];
  let t = new Date(from.getTime() - 1);
  while (runs.length < max) {
    const next = nextRun(expression, t, timeZone);
    if (!next || next >= to) break;
    runs.push(next);
    t = next;
  }
  return runs;
}

/**
 * The instant at which the wall clock in `timeZone` shows the given date and
 * time. Two passes, because the zone's offset can differ between the guess
 * and the answer on the day a clock changes.
 */
export function wallClock(timeZone, year, month, day, hour = 0, minute = 0) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let t = target;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(new Date(t), timeZone);
    t += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  return new Date(t);
}

/**
 * The seven days of the week that holds `now`, Monday first, in `timeZone`:
 * each with its start, its end, and whether it is today.
 */
export function weekOf(now, timeZone) {
  const today = partsIn(now, timeZone);
  const back = (today.weekday + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => {
    const start = wallClock(timeZone, today.year, today.month, today.day - back + i);
    const end = wallClock(timeZone, today.year, today.month, today.day - back + i + 1);
    return { start, end, today: i === back };
  });
}

export { partsIn };
