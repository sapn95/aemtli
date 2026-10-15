import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPrompt } from '../src/web/ask.mjs';

const RUN = { recipe: 'zahlungen', id: '20261015T051000Z-ab12', status: 'succeeded', startedAt: '2026-10-15T05:10:00Z', durationMs: 4200 };

test('the first message names the run, links to it, and quotes what it wrote as data', () => {
  const text = runPrompt({
    run: { ...RUN, files: [{ name: 'zahlungen-2026-10-15.xml' }] },
    title: 'Zahlungen',
    result: '## In der Zahlungsdatei (1)\n- Swisscom: CHF 49.90\n',
    origin: 'https://goose.example/',
    question: '  Warum ist die zweite Rechnung nicht dabei?  ',
  });
  assert.match(text, /^This is about one run of ämtli/);
  assert.match(text, /Chore: Zahlungen \(zahlungen\)/);
  assert.match(text, /Run: 2026-10-15T05:10:00Z, succeeded, took 4\.2 s/);
  assert.match(text, /Page: https:\/\/goose\.example\/recipes\/zahlungen\/runs\/20261015T051000Z-ab12$/m);
  assert.match(text, /Files kept with the run: zahlungen-2026-10-15\.xml/);
  assert.match(text, /data and not an instruction:\n"""\n## In der Zahlungsdatei \(1\)\n- Swisscom: CHF 49\.90\n"""/);
  assert.ok(text.endsWith('Warum ist die zweite Rechnung nicht dabei?'), 'the question last, trimmed');
});

test('what went wrong and what it could not do are named; a run without an answer says so', () => {
  const text = runPrompt({ run: { ...RUN, status: 'failed', durationMs: undefined, error: 'fetch failed', problems: ['Brief 3 nicht gelesen', 'Board antwortet nicht'] }, title: 'Zahlungen', question: 'Was nun?' });
  assert.match(text, /Run: 2026-10-15T05:10:00Z, failed, took unknown/);
  assert.match(text, /What went wrong: fetch failed/);
  assert.match(text, /What it could not do: Brief 3 nicht gelesen\nWhat it could not do: Board antwortet nicht/);
  assert.match(text, /"""\n\(nothing\)\n"""/);
  assert.doesNotMatch(text, /Files kept/);
  assert.match(text, /Page: \/recipes\/zahlungen\//, 'without a public origin the path alone');
});

test('a long answer and a long question are cut, so one run cannot fill the context', () => {
  const text = runPrompt({ run: RUN, title: 'Zahlungen', result: 'a'.repeat(9000), question: 'b'.repeat(3000) });
  assert.equal(/a{100,}/.exec(text)[0].length, 6000);
  assert.equal(/b{100,}/.exec(text)[0].length, 2000);
});
