// A job: a chore done by code, with the model asked only where judgement is
// needed. `aemtli job <name>` imports `<name>.mjs` from the recipes
// directory and calls its default export with a context:
//
//   ctx.mcp('epost')         an MCP client for a gateway (approvals still apply)
//   ctx.cards()              cards on the kanban board for what waits for the
//                            owner, through the kanban gateway (see cards.mjs)
//   ctx.ask({ prompt, ... }) one message to the model through the model proxy;
//                            a small model by default, tokens counted
//   ctx.notify({...})        one push, when the run is worth a look on a
//                            phone: through the web pod (Web Push and ntfy)
//                            or straight to ntfy
//   ctx.pdfText(bytes)       a PDF's text, laid out as on the page
//   ctx.qr(bytes)            the QR codes on a PDF's pages, as text
//   ctx.bills(bytes)         the Swiss QR bills on a PDF, read and checked
//   ctx.paymentFile({...})   a pain.001 file for e-banking (see pain001.mjs)
//   ctx.attach(name, data)   a file kept with the run, downloadable from its
//                            page (a payment file, a list)
//   ctx.runLink              this run's page, for a push that opens it
//   ctx.state                JSON kept between runs of this job (save with
//                            ctx.saveState()), e.g. what was already reported
//   ctx.fetch, ctx.log, ctx.now, ctx.params
//
// It returns the result as Markdown. A job that throws has failed, with the
// error as its reason. The run is recorded like a goose run, so the dashboard
// shows both alike.
//
// The model gets text and returns text: no tools, so whatever a letter or a
// web page says cannot make it do anything.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { prepareZXingModule, purgeZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { createRunDir, newRunId, pruneRuns, writeJsonAtomic, RECIPE_NAME, ATTACHMENT_NAME, ATTACHMENT_TYPES } from '../store/runs.mjs';
import { createMcpClient } from './mcp-client.mjs';
import { jobCards } from './cards.mjs';
import { parseSwissQr } from './swissqr.mjs';
import { buildPain001 } from './pain001.mjs';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
const THINKING_ROOM = 2048;
const ATTACHMENT_MAX = 10 * 1024 * 1024;
const ATTACHMENTS_PER_RUN = 20;
// A PDF the QR reader takes, and the longest side a page is drawn at: 2400
// pixels is about 200 dpi on A4, which read every scan it was tried on, and a
// page that claims to be two metres tall is drawn no bigger.
const QR_PDF_MAX = 25 * 1024 * 1024;
const QR_PIXELS = 2400;
// What drawing is given, per page and in all. run()'s own minute is for the
// whole PDF however long it is, and three Zivilschutz call-ups were killed at
// 60000 ms every morning while the shorter letters in the same runs were
// drawn inside it. How long a page really takes is not known yet, so a page
// keeps the whole minute it had and the ceiling keeps three such letters
// inside the job's activeDeadlineSeconds of 1800.
const QR_MS_PER_PAGE = 60_000;
const QR_MS_MAX = 300_000;

// The QR reader is ZXing compiled to WebAssembly, loaded from the package
// itself and never from a network. zbar was tried first and missed the codes
// on two of four real scanned bills, which ZXing read; trying harder costs
// little next to drawing the page.
let zxingReady = false;
function zxing() {
  if (!zxingReady) {
    const wasm = readFileSync(createRequire(import.meta.url).resolve('zxing-wasm/reader/zxing_reader.wasm'));
    prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) } });
    zxingReady = true;
  }
  return readBarcodes;
}
// tryHarder: without it the iCalendar code on a real Zivilschutz call-up was
// missed. A turned page is tried too; light codes on dark ground are not
// printed on letters.
const QR_OPTIONS = { formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: false, maxNumberOfSymbols: 0 };

/**
 * Why a child process failed, in one line. Node's own first line is "Command
 * failed" and the command again, which is what the run was already told; the
 * reason is on the lines after it, or in stderr, or in the signal that killed
 * it. Three Zivilschutz letters failed on `pdftoppm` for months and the log
 * held nothing but the command line.
 */
function whyChildFailed(err, stderr, timeout) {
  const said = String(stderr ?? '').split('\n').map(line => line.trim()).filter(Boolean).slice(0, 2).join('; ');
  const tail = said ? `: ${said}` : '';
  if (err.code === 'ENOENT') return 'not installed';
  // A timeout and the kernel's own kill both arrive as a signal, and a killed
  // process writes nothing: the signal is then the only thing that says why.
  if (err.killed || err.signal) return `killed by ${err.signal ?? 'a signal'} at ${timeout} ms${tail}`;
  return `exit ${err.code}${tail}`;
}

/** Runs a program on its arguments; resolves with its stdout and exit code, or rejects saying why it failed. */
const run = (cmd, args, { okCodes = [0], timeout = 60_000 } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
    if (!err || okCodes.includes(err.code)) resolve({ stdout: stdout ?? '', code: err?.code ?? 0 });
    else reject(new Error(`${cmd}: ${whyChildFailed(err, stderr, timeout)}`));
  });
});


/** The model client, through the model proxy that holds the real key. */
function anthropicFrom(env) {
  // Two minutes a call: a run has half an hour in all, and a hung call must
  // not take it, or the run is killed before it can record why.
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? 'placeholder', baseURL: env.ANTHROPIC_HOST, maxRetries: 2, timeout: 120_000 });
}

/**
 * Runs job `name`, writing run.json, result.md and run.log under `dataDir`.
 * Resolves with the run record.
 */
export async function runJob({
  name,
  recipesDir,
  dataDir,
  trigger = 'manual',
  params = {},
  keep = 50,
  env = process.env,
  gateways = {},
  anthropic = anthropicFrom(env),
  fetchImpl = fetch,
  // The first wait before a push is tried again; it doubles each time.
  retryMs = 2000,
  now = () => new Date(),
}) {
  if (!RECIPE_NAME.test(name)) throw new Error(`not a job name: ${name}`);
  const file = join(recipesDir, `${name}.mjs`);
  if (!existsSync(file)) throw new Error(`no job file ${file}`);

  const started = now();
  const id = newRunId(started);
  const dir = createRunDir(dataDir, name, id);
  const record = { recipe: name, id, trigger, kind: 'job', status: 'running', startedAt: started.toISOString(), model: null };
  writeJsonAtomic(join(dir, 'run.json'), record);
  const logPath = join(dir, 'run.log');
  const log = line => appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);

  // Next to the job's runs, on the one volume a run may write.
  const statePath = join(dataDir, 'runs', name, 'state.json');
  let state = {};
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (err) {
      // Started empty, which may repeat what was reported before: say so.
      log(`the state could not be read and starts empty: ${err.message}`);
    }
  }

  // Where a job may push, if the pod was given the settings for it: the web
  // pod's notify port, which sends on to every channel it has, or else ntfy.
  const relay = env.NOTIFY_URL && env.NOTIFY_TOKEN_FILE ? { url: env.NOTIFY_URL, tokenFile: env.NOTIFY_TOKEN_FILE } : null;
  const ntfy = !relay && env.NTFY_URL && env.NTFY_TOPIC && env.NTFY_TOKEN_FILE
    ? { url: new URL(env.NTFY_URL).origin + new URL(env.NTFY_URL).pathname.replace(/\/$/, ''), topic: env.NTFY_TOPIC, tokenFile: env.NTFY_TOKEN_FILE }
    : null;

  const files = [];
  const problems = [];
  const tokens = { input: 0, output: 0, total: 0 };
  const models = new Set();
  const clients = [];
  const ctx = {
    params,
    state,
    log,
    /**
     * Records something that went wrong without ending the run: a letter that
     * could not be read, a feed that did not answer. The run finishes as
     * "degraded" instead of "succeeded", because a report with a hole in it
     * read as a clean run for months.
     */
    problem(message) {
      const line = String(message);
      problems.push(line);
      log(`problem: ${line}`);
      return line;
    },
    fetch: fetchImpl,
    now,
    runLink: env.PUBLIC_ORIGIN ? `${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/recipes/${name}/runs/${id}` : undefined,
    /**
     * Keeps a file with this run, for the owner to download from the run
     * page. `name` is a plain file name, `type` one of ATTACHMENT_TYPES; a
     * second file of the same name replaces the first.
     */
    attach(fileName, data, type = 'text/plain') {
      if (!ATTACHMENT_NAME.test(fileName)) throw new Error(`not a file name for a run: ${fileName}`);
      if (!ATTACHMENT_TYPES.has(type)) throw new Error(`not a type a run keeps: ${type}`);
      const bytes = Buffer.from(data);
      if (bytes.length > ATTACHMENT_MAX) throw new Error(`${fileName} is ${bytes.length} bytes, over ${ATTACHMENT_MAX}`);
      const at = files.findIndex(f => f.name === fileName);
      if (at < 0 && files.length >= ATTACHMENTS_PER_RUN) throw new Error(`a run keeps at most ${ATTACHMENTS_PER_RUN} files`);
      mkdirSync(join(dir, 'files'), { recursive: true });
      writeFileSync(join(dir, 'files', fileName), bytes);
      const entry = { name: fileName, type, bytes: bytes.length };
      if (at >= 0) files[at] = entry;
      else files.push(entry);
      log(`kept ${fileName} (${bytes.length} bytes)`);
      return entry;
    },
    /**
     * The QR codes on the first `pages` pages of a PDF, as their text, in
     * page order: pdftoppm draws the pages, ZXing reads the codes. An empty
     * list when there are none. A page the reader fails on fails the call:
     * a bill on it would otherwise be missed without a word.
     */
    /**
     * The Swiss QR bills on a PDF: for each code that is one, { ok, bill }
     * or { ok: false, why } from swissqr.mjs. Other codes are left out.
     */
    async bills(bytes) {
      return (await ctx.qr(bytes)).filter(code => code.startsWith('SPC')).map(parseSwissQr);
    },
    /** A pain.001 payment file from bills; buildPain001 says what it takes. */
    paymentFile({ debtor, payments, messageId }) {
      return buildPain001({ debtor, payments, messageId, now: now() });
    },
    async qr(bytes, { pages = 8 } = {}) {
      const pdf = Buffer.from(bytes);
      if (pdf.length > QR_PDF_MAX) throw new Error(`a PDF of ${pdf.length} bytes is over the ${QR_PDF_MAX} the QR reader takes`);
      const work = await mkdtemp(join(tmpdir(), 'aemtli-qr-'));
      try {
        await writeFile(join(work, 'in.pdf'), pdf);
        const info = (await run('pdfinfo', [join(work, 'in.pdf')])).stdout;
        const total = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
        if (total > pages) log(`the PDF has ${total} pages; QR codes were looked for on the first ${pages}`);
        // Drawing gets room for the pages it will draw, and the log keeps how
        // long it took, which is the number nobody has yet. It is logged even
        // when drawing fails, because that is the run that needs it.
        const drawn = Math.max(1, Math.min(total || pages, pages));
        const drawing = Date.now();
        try {
          await run('pdftoppm', ['-scale-to', String(QR_PIXELS), '-l', String(pages), '-png', join(work, 'in.pdf'), join(work, 'page')],
            { timeout: Math.min(QR_MS_PER_PAGE * drawn, QR_MS_MAX) });
        } finally {
          log(`drawing ${drawn} ${drawn === 1 ? 'page' : 'pages'} took ${Date.now() - drawing} ms`);
        }
        const images = (await readdir(work)).filter(f => f.endsWith('.png')).sort();
        const read = zxing();
        const codes = [];
        for (const image of images) {
          try {
            for (const r of await read(new Blob([await readFile(join(work, image))]), QR_OPTIONS)) codes.push(r.text);
          } catch (err) {
            // The next call loads the reader afresh, in case this one broke it.
            purgeZXingModule();
            zxingReady = false;
            throw new Error(`${image} could not be read for QR codes: ${err.message}`, { cause: err });
          }
        }
        return [...new Set(codes)];
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
    saveState() {
      writeJsonAtomic(statePath, ctx.state);
    },
    /**
     * Sends one push. `title` and `message` are the whole of it: a phone
     * shows little, and what a job read may be nobody else's business.
     * Resolves to true when it went out, false when the pod has no push
     * settings or the push was refused, which never fails the run.
     */
    async notify({ title, message, click = env.PUBLIC_ORIGIN, tags = 'bell' }) {
      const target = relay ?? ntfy;
      if (!target) {
        log('nothing to notify with: set NOTIFY_URL and NOTIFY_TOKEN_FILE, or NTFY_URL, NTFY_TOPIC and NTFY_TOKEN_FILE');
        return false;
      }
      const text = {
        title: String(title).replace(/\s+/g, ' ').slice(0, 120),
        message: String(message).slice(0, 2000),
        ...(click ? { click } : {}),
      };
      // A new pod may not reach anything for its first seconds, until the
      // network policy knows it: a refused connection is tried again, three
      // more times, 2, 4 and 8 seconds apart. An answer, even a refusal by
      // the server, is not.
      const post = () => fetchImpl(target.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${readFileSync(target.tokenFile, 'utf8').trim()}`,
          'content-type': 'application/json',
        },
        // Published as JSON, which carries UTF-8 in the title too; a header
        // could only carry latin-1, and "Frist: Prämie" would lose its ä.
        body: JSON.stringify(relay
          ? { ...text, tags: String(tags) }
          : { topic: ntfy.topic, ...text, tags: String(tags).split(',').map(t => t.trim()).filter(Boolean) }),
        signal: AbortSignal.timeout(10_000),
      });
      try {
        let res;
        for (let attempt = 0; ; attempt += 1) {
          try {
            res = await post();
            break;
          } catch (err) {
            if (attempt === 3) throw err;
            log(`could not reach ${relay ? 'the web pod' : 'ntfy'} (${err.cause?.code ?? err.message}), trying again`);
            await new Promise(resolve => setTimeout(resolve, retryMs * 2 ** attempt));
          }
        }
        if (!res.ok) throw new Error(`${relay ? 'the web pod' : 'ntfy'} answered ${res.status}`);
        // The web pod answers 200 with whether any channel took it.
        if (relay && !(await res.json().catch(() => ({}))).delivered) throw new Error('the web pod had no channel that took it');
        log('notified');
        return true;
      } catch (err) {
        log(`could not notify: ${err.message}`);
        return false;
      }
    },
    /** A PDF's text as pdftotext -layout sees it: columns stay columns. */
    pdfText(bytes) {
      const timeout = 30_000;
      return new Promise((resolve, reject) => {
        const child = execFile('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], { maxBuffer: 16 * 1024 * 1024, timeout },
          (err, stdout, stderr) => (err ? reject(new Error(`pdftotext: ${whyChildFailed(err, stderr, timeout)}`)) : resolve(stdout)));
        child.stdin.on('error', () => {});
        child.stdin.end(Buffer.from(bytes));
      });
    },
    mcp(gateway) {
      const url = gateways[gateway];
      if (!url) throw new Error(`no gateway "${gateway}" in MCP_GATEWAYS`);
      const client = createMcpClient(url, { fetchImpl, log });
      clients.push(client);
      return client;
    },
    /** Cards on the board `board` (Ämtli unless named), one per reference. */
    cards({ board } = {}) {
      return jobCards(ctx.mcp('kanban'), { board, baseUrl: env.KANBAN_PUBLIC_URL, log });
    },
    /**
     * Asks the model once and resolves with its text. `maxTokens` is the room
     * for the answer; current models think first by default and that counts
     * too, so the request gets THINKING_ROOM on top, and `effort` (low by
     * default) keeps the thinking short.
     */
    async ask({ prompt, system, model = DEFAULT_MODEL, maxTokens = 1024, effort = 'low' }) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens + THINKING_ROOM,
        output_config: { effort },
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
      });
      models.add(model);
      tokens.input += response.usage?.input_tokens ?? 0;
      tokens.output += response.usage?.output_tokens ?? 0;
      tokens.total = tokens.input + tokens.output;
      log(`asked ${model}: ${response.usage?.input_tokens ?? 0} in, ${response.usage?.output_tokens ?? 0} out`);
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (response.stop_reason !== 'max_tokens') return text;
      // Thinking took it all: there is no answer to keep. Failing leaves the
      // job's state as it was, so the next run asks again.
      if (!text.trim()) throw new Error(`the model used its ${maxTokens + THINKING_ROOM} tokens before it answered`);
      log(`the answer was cut at ${maxTokens + THINKING_ROOM} tokens`);
      return `${text}\n\n*The answer was cut at its length limit.*`;
    },
  };

  let status = 'succeeded';
  let error = null;
  let markdown = '';
  try {
    const job = await import(pathToFileURL(file).href);
    if (typeof job.default !== 'function') throw new Error(`${name}.mjs has no default export to run`);
    const out = await job.default(ctx);
    markdown = typeof out === 'string' ? out : String(out?.markdown ?? '');
  } catch (err) {
    status = 'failed';
    error = err.message;
    log(`failed: ${err.stack ?? err.message}`);
  } finally {
    await Promise.allSettled(clients.map(c => c.close()));
  }

  // A run that got through its work but could not do part of it is not a run
  // that went well, and the one word the owner reads is this status.
  if (status === 'succeeded' && problems.length) status = 'degraded';

  const finished = now();
  writeFileSync(join(dir, 'result.md'), markdown ? `${markdown.trimEnd()}\n` : '');
  Object.assign(record, {
    status,
    finishedAt: finished.toISOString(),
    durationMs: finished - started,
    tokens,
    model: models.size ? [...models].join(', ') : null,
    error,
    ...(files.length ? { files } : {}),
    ...(problems.length ? { problems } : {}),
  });
  writeJsonAtomic(join(dir, 'run.json'), record);
  pruneRuns(dataDir, name, keep);
  return record;
}
