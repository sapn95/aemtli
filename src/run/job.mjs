// A job: a chore done by code, with the model asked only where judgement is
// needed. `aemtli job <name>` imports `<name>.mjs` from the recipes
// directory and calls its default export with a context:
//
//   ctx.mcp('epost')         an MCP client for a gateway (approvals still apply)
//   ctx.cards()              cards on the kanban board for what waits for the
//                            owner, through the kanban gateway (see cards.mjs)
//   ctx.ask({ prompt, ... }) one message to the model through the model proxy;
//                            a small model by default, tokens counted
//   ctx.notify({...})        one push through ntfy, when the run is worth a
//                            look on a phone
//   ctx.pdfText(bytes)       a PDF's text, laid out as on the page
//   ctx.qr(bytes)            the QR codes on a PDF's first pages, as text
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
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createRunDir, newRunId, pruneRuns, writeJsonAtomic, RECIPE_NAME, ATTACHMENT_NAME, ATTACHMENT_TYPES } from '../store/runs.mjs';
import { createMcpClient } from './mcp-client.mjs';
import { jobCards } from './cards.mjs';
import { parseSwissQr } from './swissqr.mjs';
import { buildPain001 } from './pain001.mjs';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
const THINKING_ROOM = 2048;
const ATTACHMENT_MAX = 10 * 1024 * 1024;
const ATTACHMENTS_PER_RUN = 20;
// A PDF the QR reader takes, and the longest side a page is drawn at: A4 at
// 300 dpi is 3508 pixels, and a page that claims to be two metres tall is
// drawn no bigger.
const QR_PDF_MAX = 25 * 1024 * 1024;
const QR_PIXELS = 3600;

/** Runs a program on its arguments; resolves with its stdout and exit code, or rejects with its first line of error. */
const run = (cmd, args, { okCodes = [0], timeout = 60_000 } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout, encoding: 'utf8' }, (err, stdout) => {
    if (!err || okCodes.includes(err.code)) resolve({ stdout: stdout ?? '', code: err?.code ?? 0 });
    else reject(new Error(`${cmd}: ${String(err.message).split('\n')[0]}`));
  });
});

/** The symbols in zbarimg's XML: text as it is, binary data from base64. */
export function zbarSymbols(xml) {
  const out = [];
  for (const [, attrs, cdata, plain] of String(xml).matchAll(/<data([^>]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/data>/g)) {
    const raw = cdata ?? plain ?? '';
    out.push(/format=['"]base64['"]/.test(attrs) ? Buffer.from(raw, 'base64').toString('utf8') : raw);
  }
  return out;
}

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

  // Where a job may push, if the pod was given the settings for it.
  const ntfy = env.NTFY_URL && env.NTFY_TOPIC && env.NTFY_TOKEN_FILE
    ? { url: new URL(env.NTFY_URL).origin + new URL(env.NTFY_URL).pathname.replace(/\/$/, ''), topic: env.NTFY_TOPIC, tokenFile: env.NTFY_TOKEN_FILE }
    : null;

  const files = [];
  const tokens = { input: 0, output: 0, total: 0 };
  const models = new Set();
  const clients = [];
  const ctx = {
    params,
    state,
    log,
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
      mkdirSync(join(dir, 'files'), { recursive: true });
      writeFileSync(join(dir, 'files', fileName), bytes);
      const entry = { name: fileName, type, bytes: bytes.length };
      const at = files.findIndex(f => f.name === fileName);
      if (at < 0 && files.length >= ATTACHMENTS_PER_RUN) throw new Error(`a run keeps at most ${ATTACHMENTS_PER_RUN} files`);
      if (at >= 0) files[at] = entry;
      else files.push(entry);
      log(`kept ${fileName} (${bytes.length} bytes)`);
      return entry;
    },
    /**
     * The QR codes on the first `pages` pages of a PDF, as their text, in
     * page order: pdftoppm draws the pages, zbarimg reads the codes. An
     * empty list when there are none.
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
        await run('pdftoppm', ['-scale-to', String(QR_PIXELS), '-l', String(pages), '-png', join(work, 'in.pdf'), join(work, 'page')]);
        const images = (await readdir(work)).filter(f => f.endsWith('.png')).sort().map(f => join(work, f));
        if (!images.length) return [];
        // 4 is zbarimg's "nothing found". 1 is "an image could not be
        // read", which can be one page of several: what the others gave
        // still counts, and the page is named in the log.
        const { stdout, code } = await run('zbarimg', ['--quiet', '--xml', '-Sdisable', '-Sqrcode.enable', ...images], { okCodes: [1, 4] });
        if (code === 1) {
          if (!stdout.includes('<barcodes')) throw new Error('zbarimg could not read the pages');
          log('zbarimg could not read every page; the codes it found on the others are used');
        }
        return [...new Set(zbarSymbols(stdout))];
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
     * Resolves to true when it went out, false when the pod has no ntfy
     * settings or ntfy refused, which never fails the run.
     */
    async notify({ title, message, click = env.PUBLIC_ORIGIN, tags = 'bell' }) {
      if (!ntfy) {
        log('nothing to notify with: NTFY_URL, NTFY_TOPIC and NTFY_TOKEN_FILE are not all set');
        return false;
      }
      try {
        // Published as JSON, which carries UTF-8 in the title too; a header
        // could only carry latin-1, and "Frist: Prämie" would lose its ä.
        const res = await fetchImpl(ntfy.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${readFileSync(ntfy.tokenFile, 'utf8').trim()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            topic: ntfy.topic,
            title: String(title).replace(/\s+/g, ' ').slice(0, 120),
            message: String(message).slice(0, 2000),
            tags: String(tags).split(',').map(t => t.trim()).filter(Boolean),
            ...(click ? { click } : {}),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
        log('notified');
        return true;
      } catch (err) {
        log(`could not notify: ${err.message}`);
        return false;
      }
    },
    /** A PDF's text as pdftotext -layout sees it: columns stay columns. */
    pdfText(bytes) {
      return new Promise((resolve, reject) => {
        const child = execFile('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
          (err, stdout) => (err ? reject(new Error(`pdftotext: ${err.message.split('\n')[0]}`)) : resolve(stdout)));
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
      return jobCards(ctx.mcp('kanban'), { board, log });
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
  });
  writeJsonAtomic(join(dir, 'run.json'), record);
  pruneRuns(dataDir, name, keep);
  return record;
}
