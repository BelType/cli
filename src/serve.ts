/**
 * `beltype serve`: `beltype print` behind an HTTP door, with one Chromium kept warm, as Gotenberg does.
 *
 * @remarks
 * **One browser, one context, one holder page.** The context carries the companions' routes; the holder page opens the shared writer worker (Caster's `formeSharedWorkerUrl()`) and keeps it for as long as the page lives, so forme's WebAssembly stays warm across prints. A print is a new page in that context, routed to its own folder alone ({@link routeDocument}), run through {@link printOnPage} with `sharedWriter`, and closed.
 *
 * **One at a time, and kept alive.** A promise chain runs the prints in turn. The browser is closed and started again (routes, holder page, warm-up) after `restartAfter` prints and after a print that failed with a 500, and a disconnected browser is started again before the next print. The warm-up prints a built-in document twice under forme, so the first request is warm too.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { ciceroFlags } from '@beltype/cicero/flags';
import { BuildError, ValidationError, FlagError } from '@beltype/common/errors';
import { cliFlags, createdFromEnv, parseFlagArgs, type Given } from './flags.ts';
import { ARGS, ORIGIN, VIEWPORT, documentAssets, servedHtml, routeCompanions, routeDocument, printOnPage, refusal, type Assets, type Printed } from './run.ts';

/** `maxUpload` is in bytes and `timeout` in milliseconds here; the command line speaks megabytes and seconds. `onBrowser` is told each browser as it starts, for tests. */
export type ServeOptions = { host: string; port: number; maxUpload: number; timeout: number; restartAfter: number; log?: (line: string) => void; onBrowser?: (browser: Browser) => void };

const HOLDER_PATH = '/_beltype/holder.html';
const HOLDER = `<!doctype html><html><head><meta charset="utf-8"><title>holder</title></head><body><script type="module">
const c = await import('/_beltype/caster/src/index.js');
window.sw = new SharedWorker(c.formeSharedWorkerUrl(), { type: 'module', name: 'forme' });
</script></body></html>`;

// Run from src/ or from dist/src/: the package root is the first folder up that holds `assets`.
const WARMUP_FONT = [1, 2].map((up) => fileURLToPath(new URL(`${'../'.repeat(up)}assets/warmup/SourceSans3-Variable.woff2`, import.meta.url))).find((f) => fs.existsSync(f))!;
const WORDS = 'the quick brown fox jumps over a lazy dog while leaf litter decomposes along an altitudinal gradient and soil carbon settles slowly beneath the canopy of old beech and spruce'.split(' ');
const paragraph = (n: number) => Array.from({ length: 90 }, (_, i) => WORDS[(i * 7 + n * 3) % WORDS.length]).join(' ') + '.';
/** Plain paragraphs and one heading, in the one face the CLI ships for it (`assets/warmup/`, SIL OFL): neither Cicero nor Caster supplies a default face, and Caster refuses a document with none. */
const WARMUP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Warm-up</title><style>@font-face { font-family: Warm; src: url(warm.woff2) format("woff2"); font-weight: 200 900 } @page { size: A4; margin: 20mm } body { font: 11pt/1.4 Warm }</style></head><body><h1>Warm-up</h1>${Array.from({ length: 16 }, (_, n) => `<p>${paragraph(n)}</p>`).join('')}</body></html>`;

/** Milliseconds per step of one print, by name. */
type Steps = Record<string, number>;

const lapper = (steps: Steps) => {
  const began: Record<string, number> = {};
  return { start: (name: string) => { began[name] = performance.now(); }, end: (name: string) => { steps[name] = performance.now() - (began[name] ?? performance.now()); } };
};

const stepsLine = (steps: Steps, printed: Printed) => `${['page', 'load', 'cut', 'print', 'close'].map((n) => `${n} ${Math.round(steps[n] ?? 0)}`).join(', ')}; caster ${Object.entries(printed.caster?.ms ?? {}).map(([k, v]) => `${k} ${Math.round(Number(v))}`).join(', ')}`;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function serve(options: ServeOptions): Promise<{ url: string; close(): Promise<void> }> {
  const log = options.log ?? ((line: string) => console.log(line));
  const assets: Assets = documentAssets();
  const missing = new Set<string>();
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let version = 'unknown';
  let restarting = false;
  let needsRestart = false;
  let prints = 0;
  let sinceStart = 0;
  let queued = 0;
  let tail: Promise<unknown> = Promise.resolve();

  const stopBrowser = async () => {
    const old = browser;
    browser = context = null;
    await old?.close().catch(() => {});
  };

  /** Run `html` and `files` through the print's road on a new page; the folder and the page are gone after. */
  const render = async (files: Map<string, Uint8Array>, given: Given, created: string | undefined, steps: Steps = {}): Promise<Printed> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-serve-'));
    try {
      for (const [name, bytes] of files) {
        const file = path.join(root, ...name.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      }
      const flags = { caster: given.caster, cicero: ciceroFlags.resolve(given.cicero as never), beltype: cliFlags.resolve(given.beltype as never) };
      const docPath = '/index.html';
      const served = servedHtml(Buffer.from(files.get('index.html')!).toString('utf8'));
      missing.clear();
      const lapped = lapper(steps);
      lapped.start('page');
      const page = await context!.newPage();
      try {
        await routeDocument(page, missing, { root, docPath, served });
        lapped.end('page');
        const printed = await printOnPage(page, missing, flags, { docPath, sharedWriter: true, progress: { step: lapped.start, lap: lapped.end }, ...(created !== undefined ? { created } : {}) });
        lapped.end('print');
        if (missing.size) throw refusal(missing, null);
        return printed;
      } finally {
        lapped.start('close');
        await page.close().catch(() => {});
        lapped.end('close');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  const start = async () => {
    browser = await chromium.launch({ headless: true, args: ARGS });
    const mine = browser;
    version = mine.version();
    mine.on('disconnected', () => { if (browser === mine) needsRestart = true; });
    options.onBrowser?.(mine);
    context = await mine.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
    await routeCompanions(context, missing, assets);
    // Registered after the companions' routes, so it runs first.
    await context.route(ORIGIN + HOLDER_PATH, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: servedHtml(HOLDER) }));
    const holder = await context.newPage();
    await holder.goto(ORIGIN + HOLDER_PATH, { waitUntil: 'load' });
    await holder.waitForFunction(() => (window as unknown as { sw?: unknown }).sw !== undefined);
    const given = await parseFlagArgs(['caster.writer=forme']);
    for (const n of [1, 2]) {
      const printed = await render(new Map([['index.html', Buffer.from(WARMUP)], ['warm.woff2', fs.readFileSync(WARMUP_FONT)]]), given, undefined);
      log(`beltype serve: warm-up ${n}: ${printed.pages} pages, forme write ${printed.caster?.ms['emit'] ?? '?'} ms`);
    }
    needsRestart = false;
    sinceStart = 0;
  };

  const restart = async () => {
    restarting = true;
    try {
      await stopBrowser();
      log('beltype serve: restarting the browser');
      await start();
    } catch (error) {
      needsRestart = true;
      throw error;
    } finally {
      restarting = false;
    }
  };

  /** Runs `job` after every earlier job and after any restart it needs; the restart a job asks for happens before the next one. */
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    queued++;
    const result = tail.then(async () => {
      queued--;
      if (needsRestart || sinceStart >= options.restartAfter) await restart();
      return job();
    });
    tail = result.then(async () => { if (needsRestart || sinceStart >= options.restartAfter) await restart(); }).catch(() => {});
    return result;
  };

  await start();

  const print = async (req: http.IncomingMessage): Promise<{ bytes: Buffer; printed: Printed; writer: string }> => {
    const form = await readForm(req, options.maxUpload);
    const files = new Map<string, Uint8Array>();
    const args: string[] = [];
    let created: string | undefined;
    for (const [name, value] of form.entries()) {
      if (typeof value !== 'string') {
        files.set(plainName(name), new Uint8Array(await value.arrayBuffer()));
      } else if (name === 'created') {
        created = instant(value);
      } else {
        if (name === 'beltype.check') throw new ValidationError('beltype serve: beltype.check is refused; the server writes no files of its own.');
        args.push(`${name}=${value}`);
      }
    }
    if (!files.has('index.html')) throw new ValidationError('beltype serve: the form has no index.html file.');
    const given = await parseFlagArgs(args);
    created ??= createdFromEnv();
    const writer = String(given.caster['writer'] ?? 'pdf-lib');
    return enqueue(async () => {
      const id = prints + 1;
      log(`beltype serve: print ${id} started`);
      const t0 = performance.now();
      const steps: Steps = {};
      const run = render(files, given, created, steps);
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(504, `beltype serve: the print took over ${options.timeout / 1000} s.`)), options.timeout); });
      try {
        const printed = await Promise.race([run, limit]);
        prints++;
        sinceStart++;
        log(`beltype serve: print ${id}: 200, ${printed.pages} pages, ${writer}, ${Math.round(performance.now() - t0)} ms (write ${printed.caster?.ms['emit'] ?? '?'} ms)`);
        log(`beltype serve: print ${id}: ${stepsLine(steps, printed)}`);
        return { bytes: printed.bytes, printed, writer };
      } catch (error) {
        prints++;
        sinceStart++;
        run.catch(() => {});
        if (!(error instanceof BuildError) && !(error instanceof HttpError)) needsRestart = true;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
  };

  const server = http.createServer(async (req, res) => {
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string | number> = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    const text = (status: number, message: string) => send(status, 'text/plain; charset=utf-8', message + '\n');
    try {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      if (pathname === '/health') {
        if (req.method !== 'GET') return text(405, 'beltype serve: /health takes GET.');
        return send(restarting ? 503 : 200, 'application/json', JSON.stringify({ status: restarting ? 'restarting' : 'up', chromium: version, prints, queued }));
      }
      if (pathname !== '/print') return text(404, `beltype serve: no ${pathname}; there is POST /print and GET /health.`);
      if (req.method !== 'POST') return text(405, 'beltype serve: /print takes POST.');
      const { bytes, printed, writer } = await print(req);
      for (const warning of printed.warnings) log(`beltype serve: warning: ${typeof warning === 'string' ? warning : JSON.stringify(warning)}`);
      send(200, 'application/pdf', bytes, { 'x-beltype-pages': printed.pages, 'x-beltype-words': printed.words, 'x-beltype-warnings': printed.warnings.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof HttpError ? error.status : error instanceof BuildError ? 422 : error instanceof ValidationError || error instanceof FlagError ? 400 : 500;
      log(`beltype serve: ${req.method} ${req.url}: ${status}`);
      if (status === 413) {
        // Keep nothing more: answer, discard what still arrives (a client cut off mid-write sees EPIPE, not the 413), and drop the connection after a second if the client is still sending.
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(message + '\n', () => {
          req.resume();
          setTimeout(() => req.destroy(), 1000).unref();
        });
      } else if (!res.headersSent) text(status, message);
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve); });
  const address = server.address() as { port: number };
  const url = `http://${options.host}:${address.port}`;
  log(`beltype serve: listening on ${url}`);
  return {
    url,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await tail;
      await stopBrowser();
    }
  };
}

/** The request's multipart form, read up to `limit` bytes. @throws {HttpError} 413 as soon as the count passes the limit; {ValidationError} where the body is not a form. */
async function readForm(req: http.IncomingMessage, limit: number): Promise<FormData> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, `beltype serve: the upload is ${declared} bytes, over the limit of ${limit}.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `beltype serve: the upload is over the limit of ${limit} bytes.`);
    chunks.push(chunk);
  }
  const type = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data/i.test(type)) throw new ValidationError('beltype serve: POST /print takes multipart/form-data.');
  try {
    return await new Response(Buffer.concat(chunks), { headers: { 'content-type': type } }).formData();
  } catch {
    throw new ValidationError('beltype serve: the body is not a well-formed multipart/form-data.');
  }
}

/** A file's name as a path relative to the document: plain segments joined by `/`. @throws {ValidationError} where it is absolute, climbs out or is not a plain name. */
function plainName(name: string): string {
  const segments = name.split('/');
  if (!name || segments.some((s) => s === '' || s === '.' || s === '..' || /[\\\0:]/.test(s))) throw new ValidationError(`beltype serve: the file name "${name}" is not a plain relative path with / separators (no absolute path, no "..").`);
  return name;
}

/** An ISO 8601 instant, normalised. @throws {ValidationError} */
function instant(value: string): string {
  const date = new Date(value);
  if (!/^\d{4}-\d\d-\d\dT/.test(value) || Number.isNaN(date.getTime())) throw new ValidationError(`beltype serve: created is an ISO 8601 instant; got "${value}".`);
  return date.toISOString();
}
