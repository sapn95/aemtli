// Swiss public transport, for goose: stations, connections and departure
// boards from transport.opendata.ch, a community-run API over the official
// timetable. It needs no key and every tool only reads, so a gateway policy
// can allow all of them.
//
// The answers are cut down to what a person plans with: when and where a
// train leaves and arrives, the line, the platform, the delay, the walks in
// between. The API returns the stops along the way as well, which nobody asks
// for and which would fill the model's context.

const ZONE = 'Europe/Zurich';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// The API takes at most two places to go via, and answers a third with an
// error.
const MAX_VIA = 2;

const bad = message => Object.assign(new Error(message), { status: 400 });

/** A place name the API is asked about: a string, not empty, not a page long. */
function place(value, what) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw bad(`${what} is missing: a station, an address or a place`);
  if (s.length > 200) throw bad(`${what} is longer than 200 characters`);
  return s;
}

/** An integer in [min, max], `fallback` when none is given. */
function count(value, min, max, fallback, what) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw bad(`${what} is a whole number from ${min} to ${max}`);
  return value;
}

/** YYYY-MM-DD that is a day of the calendar. */
function day(value) {
  if (!DATE.test(value)) throw bad(`"${value}" is not a date (YYYY-MM-DD)`);
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw bad(`"${value}" is not a day of the calendar`);
  return value;
}

function clock(value) {
  if (!TIME.test(value)) throw bad(`"${value}" is not a time (HH:MM, 24 hours)`);
  return value;
}

const local = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** A Unix time in seconds as "YYYY-MM-DD HH:MM" in Swiss time; null for none. */
export function swissTime(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const p = Object.fromEntries(local.formatToParts(new Date(seconds * 1000)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** "00d02:16:00" as minutes; null when the API sends something else. */
export function minutes(duration) {
  const m = /^(\d+)d(\d{2}):(\d{2}):(\d{2})$/.exec(String(duration ?? ''));
  return m ? Number(m[1]) * 1440 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** 136 as "2 h 16 min", 45 as "45 min". */
export function spoken(total) {
  if (total === null) return null;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

/** The line as it stands on the board: "IR 15", "S 2", "B 10". */
function line(journey) {
  const name = [journey.category, journey.number].filter(Boolean).join(' ').trim();
  return name || journey.name || null;
}

/**
 * Where and when a section leaves or ends: the planned time, the platform
 * (the forecast one when it changed) and the delay in minutes when there is
 * one. Times are Swiss local time.
 */
function stop(point, which) {
  const planned = point?.[`${which}Timestamp`];
  const forecast = point?.prognosis?.platform;
  const out = { station: point?.station?.name ?? point?.location?.name ?? null, time: swissTime(planned) };
  const platform = forecast || point?.platform;
  if (platform) out.platform = platform;
  if (forecast && point?.platform && forecast !== point.platform) out.platformChanged = `was ${point.platform}`;
  if (point?.delay > 0) out.delayMinutes = point.delay;
  return out;
}

/** One leg of a connection: a ride on a line, or a walk. */
function section(s) {
  const from = stop(s.departure, 'departure');
  const to = stop(s.arrival, 'arrival');
  if (!s.journey) {
    const walked = Number.isFinite(s.walk?.duration) ? Math.round(s.walk.duration / 60) : null;
    return { walk: walked === null ? 'walk' : `walk ${walked} min`, from: from.station, to: to.station, leave: from.time, arrive: to.time };
  }
  return { line: line(s.journey), direction: s.journey.to ?? null, operator: s.journey.operator ?? null, from, to };
}

/** A connection as a person plans with it. */
export function connection(c) {
  const total = minutes(c.duration);
  return {
    departure: stop(c.from, 'departure'),
    arrival: stop(c.to, 'arrival'),
    duration: spoken(total),
    transfers: c.transfers ?? null,
    sections: (c.sections ?? []).map(section),
  };
}

/** A row of a departure or arrival board. */
function boardEntry(e, type) {
  const at = stop(e.stop, type);
  delete at.station;
  return { ...at, line: line(e), direction: e.to ?? null, operator: e.operator ?? null };
}

/**
 * `baseUrl` is the API, https://transport.opendata.ch/v1 unless a test or a
 * mirror says otherwise.
 */
export function createTransport({ baseUrl = 'https://transport.opendata.ch/v1', fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function get(path, params) {
    const query = new URLSearchParams();
    for (const [key, value] of params) if (value !== undefined && value !== null) query.append(key, String(value));
    let res;
    try {
      res = await fetchImpl(`${base}${path}?${query}`, {
        headers: { accept: 'application/json', 'user-agent': 'aemtli (github.com/sapn95/aemtli)' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`transport.opendata.ch did not answer: ${err.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : err.message}`, { cause: err });
    }
    const body = await res.text();
    if (res.status === 429) throw Object.assign(new Error('transport.opendata.ch has had too many questions from here for now; try again later'), { status: 429 });
    let data = null;
    try {
      data = JSON.parse(body);
    } catch {
      if (res.ok) throw new Error('transport.opendata.ch answered with something that is not JSON');
    }
    // A question it cannot take, such as a third place to go via, comes back
    // as a 400 with a list of errors in JSON.
    if (Array.isArray(data?.errors) && data.errors.length) throw Object.assign(new Error(`transport.opendata.ch refused the question: ${data.errors.map(String).join('; ')}`), { status: res.ok ? 400 : res.status });
    if (!res.ok) {
      const detail = body.trim().slice(0, 200) || res.statusText;
      throw Object.assign(new Error(`transport.opendata.ch answered ${res.status}${detail ? `: ${detail}` : ''}`), { status: res.status });
    }
    return data ?? {};
  }

  return {
    /** Stations (and, with type "all", addresses and places) that match `query`. */
    async locations({ query, type = 'station' } = {}) {
      if (!['station', 'all', 'address', 'poi'].includes(type)) throw bad(`type is station, all, address or poi, not "${type}"`);
      const data = await get('/locations', [['query', place(query, 'query')], ['type', type]]);
      return {
        locations: (data.stations ?? []).slice(0, 10).map(s => ({
          name: s.name,
          id: s.id ?? null,
          // type is documented but comes back empty; icon says train, bus, tram.
          kind: s.type ?? s.icon ?? null,
          ...(Number.isFinite(s.coordinate?.x) ? { latitude: s.coordinate.x, longitude: s.coordinate.y } : {}),
        })),
      };
    },

    /**
     * Connections from `from` to `to`. With `arrival`, `time` is when to be
     * there by, and the connections are the last ones that make it.
     */
    async connections({ from, to, via, date, time, arrival = false, limit } = {}) {
      const stops = via === undefined || via === null ? [] : via;
      if (!Array.isArray(stops) || stops.length > MAX_VIA) throw bad(`via is a list of at most ${MAX_VIA} places`);
      if (typeof arrival !== 'boolean') throw bad('arrival is true or false');
      const params = [
        ['from', place(from, 'from')],
        ['to', place(to, 'to')],
        ...stops.map((v, i) => ['via[]', place(v, `via ${i + 1}`)]),
        ['date', date === undefined ? undefined : day(date)],
        ['time', time === undefined ? undefined : clock(time)],
        ['isArrivalTime', arrival ? 1 : 0],
        ['limit', count(limit, 1, 6, 4, 'limit')],
      ];
      const data = await get('/connections', params);
      // An unknown place is no error to the API: it answers with nothing.
      if (!data.from) throw Object.assign(new Error(`no station or place found for "${from}"; transport_locations finds the name to use`), { status: 404 });
      if (!data.to) throw Object.assign(new Error(`no station or place found for "${to}"; transport_locations finds the name to use`), { status: 404 });
      return { from: data.from.name, to: data.to.name, connections: (data.connections ?? []).map(connection) };
    },

    /** The next departures (or arrivals) at one station. */
    async stationboard({ station, datetime, limit, type = 'departure' } = {}) {
      if (!['departure', 'arrival'].includes(type)) throw bad(`type is departure or arrival, not "${type}"`);
      let when;
      if (datetime !== undefined) {
        const [d, t, ...more] = String(datetime).trim().split(/\s+/);
        if (more.length || !t) throw bad(`"${datetime}" is not a date and time (YYYY-MM-DD HH:MM)`);
        when = `${day(d)} ${clock(t)}`;
      }
      const data = await get('/stationboard', [['station', place(station, 'station')], ['datetime', when], ['limit', count(limit, 1, 20, 8, 'limit')], ['type', type]]);
      if (!data.station) throw Object.assign(new Error(`no station found for "${station}"; transport_locations finds the name to use`), { status: 404 });
      return { station: data.station.name, type, entries: (data.stationboard ?? []).map(e => boardEntry(e, type)) };
    },
  };
}

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const PLACE = { type: 'string', description: 'A station ("Zürich HB"), an address (street, number and town) or a place. transport_locations finds the exact name.' };

/** The tools, for an MCP server: name, description, schema, and what each does. */
export function transportTools(transport) {
  const read = { readOnlyHint: true, openWorldHint: true };
  return [
    {
      name: 'transport_locations',
      description: 'Finds Swiss public transport stations by name, or with type "all" addresses and places too. Use it when a name is ambiguous or a connection finds nothing.',
      inputSchema: obj({ query: { type: 'string' }, type: { type: 'string', enum: ['station', 'all', 'address', 'poi'] } }, ['query']),
      annotations: read,
      run: a => transport.locations(a),
    },
    {
      name: 'transport_connections',
      description: 'Plans a trip by Swiss public transport: the connections from one place to another with departure, arrival, duration, transfers and each leg (line, platform, delay, walks). Times are Swiss local time. With arrival true, time is when to be there by and the answer is the last connections that make it; leave time to walk from the stop to the door.',
      inputSchema: obj({
        from: PLACE,
        to: PLACE,
        via: { type: 'array', items: { type: 'string' }, maxItems: MAX_VIA, description: 'Places the trip must pass through, in order.' },
        date: { type: 'string', description: 'YYYY-MM-DD; today when left out.' },
        time: { type: 'string', description: 'HH:MM, 24 hours; now when left out.' },
        arrival: { type: 'boolean', description: 'true: time is the latest arrival. false (the default): time is the earliest departure.' },
        limit: { type: 'integer', minimum: 1, maximum: 6, description: 'How many connections, 4 when left out.' },
      }, ['from', 'to']),
      annotations: read,
      run: a => transport.connections(a),
    },
    {
      name: 'transport_stationboard',
      description: 'The next departures or arrivals at one station, with line, direction, platform and delay. Times are Swiss local time.',
      inputSchema: obj({
        station: { type: 'string' },
        datetime: { type: 'string', description: 'YYYY-MM-DD HH:MM; now when left out.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '8 when left out.' },
        type: { type: 'string', enum: ['departure', 'arrival'] },
      }, ['station']),
      annotations: read,
      run: a => transport.stationboard(a),
    },
  ];
}
