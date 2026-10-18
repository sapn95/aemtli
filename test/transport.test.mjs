import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createTransport, transportTools, swissTime, minutes, spoken, connection } from '../src/mcp/transport.mjs';
import { serveStdio } from '../src/mcp/stdio.mjs';

// 2026-10-19 06:00 in Zurich (summer time, UTC+2).
const SIX = Date.UTC(2026, 9, 19, 4, 0) / 1000;
const min = n => SIX + n * 60;

const station = name => ({ id: '1', name, coordinate: { type: 'WGS84', x: 47, y: 8 } });
const point = (name, which, at, more = {}) => ({ station: station(name), [which]: 'ignored', [`${which}Timestamp`]: at, delay: null, platform: null, prognosis: { platform: null }, ...more });

/** A connection as transport.opendata.ch sends it: a ride, a walk, a ride. */
const TRIP = {
  from: point('Zürich HB', 'departure', min(0), { platform: '7', prognosis: { platform: '8' }, delay: 3 }),
  to: point('Luzern', 'arrival', min(136), { platform: '5' }),
  duration: '00d02:16:00',
  transfers: 1,
  sections: [
    { journey: { name: '002505', category: 'IR', number: '75', operator: 'SBB', to: 'Luzern', passList: [{}, {}] }, walk: null, departure: point('Zürich HB', 'departure', min(0), { platform: '7', prognosis: { platform: '8' }, delay: 3 }), arrival: point('Zug', 'arrival', min(40), { platform: '2', delay: 0 }) },
    { journey: null, walk: { duration: 300 }, departure: point('Zug', 'departure', min(40)), arrival: point('Zug, Bahnhof', 'arrival', min(45)) },
    { journey: null, walk: null, departure: point('Zug, Bahnhof', 'departure', min(45)), arrival: point('Zug, Metalli', 'arrival', min(47)) },
    { journey: { name: '1234', category: 'B', number: '', operator: 'ZVB', to: 'Luzern' }, walk: null, departure: point('Zug, Metalli', 'departure', min(50)), arrival: point('Luzern', 'arrival', min(136), { platform: '5' }) },
  ],
};

/** The API behind a fetch, with every question written down. */
function fakeApi(answers = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    seen.push({ path: pathname, query: [...searchParams], headers: init.headers, hasSignal: Boolean(init.signal) });
    const answer = answers[pathname] ?? { status: 404, body: 'no route' };
    if (answer instanceof Error) throw answer;
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  return { seen, transport: createTransport({ baseUrl: 'https://api.example.com/v1/', fetchImpl }) };
}

const CONNECTIONS = { '/v1/connections': { body: { connections: [TRIP], from: station('Zürich HB'), to: station('Luzern') } } };

test('times are Swiss local time, summer and winter', () => {
  assert.equal(swissTime(SIX), '2026-10-19 06:00');
  assert.equal(swissTime(Date.UTC(2026, 11, 1, 8, 0) / 1000), '2026-12-01 09:00');
  assert.equal(swissTime(Date.UTC(2026, 11, 31, 23, 30) / 1000), '2027-01-01 00:30');
  assert.equal(swissTime(null), null);
  assert.equal(swissTime(undefined), null);
});

test('a duration is read as minutes and said in hours and minutes', () => {
  assert.equal(minutes('00d02:16:00'), 136);
  assert.equal(minutes('01d00:05:00'), 1445);
  assert.equal(minutes('2:16'), null);
  assert.equal(minutes(null), null);
  assert.equal(spoken(136), '2 h 16 min');
  assert.equal(spoken(120), '2 h');
  assert.equal(spoken(45), '45 min');
  assert.equal(spoken(0), '0 min');
  assert.equal(spoken(null), null);
});

test('a connection keeps what a person plans with, and drops the stops along the way', () => {
  const c = connection(TRIP);
  assert.deepEqual(c.departure, { station: 'Zürich HB', time: '2026-10-19 06:00', platform: '8', platformChanged: 'was 7', delayMinutes: 3 });
  assert.deepEqual(c.arrival, { station: 'Luzern', time: '2026-10-19 08:16', platform: '5' });
  assert.equal(c.duration, '2 h 16 min');
  assert.equal(c.transfers, 1);
  assert.deepEqual(c.sections[0], {
    line: 'IR 75', direction: 'Luzern', operator: 'SBB',
    from: { station: 'Zürich HB', time: '2026-10-19 06:00', platform: '8', platformChanged: 'was 7', delayMinutes: 3 },
    // A delay of 0 is no delay.
    to: { station: 'Zug', time: '2026-10-19 06:40', platform: '2' },
  });
  assert.deepEqual(c.sections[1], { walk: 'walk 5 min', from: 'Zug', to: 'Zug, Bahnhof', leave: '2026-10-19 06:40', arrive: '2026-10-19 06:45' });
  assert.equal(c.sections[2].walk, 'walk', 'a walk without a duration');
  assert.equal(c.sections[3].line, 'B', 'a line without a number');
  assert.doesNotMatch(JSON.stringify(c), /passList|002505|coordinate/);
});

test('a line with neither category nor number falls back to its name, then to nothing', () => {
  const ride = name => connection({ ...TRIP, sections: [{ ...TRIP.sections[0], journey: { name, category: '', number: null } }] }).sections[0].line;
  assert.equal(ride('ICE 5'), 'ICE 5');
  assert.equal(ride(undefined), null);
  const bare = connection({ sections: [{ journey: { category: 'S', number: '3' }, departure: {}, arrival: {} }] });
  assert.deepEqual(bare.sections[0], { line: 'S 3', direction: null, operator: null, from: { station: null, time: null }, to: { station: null, time: null } });
  assert.equal(bare.transfers, null);
  assert.equal(bare.duration, null);
  assert.deepEqual(connection({}).sections, []);
});

test('connections: every parameter goes out encoded, arrive-by included', async () => {
  const api = fakeApi(CONNECTIONS);
  const answer = await api.transport.connections({ from: 'Zürich HB', to: 'A&B=C', via: ['Zug', 'Arth-Goldau'], date: '2026-10-19', time: '09:00', arrival: true, limit: 2 });
  assert.deepEqual(api.seen[0].query, [['from', 'Zürich HB'], ['to', 'A&B=C'], ['via[]', 'Zug'], ['via[]', 'Arth-Goldau'], ['date', '2026-10-19'], ['time', '09:00'], ['isArrivalTime', '1'], ['limit', '2']]);
  assert.equal(api.seen[0].path, '/v1/connections', 'the trailing slash of the base is dropped');
  assert.equal(api.seen[0].headers.accept, 'application/json');
  assert.ok(api.seen[0].hasSignal, 'every question has a timeout');
  assert.equal(answer.from, 'Zürich HB');
  assert.equal(answer.to, 'Luzern');
  assert.equal(answer.connections.length, 1);
});

test('connections: without date and time it is now, leaving, four of them', async () => {
  const api = fakeApi(CONNECTIONS);
  await api.transport.connections({ from: ' Bern ', to: 'Thun', via: null });
  assert.deepEqual(api.seen[0].query, [['from', 'Bern'], ['to', 'Thun'], ['isArrivalTime', '0'], ['limit', '4']]);
});

test('connections: what is wrong with a question is said before anything is asked', async () => {
  const api = fakeApi(CONNECTIONS);
  const refused = async (args, pattern) => {
    await assert.rejects(api.transport.connections({ from: 'Bern', to: 'Thun', ...args }), err => pattern.test(err.message) && err.status === 400);
  };
  await refused({ from: '' }, /from is missing/);
  await refused({ from: 7 }, /from is missing/);
  await refused({ to: '  ' }, /to is missing/);
  await refused({ to: 'x'.repeat(201) }, /to is longer than 200/);
  await refused({ via: 'Zug' }, /via is a list of at most 2/);
  await refused({ via: ['a', 'b', 'c'] }, /via is a list of at most 2/);
  await refused({ via: ['Zug', ''] }, /via 2 is missing/);
  await refused({ date: '19.10.2026' }, /not a date/);
  await refused({ date: '2026-02-30' }, /not a day of the calendar/);
  await refused({ time: '25:00' }, /not a time/);
  await refused({ time: '9:00' }, /not a time/);
  await refused({ arrival: 'yes' }, /arrival is true or false/);
  await refused({ limit: 7 }, /limit is a whole number from 1 to 6/);
  await refused({ limit: 0 }, /limit is a whole number/);
  await refused({ limit: 2.5 }, /limit is a whole number/);
  assert.equal(api.seen.length, 0);
});

test('connections: a place the API does not know is named, with the tool that finds it', async () => {
  const nowhere = fakeApi({ '/v1/connections': { body: { connections: [], from: null, to: null, stations: { from: [], to: [] } } } });
  await assert.rejects(nowhere.transport.connections({ from: 'Nowhere', to: 'Bern' }), /no station or place found for "Nowhere"; transport_locations/);
  const noTo = fakeApi({ '/v1/connections': { body: { connections: [], from: station('Bern'), to: null } } });
  await assert.rejects(noTo.transport.connections({ from: 'Bern', to: 'Nowhere' }), err => /for "Nowhere"/.test(err.message) && err.status === 404);
  const none = fakeApi({ '/v1/connections': { body: { from: station('Bern'), to: station('Thun') } } });
  assert.deepEqual((await none.transport.connections({ from: 'Bern', to: 'Thun' })).connections, []);
});

test('when the API fails, the error says how', async () => {
  const ask = answer => fakeApi({ '/v1/connections': answer }).transport.connections({ from: 'Bern', to: 'Thun' });
  await assert.rejects(ask({ status: 429, body: 'slow down' }), err => /too many questions/.test(err.message) && err.status === 429);
  await assert.rejects(ask({ status: 500, body: ' boom ' }), err => err.message === 'transport.opendata.ch answered 500: boom' && err.status === 500);
  await assert.rejects(ask({ status: 502, body: '' }), err => err.message === 'transport.opendata.ch answered 502');
  await assert.rejects(ask({ body: '<html>' }), /not JSON/);
  await assert.rejects(ask({ status: 400, body: { errors: ['Invalid via count (max 2 allowed).'] } }), err => err.message === 'transport.opendata.ch refused the question: Invalid via count (max 2 allowed).' && err.status === 400);
  await assert.rejects(ask({ body: { errors: ['a', 'b'] } }), err => err.message === 'transport.opendata.ch refused the question: a; b' && err.status === 400);
  await assert.rejects(ask({ status: 400, body: { errors: [] } }), /answered 400: \{"errors":\[\]\}/);
  await assert.rejects(ask({ body: null }), /no station or place found for "Bern"/);
  await assert.rejects(ask(Object.assign(new Error('late'), { name: 'TimeoutError' })), /did not answer: no answer in 15 s/);
  await assert.rejects(ask(new Error('ECONNREFUSED')), /did not answer: ECONNREFUSED/);
});

test('stationboard: departures or arrivals at one station, with the platform and delay', async () => {
  const entry = { stop: point('Bern', 'departure', min(15), { platform: '7', delay: 2 }), name: '015241', category: 'S', number: '2', operator: 'BLS', to: 'Langnau i.E.', passList: [{}] };
  const api = fakeApi({ '/v1/stationboard': { body: { station: station('Bern'), stationboard: [entry] } } });
  const board = await api.transport.stationboard({ station: 'Bern', datetime: ' 2026-10-19  06:00 ', limit: 3, type: 'arrival' });
  assert.deepEqual(api.seen[0].query, [['station', 'Bern'], ['datetime', '2026-10-19 06:00'], ['limit', '3'], ['type', 'arrival']]);
  assert.equal(board.station, 'Bern');
  assert.equal(board.type, 'arrival');
  // An arrival board reads the arrival time; this entry only has a departure.
  assert.deepEqual(board.entries[0], { time: null, platform: '7', delayMinutes: 2, line: 'S 2', direction: 'Langnau i.E.', operator: 'BLS' });

  const now = fakeApi({ '/v1/stationboard': { body: { station: station('Bern') } } });
  const empty = await now.transport.stationboard({ station: 'Bern' });
  assert.deepEqual(now.seen[0].query, [['station', 'Bern'], ['limit', '8'], ['type', 'departure']]);
  assert.deepEqual(empty.entries, []);
  const departing = await fakeApi({ '/v1/stationboard': { body: { station: station('Bern'), stationboard: [entry] } } }).transport.stationboard({ station: 'Bern' });
  assert.equal(departing.entries[0].time, '2026-10-19 06:15');
});

test('stationboard: refusals, and a station the API does not know', async () => {
  const api = fakeApi({ '/v1/stationboard': { body: { station: null, stationboard: [] } } });
  for (const datetime of ['2026-10-19', '2026-10-19 9:00', '2026-10-19 09:00 x', '19.10.2026 09:00']) {
    await assert.rejects(api.transport.stationboard({ station: 'Bern', datetime }), err => err.status === 400, datetime);
  }
  await assert.rejects(api.transport.stationboard({ station: 'Bern', type: 'both' }), /type is departure or arrival/);
  await assert.rejects(api.transport.stationboard({ station: 'Bern', limit: 21 }), /from 1 to 20/);
  await assert.rejects(api.transport.stationboard({}), /station is missing/);
  assert.equal(api.seen.length, 0);
  await assert.rejects(api.transport.stationboard({ station: 'Nowhere' }), err => /no station found for "Nowhere"/.test(err.message) && err.status === 404);
});

test('locations: stations by default, at most ten, with where they are', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `Halt ${i}`, icon: 'bus', coordinate: { x: 46.9, y: 7.4 } }));
  many[1] = { id: null, name: 'Somewhere', coordinate: { x: null, y: null } };
  many[2] = { id: '2', name: 'Bundesplatz', type: 'address', icon: 'bus' };
  const api = fakeApi({ '/v1/locations': { body: { stations: many } } });
  const found = await api.transport.locations({ query: 'Halt' });
  assert.deepEqual(api.seen[0].query, [['query', 'Halt'], ['type', 'station']]);
  assert.equal(found.locations.length, 10);
  assert.deepEqual(found.locations[0], { name: 'Halt 0', id: '0', kind: 'bus', latitude: 46.9, longitude: 7.4 });
  assert.deepEqual(found.locations[1], { name: 'Somewhere', id: null, kind: null });
  assert.equal(found.locations[2].kind, 'address', 'the documented type first, the icon after it');
  await api.transport.locations({ query: 'Bundesplatz, Bern', type: 'all' });
  assert.deepEqual(api.seen[1].query, [['query', 'Bundesplatz, Bern'], ['type', 'all']]);
  assert.deepEqual(await fakeApi({ '/v1/locations': { body: {} } }).transport.locations({ query: 'x' }), { locations: [] });
  await assert.rejects(api.transport.locations({ query: 'Bern', type: 'city' }), /type is station, all, address or poi/);
  await assert.rejects(api.transport.locations({}), /query is missing/);
  await assert.rejects(api.transport.locations(), /query is missing/);
});

test('the tools: three, all of them only read', async () => {
  const api = fakeApi({ ...CONNECTIONS, '/v1/locations': { body: { stations: [] } }, '/v1/stationboard': { body: { station: station('Bern'), stationboard: [] } } });
  const tools = transportTools(api.transport);
  assert.deepEqual(tools.map(t => t.name), ['transport_locations', 'transport_connections', 'transport_stationboard']);
  assert.ok(tools.every(t => t.annotations.readOnlyHint === true && t.inputSchema.additionalProperties === false && t.description));
  const by = Object.fromEntries(tools.map(t => [t.name, t]));
  assert.deepEqual(by.transport_connections.inputSchema.required, ['from', 'to']);
  assert.equal((await by.transport_connections.run({ from: 'Zürich HB', to: 'Luzern' })).connections.length, 1);
  assert.deepEqual((await by.transport_locations.run({ query: 'Bern' })).locations, []);
  assert.equal((await by.transport_stationboard.run({ station: 'Bern' })).station, 'Bern');
});

test('over stdio: a refusal the agent can read', async () => {
  const api = fakeApi(CONNECTIONS);
  const input = new PassThrough();
  const output = new PassThrough();
  const out = [];
  output.on('data', d => out.push(...d.toString().split('\n').filter(Boolean).map(l => JSON.parse(l))));
  const done = serveStdio({ name: 'transport', version: '1', tools: transportTools(api.transport), input, output, log: () => {} });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'transport_connections', arguments: { from: 'Bern', to: 'Thun', date: 'tomorrow' } } })}\n`);
  await new Promise(r => setTimeout(r, 50));
  input.end();
  await done;
  const refused = out.find(m => m.id === 1).result;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /"tomorrow" is not a date/);
});

test('the real API is the default address', async () => {
  const seen = [];
  const transport = createTransport({ fetchImpl: async url => { seen.push(url); return new Response(JSON.stringify({ stations: [] })); } });
  await transport.locations({ query: 'Bern' });
  assert.match(seen[0], /^https:\/\/transport\.opendata\.ch\/v1\/locations\?/);
});
