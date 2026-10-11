#!/usr/bin/env node
// Stands in for `goose run` in the runner tests. FAKE_GOOSE_MODE picks what
// it does; every call appends its arguments to FAKE_GOOSE_ARGS.
import { readFileSync, appendFileSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
appendFileSync(process.env.FAKE_GOOSE_ARGS, `${JSON.stringify(process.argv.slice(2))}\n`);

// Like goose 1.54: a recipe path that is a symlink is refused.
const recipe = process.argv[process.argv.indexOf('--recipe') + 1];
if (recipe && lstatSync(recipe).isSymbolicLink()) {
  process.stderr.write(`Error: Failed to read recipe file ${recipe}: Too many levels of symbolic links (os error 40)\n`);
  process.exit(1);
}
const mode = process.env.FAKE_GOOSE_MODE ?? 'success';

if (mode === 'success') process.stdout.write(readFileSync(join(here, 'goose-success.json')));
else if (mode === 'network') process.stdout.write(readFileSync(join(here, 'goose-network-error.json')));
else if (mode === 'garbage') process.stdout.write('this is not json');
else if (mode === 'crash') {
  process.stderr.write('thread main panicked\nError: something specific broke\n');
  process.exit(3);
} else if (mode === 'slow') {
  process.stderr.write('working\n');
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 1000);
}
