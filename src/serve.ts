/**
 * `beltype serve`: `beltype print` behind an HTTP door, with one Chromium kept warm, as Gotenberg does.
 *
 * @remarks
 * **One browser, one context, one holder page.** The context carries the companions' routes; the holder page opens the shared writer worker (Caster's `formeSharedWorkerUrl()`) and keeps it for as long as the page lives, so forme's WebAssembly stays warm across prints. A print is a new page in that context, routed to its own folder alone ({@link routeDocument}), run through {@link printOnPage} with `sharedWriter`, and closed.
 *
 * **One kept print page, for a document with no script of its own.** A print re-seats the kept page as Caster's kept frame does (`document.open()` keeps the `Window`, so the realm, Caster's registry and the companions' modules stay warm; *the printer runs in the realm it prints*, Caster's DESIGN.md S20, S87, S89): its routes are swapped for the print's folder, the served document is written in, and each module script the document names gets a query of its own. That page is shared only by a document whose text, its JSON-LD data blocks aside, holds none of `<script`, `<iframe`, `<object`, `<embed`, `<frame`, `<portal`, `javascript:` or an `on…=` attribute ({@link keptRoad}); any other gets a new page, and the log line names the road. A print that fails or times out closes the kept page, and the next opens a new one.
 *
 * **A mail merge, on the same page.** `POST /templates` takes a template's folder once, and `POST /templates/<id>/print` takes one customer's values and rows as JSON. The first customer seats the template and merges in the tab; each later one replaces only the top-level boxes that changed and resumes the cut (`merge-tab.ts`), which keeps the sheets, the faces and the rewrite, and leaves nothing of the customer before. Where the shape of the body changed, or Cicero will not promise the patch, the template is seated again and the log line says why. Measured 2026-11-07 on the bolletta: the PDF byte for byte the folder route's, and 30 to 50 ms less on a 61-day bill (codeberg.org/BelType/cli issue 2).
 *
 * **One at a time, and kept alive.** A promise chain runs the prints in turn. The browser is closed and started again (routes, holder page, warm-up) after `restartAfter` prints and after a print that failed with a 500, and a disconnected browser is started again before the next print. The warm-up prints a built-in document twice under forme, so the first request is warm too.
 *
 * @packageDocumentation
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { ciceroFlags } from '@beltype/cicero/flags';
import { BuildError, ValidationError, FlagError } from '@beltype/common/errors';
import { cliFlags, createdFromEnv, parseFlagArgs, type Given } from './flags.ts';
import { ARGS, ORIGIN, VIEWPORT, documentAssets, servedHtml, routeCompanions, routeDocument, printOnPage, cutAndPrint, refusal, deferralLine, type Assets, type Printed } from './run.ts';
import { keepMergeInPage, reseatInPage, seatMergeInPage, type Conformance, type Refusal } from './in-page.ts';
import type { MergeData } from './merge-tab.ts';

/** `maxUpload` is in bytes and `timeout` in milliseconds here; the command line speaks megabytes and seconds. `sandbox` false launches Chromium without its sandbox, for a container that runs as root. `onBrowser` is told each browser as it starts, for tests. */
export type ServeOptions = { host: string; port: number; maxUpload: number; timeout: number; restartAfter: number; sandbox?: boolean; log?: (line: string) => void; onBrowser?: (browser: Browser) => void };

const HOLDER_PATH = '/_beltype/holder.html';
const HOLDER = `<!doctype html><html><head><meta charset="utf-8"><title>holder</title></head><body><script type="module">
const c = await import('/_beltype/caster/src/index.js');
window.sw = new SharedWorker(c.formeSharedWorkerUrl(), { type: 'module', name: 'forme' });
</script></body></html>`;

// Run from src/ or from dist/src/: the package root is the first folder up that holds `assets`.
export const WARMUP_FONT = [1, 2].map((up) => fileURLToPath(new URL(`${'../'.repeat(up)}assets/warmup/SourceSans3-Variable.woff2`, import.meta.url))).find((f) => fs.existsSync(f))!;
const WORDS = 'the quick brown fox jumps over a lazy dog while leaf litter decomposes along an altitudinal gradient and soil carbon settles slowly beneath the canopy of old beech and spruce'.split(' ');
const paragraph = (n: number) => Array.from({ length: 90 }, (_, i) => WORDS[(i * 7 + n * 3) % WORDS.length]).join(' ') + '.';
/** Plain paragraphs and one heading, in the one face the CLI ships for it (`assets/warmup/`, SIL OFL): neither Cicero nor Caster supplies a default face, and Caster refuses a document with none. */
export const WARMUP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Warm-up</title><style>@font-face { font-family: Warm; src: url(warm.woff2) format("woff2"); font-weight: 200 900 } @page { size: A4; margin: 20mm } body { font: 11pt/1.4 Warm }</style></head><body><h1>Warm-up</h1>${Array.from({ length: 16 }, (_, n) => `<p>${paragraph(n)}</p>`).join('')}</body></html>`;

/** One print's road and the milliseconds of each step, by name. */
type Trace = { road: 'kept' | 'fresh' | 'merge seated' | 'merge kept'; ms: Record<string, number> };

/** A template uploaded once: its folder on disk and the run's values. */
type Template = { id: string; root: string; author: string; given: Given };

/** ponytail: the oldest template is dropped past this, and its id answers 404; a named delete when a host needs to hold more. */
const TEMPLATES_KEPT = 16;

const DOC_PATH = '/index.html';

/** The binds that listen on every address, under which a request's `Host` cannot be checked against one name. */
const WILDCARD = new Set(['0.0.0.0', '::', '[::]']);

const lapper = (steps: Record<string, number>) => {
  const began: Record<string, number> = {};
  return { start: (name: string) => { began[name] = performance.now(); }, end: (name: string) => { steps[name] = performance.now() - (began[name] ?? performance.now()); } };
};

const stepsLine = ({ road, ms: steps }: Trace, printed: Printed) => `road ${road}; ${['page', 'load', 'merge', 'cut', 'print', 'close'].map((n) => `${n} ${Math.round(steps[n] ?? 0)}`).join(', ')}; caster ${Object.entries(printed.caster?.ms ?? {}).map(([k, v]) => `${k} ${Math.round(Number(v))}`).join(', ')}`;

/** A JSON-LD data block, which the browser never runs: an opening tag with that attribute and at most a plain `id`, as a store host saves it, to the first `</script` (the tokenizer ends the element there or later, never sooner, so what is cut is always inside the block). */
const DATA_BLOCK = /<script\s+type\s*=\s*(["']?)application\/ld\+json\1(?:\s+id\s*=\s*(["']?)[\w-]+\2)?\s*>[\s\S]*?<\/script/gi;

/** Whether a document may share the kept page: only one with no script of its own (the `Window` outlives `document.open()`, and so does a timer, a listener or a global a script left on it). A JSON-LD data block is data, not script, and does not count. The test is conservative; a false alarm costs only speed. */
export const keptRoad = (html: string) => !/<script|<iframe|<object|<embed|<frame|<portal|javascript:|\bon[a-z]+\s*=/i.test(html.replace(DATA_BLOCK, ''));

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function serve(options: ServeOptions): Promise<{ url: string; close(): Promise<void> }> {
  const log = options.log ?? ((line: string) => console.log(line));
  const assets: Assets = documentAssets();
  /** What the print running now could not answer; null between prints, so a page left over from one never writes into the next. */
  let active: Set<string> | null = null;
  /** The routes' one sink, context's and pages' alike: a kept page's routes outlive the print that set them. */
  const missing = { add: (entry: string) => active?.add(entry) };
  /** The page the print running now uses, which a timeout closes. */
  let current: Page | null = null;
  let kept: Page | null = null;
  /** The template whose merge the kept page shows, or null when it shows anything else. */
  let seated: string | null = null;
  const templates = new Map<string, Template>();
  let reseats = 0;
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
    browser = context = kept = seated = null;
    await old?.close().catch(() => {});
  };

  /** The kept page, opened on a blank document at the document's own path so that relative references resolve as a print's would. */
  const openKept = async () => {
    const page = await context!.newPage();
    page.on('pageerror', (error) => console.warn(`page error: ${error.message}`));
    await routeDocument(page, missing, { root: path.join(os.tmpdir(), 'beltype-serve-none'), docPath: DOC_PATH, served: servedHtml('<!doctype html><html><head></head><body></body></html>') });
    await page.goto(ORIGIN + DOC_PATH, { waitUntil: 'load' });
    seated = null;
    return kept = page;
  };

  /** Closes `page`, and forgets it if it is the kept one: a page a failed or timed-out print used is never reused. */
  const closePage = async (page: Page) => {
    if (kept === page) kept = seated = null;
    await page.close().catch(() => {});
  };

  /** Run `html` and `files` through the print's road: re-seated on the kept page where the document carries no script of its own, else on a new page. The folder is gone after. */
  const render = async (files: Map<string, Uint8Array>, given: Given, created: string | undefined, trace: Trace = { road: 'fresh', ms: {} }): Promise<Printed> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-serve-'));
    const mine = new Set<string>();
    try {
      for (const [name, bytes] of files) {
        const file = path.join(root, ...name.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      }
      const flags = { caster: given.caster, cicero: ciceroFlags.resolve(given.cicero as never), beltype: cliFlags.resolve(given.beltype as never) };
      const author = Buffer.from(files.get('index.html')!).toString('utf8');
      const served = servedHtml(author);
      const keep = keptRoad(author);
      trace.road = keep ? 'kept' : 'fresh';
      const lapped = lapper(trace.ms);
      lapped.start('page');
      const page = current = keep ? (kept ?? await openKept()) : await context!.newPage();
      active = mine;
      try {
        if (keep) {
          seated = null;
          await page.unrouteAll({ behavior: 'wait' });
        }
        await routeDocument(page, missing, { root, docPath: DOC_PATH, served });
        lapped.end('page');
        const reseat = keep ? served.replace(/(<script type="module" src="[^"?]+)"/g, `$1?kept=${++reseats}"`) : undefined;
        const printed = await printOnPage(page, mine, flags, { docPath: DOC_PATH, sharedWriter: true, progress: { step: lapped.start, lap: lapped.end }, ...(reseat !== undefined ? { reseat } : {}), ...(created !== undefined ? { created } : {}) });
        lapped.end('print');
        if (mine.size) throw refusal(mine, null);
        if (!keep) { lapped.start('close'); await closePage(page); lapped.end('close'); }
        return printed;
      } catch (error) {
        await closePage(page);
        throw error;
      }
    } finally {
      if (active === mine) active = null;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  /** One customer of `template` on the kept page: the changed boxes replaced where the template is seated, else the template seated and merged. */
  const renderMerge = async (template: Template, data: MergeData, created: string | undefined, trace: Trace): Promise<Printed> => {
    const flags = { caster: template.given.caster, cicero: ciceroFlags.resolve(template.given.cicero as never), beltype: cliFlags.resolve(template.given.beltype as never) };
    const mine = new Set<string>();
    const lapped = lapper(trace.ms);
    lapped.start('page');
    const page = current = kept ?? await openKept();
    active = mine;
    lapped.end('page');
    const merged = <T extends object>(answer: T | Refusal): T => {
      if ('refused' in answer) throw refusal(mine, answer);
      return answer;
    };
    try {
      let resumeAt: unknown = null;
      lapped.start('merge');
      if (seated === template.id) {
        const answer = merged(await page.evaluate(keepMergeInPage, data));
        if ('again' in answer) {
          log(`beltype serve: the template is seated again: ${answer.again}`);
          seated = null;
        } else {
          resumeAt = answer.resumeAt;
          trace.road = 'merge kept';
        }
      }
      if (seated !== template.id) {
        lapped.start('load');
        await page.unrouteAll({ behavior: 'wait' });
        const served = servedHtml(template.author);
        await routeDocument(page, missing, { root: template.root, docPath: DOC_PATH, served });
        await page.evaluate(reseatInPage, served.replace(/(<script type="module" src="[^"?]+)"/g, `$1?kept=${++reseats}"`));
        lapped.end('load');
        lapped.start('merge');
        merged(await page.evaluate(seatMergeInPage, { template: template.author, data }));
        seated = template.id;
        trace.road = 'merge seated';
      }
      lapped.end('merge');
      const printed = await cutAndPrint(page, mine, flags, { sharedWriter: true, resumeAt, progress: { step: lapped.start, lap: lapped.end }, ...(created !== undefined ? { created } : {}) });
      lapped.end('print');
      if (mine.size) throw refusal(mine, null);
      return printed;
    } catch (error) {
      await closePage(page);
      throw error;
    } finally {
      if (active === mine) active = null;
    }
  };

  const start = async () => {
    browser = await chromium.launch({ headless: true, args: ARGS, chromiumSandbox: options.sandbox ?? true });
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
    await openKept();
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

  /** A request's form: the document's files, the flags, and the instant the file says it was made. */
  const readDocument = async (req: http.IncomingMessage): Promise<{ files: Map<string, Uint8Array>; args: string[]; given: Given; created: string | undefined; writer: string }> => {
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
    return { files, args, given, created, writer: String(given.caster['writer'] ?? 'pdf-lib') };
  };

  /** A print's turn: logged, held to the timeout, and counted towards a restart. */
  const inTurn = (writer: string, run: (trace: Trace) => Promise<Printed>): Promise<{ bytes: Buffer; printed: Printed; writer: string }> => enqueue(async () => {
      const id = prints + 1;
      log(`beltype serve: print ${id} started`);
      const t0 = performance.now();
      const trace: Trace = { road: 'fresh', ms: {} };
      const running = run(trace);
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(504, `beltype serve: the print took over ${options.timeout / 1000} s.`)), options.timeout); });
      try {
        const printed = await Promise.race([running, limit]);
        prints++;
        sinceStart++;
        log(`beltype serve: print ${id}: 200, ${printed.pages} pages, ${writer}, ${Math.round(performance.now() - t0)} ms (write ${printed.caster?.ms['emit'] ?? '?'} ms)`);
        log(`beltype serve: print ${id}: ${stepsLine(trace, printed)}`);
        return { bytes: printed.bytes, printed, writer };
      } catch (error) {
        prints++;
        sinceStart++;
        running.catch(() => {});
        if (error instanceof HttpError) {
          // The page the print still runs on is closed, so it asks for nothing more, and the print is let end, so its folder goes before the answer.
          if (current) await closePage(current);
          if (kept) await closePage(kept);
          await running.catch(() => {});
        }
        if (!(error instanceof BuildError) && !(error instanceof HttpError)) needsRestart = true;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });

  const print = async (req: http.IncomingMessage) => {
    const { files, given, created, writer } = await readDocument(req);
    return inTurn(writer, (trace) => render(files, given, created, trace));
  };

  /** A template's folder, kept on disk under the hash of what it holds, so uploading it again is the same template. */
  const uploadTemplate = async (req: http.IncomingMessage): Promise<string> => {
    const { files, args, given } = await readDocument(req);
    const author = Buffer.from(files.get('index.html')!).toString('utf8');
    if (!keptRoad(author)) throw new ValidationError('beltype serve: a template holds no script of its own, nor an <iframe>, <object>, <embed>, <frame>, <portal>, javascript: or on…= attribute: the merge runs in one kept page, which they would outlive.');
    if (author.search(DATA_BLOCK) < 0) throw new ValidationError('beltype serve: a template has a data block, a <script type="application/ld+json">; this one has none.');
    const hash = crypto.createHash('sha256');
    for (const name of [...files.keys()].sort()) hash.update(name).update('\0').update(files.get(name)!).update('\0');
    const id = hash.update(args.sort().join('\0')).digest('hex').slice(0, 32);
    if (templates.has(id)) return id;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-template-'));
    for (const [name, bytes] of files) {
      const file = path.join(root, ...name.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    templates.set(id, { id, root, author, given });
    for (const old of templates.values()) {
      if (templates.size <= TEMPLATES_KEPT) break;
      if (old.id === seated) continue;
      templates.delete(old.id);
      fs.rmSync(old.root, { recursive: true, force: true });
    }
    return id;
  };

  /** One customer of a template: the body is JSON, `{ values, rows, created }`. */
  const printMerge = async (id: string, req: http.IncomingMessage) => {
    const template = templates.get(id);
    if (!template) throw new HttpError(404, `beltype serve: no template ${id}; POST its folder to /templates (the oldest are dropped past ${TEMPLATES_KEPT}, and a restart of the server forgets them all).`);
    const { data, created } = mergeBody(await readBody(req, options.maxUpload));
    return inTurn(String(template.given.caster['writer'] ?? 'pdf-lib'), (trace) => renderMerge(template, data, created ?? createdFromEnv(), trace));
  };

  /** The `Host` a request must name; set once the server listens. */
  let authority = '';
  /**
   * Whether a request does not name this server, or comes from a page of another origin: a page in the user's browser can POST a form here with no preflight, and a rebound name reaches it under its own `Host`.
   *
   * @remarks
   * Under a wildcard bind (`0.0.0.0`, `::`) the server cannot know which name it is reached by, so only the `Origin` is held, against the `Host` the request names.
   */
  const foreign = (req: http.IncomingMessage) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!WILDCARD.has(options.host) && host !== authority) return true;
    const origin = req.headers.origin;
    return origin !== undefined && origin !== '' && origin.toLowerCase() !== `http://${host}`;
  };

  const server = http.createServer(async (req, res) => {
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string | number> = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    const text = (status: number, message: string) => send(status, 'text/plain; charset=utf-8', message + '\n');
    try {
      if (foreign(req)) throw new HttpError(403, `beltype serve: refused a request for ${req.headers.host ?? 'no host'} from ${req.headers.origin ?? 'no origin'}; it answers ${authority} and no page of another origin.`);
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      if (pathname === '/health') {
        if (req.method !== 'GET') return text(405, 'beltype serve: /health takes GET.');
        return send(restarting ? 503 : 200, 'application/json', JSON.stringify({ status: restarting ? 'restarting' : 'up', chromium: version, prints, queued }));
      }
      if (pathname === '/templates') {
        if (req.method !== 'POST') return text(405, 'beltype serve: /templates takes POST.');
        return send(201, 'application/json', JSON.stringify({ template: await uploadTemplate(req) }));
      }
      const merge = /^\/templates\/([0-9a-f]+)\/print$/.exec(pathname);
      if (pathname !== '/print' && !merge) return text(404, `beltype serve: no ${pathname}; there is POST /print, POST /templates, POST /templates/<id>/print and GET /health.`);
      if (req.method !== 'POST') return text(405, `beltype serve: ${pathname} takes POST.`);
      const { bytes, printed, writer } = await (merge ? printMerge(merge[1]!, req) : print(req));
      for (const warning of printed.warnings) log(`beltype serve: warning: ${typeof warning === 'string' ? warning : JSON.stringify(warning)}`);
      for (const deferral of printed.deferred) log(`beltype serve: ${deferralLine(deferral)}`);
      send(200, 'application/pdf', bytes, { 'x-beltype-pages': printed.pages, 'x-beltype-words': printed.words, 'x-beltype-warnings': printed.warnings.length, 'x-beltype-deferred': printed.deferred.length, ...standardHeader(printed.conformance) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof HttpError ? error.status : error instanceof BuildError ? 422 : error instanceof ValidationError || error instanceof FlagError ? 400 : 500;
      log(`beltype serve: ${req.method} ${req.url}: ${status}`);
      if (status === 413 || status === 403) {
        // Keep nothing more: answer, discard what still arrives (a client cut off mid-write sees EPIPE, not the answer), and drop the connection after a second if the client is still sending.
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(message + '\n', () => {
          req.resume();
          setTimeout(() => req.destroy(), 1000).unref();
        });
      } else if (!res.headersSent) text(status, message);
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve); });
  const address = server.address() as { port: number };
  authority = `${options.host.includes(':') ? `[${options.host}]` : options.host}:${address.port}`.toLowerCase();
  const url = `http://${authority}`;
  log(`beltype serve: listening on ${url}`);
  return {
    url,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await tail;
      await stopBrowser();
      for (const { root } of templates.values()) fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

/** The request's body, read up to `limit` bytes. @throws {HttpError} 413 as soon as the count passes the limit. */
async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer<ArrayBuffer>> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, `beltype serve: the upload is ${declared} bytes, over the limit of ${limit}.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `beltype serve: the upload is over the limit of ${limit} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** One customer's JSON: `values` a flat object of strings, numbers and booleans, `rows` a table of arrays of flat objects, `created` an instant. @throws {ValidationError} */
function mergeBody(body: Buffer): { data: MergeData; created: string | undefined } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new ValidationError('beltype serve: the customer is JSON: { "values": { … }, "rows": { "<table>": [ { … } ] } }; the body does not parse.');
  }
  const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (!isObject(parsed)) throw new ValidationError('beltype serve: the customer is a JSON object with "values" and "rows".');
  const { values = {}, rows = {}, created } = parsed;
  if (!isObject(values) || Object.values(values).some((v) => !['string', 'number', 'boolean'].includes(typeof v))) throw new ValidationError('beltype serve: "values" is an object of strings, numbers and booleans.');
  if (!isObject(rows) || Object.values(rows).some((table) => !Array.isArray(table) || table.some((row) => !isObject(row)))) throw new ValidationError('beltype serve: "rows" is an object of tables, each an array of objects.');
  if (created !== undefined && typeof created !== 'string') throw new ValidationError('beltype serve: "created" is an ISO 8601 instant.');
  return { data: { values, rows } as MergeData, created: created === undefined ? undefined : instant(created) };
}

/** The request's multipart form, read up to `limit` bytes. @throws {HttpError} 413 as soon as the count passes the limit; {ValidationError} where the body is not a form. */
async function readForm(req: http.IncomingMessage, limit: number): Promise<FormData> {
  const body = await readBody(req, limit);
  const type = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data/i.test(type)) throw new ValidationError('beltype serve: POST /print takes multipart/form-data.');
  try {
    return await new Response(body, { headers: { 'content-type': type } }).formData();
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

/** What the file claims, as Caster's report says it: `x-beltype-standard: pdf-2.0; pdf-ua-2`, or `pdf-2.0` alone where the claim was not asked for or was withdrawn. A print under `beltype.printer=chromium` is Chromium's own file, which Caster never saw, and carries no header. */
export const standardHeader = (conformance: Conformance | null): Record<string, string> =>
  conformance === null ? {} : { 'x-beltype-standard': conformance === 'pdfua2' ? 'pdf-2.0; pdf-ua-2' : 'pdf-2.0' };
