/**
 * `beltype print`: a finished HTML document to a PDF, through Cicero and Caster, in Chromium's headless shell.
 *
 * @remarks
 * **Two printers.** Cicero paginates, then Caster prints the pages Cicero presented (the default), or `--printer chromium` has Chromium's `page.pdf()` print them. Under Caster the bare headless shell is enough: where Cicero cuts is layout, the same Blink in the shell as in the full binary.
 *
 * **Every request is answered from disk, on one made-up origin.** The browser context's `route` answers the document at its own name, the document's folder at the root, and `/_beltype/` from the companions' built files. A request for anything else is refused and named, and a run that refused anything writes no file, because the print would not be the document.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright-core';
import { ciceroEngine } from '@beltype/cicero';
import { BuildError } from '@beltype/common/errors';
import { contentType } from '@beltype/common/mime';
import { cutInPage, printInPage, pageSizesInPage, chromiumSheetInPage, type CasterTrace, type Measure, type Refusal } from './in-page.ts';
import { casterFlags, ciceroFlags, cliFlags, type Given } from './flags.ts';
import { chromiumSheet } from './chromium.ts';
import { screenshotPages, checkPages, type CheckResult } from './check.ts';

/** `.invalid` is reserved (RFC 2606), so nothing on a network can ever answer it instead. */
const ORIGIN = 'https://print.invalid';
const VIEWPORT = { width: 1200, height: 1600 };
/** Deterministic text and timers that run while nobody watches the page. */
const ARGS = ['--font-render-hinting=none', '--force-device-scale-factor=1', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

/** Where each `/_beltype/` prefix is answered from: one file, or a folder. */
type Assets = { files: Record<string, string>; dirs: Record<string, string> };

export type PrintResult = { output: string; pages: number; words: number; ms: number; check?: CheckResult };

/** What a run asks for beyond the document: the values given per owner (anything not given is its default), and where to write the trace. */
export type PrintOptions = { given?: Partial<Given>; trace?: string };

/** Where a run's time went, in three layers, with the versions and flags it used. */
export type Trace = {
  process: Record<string, number>;
  cicero: Measure[];
  caster: CasterTrace | null;
  versions: Record<string, string>;
  flags: Record<string, Record<string, unknown>>;
  /** Set when the run refused: the step it refused at, and why. */
  refused?: { step: string; message: string };
};

const round = (ms: number) => Math.round(ms * 10) / 10;

/**
 * Print `input`, an HTML file, to `output`.
 *
 * @throws {BuildError} naming what the document asked for and could not be given, or the step that refused.
 */
export async function print(input: string, output: string, options: PrintOptions = {}): Promise<PrintResult> {
  const started = performance.now();
  const flags = {
    // The command line cuts the variable faces' instances in workers unless told otherwise: its pages can start them, and Caster's own default (`main`) is for hosts that cannot.
    caster: casterFlags.resolve({ instancing: 'workers', ...options.given?.caster } as never),
    cicero: ciceroFlags.resolve(options.given?.cicero as never),
    beltype: cliFlags.resolve(options.given?.beltype as never)
  };
  const trace: Trace = { process: {}, cicero: [], caster: null, versions: {}, flags };
  let mark = started;
  const lap = (key: string) => {
    const now = performance.now();
    trace.process[key] = round(now - mark);
    mark = now;
  };
  let step = 'launch';
  let chromiumVersion = 'unknown';
  try {
    const html = fs.readFileSync(input, 'utf8');
    const root = path.dirname(path.resolve(input));
    const docPath = `/${encodeURIComponent(path.basename(input))}`;
    // Each companion's built folder, found from a module it exports: common exports no `package.json`.
    const distOf = (specifier: string, up: number) => path.resolve(path.dirname(fileURLToPath(import.meta.resolve(specifier))), ...Array<string>(up).fill('..'));
    const cicero = ciceroEngine.vendorAssets();
    const assets: Assets = {
      files: cicero.files,
      dirs: { ...cicero.dirs, caster: distOf('@beltype/caster', 1), common: distOf('@beltype/common/errors', 0) },
    };
    // Caster's modules import common by its package names, which a page resolves only through an import map.
    const imports = Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/_beltype/common/${m}.js`]));
    const served = spliceHead(html, `<script type="importmap">${JSON.stringify({ imports })}</script>\n  ${ciceroEngine.headHtml('/')}`);

    const missing = new Set<string>();
    const browser = await chromium.launch({ headless: true, args: ARGS });
    chromiumVersion = browser.version();
    lap('launch');
    try {
      step = 'context';
      const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
      await answerFromDisk(context, missing, { root, docPath, served, assets });
      const page = await context.newPage();
      page.on('pageerror', (error) => console.warn(`page error: ${error.message}`));
      lap('context');
      step = 'load';
      await page.goto(ORIGIN + docPath, { waitUntil: 'load' });
      lap('load');
      step = 'cut';
      const cut = await page.evaluate(cutInPage, { cicero: flags.cicero, measures: options.trace !== undefined });
      lap('cut');
      if (!('refused' in cut)) trace.cicero = cut.measures;
      if ('refused' in cut || missing.size) throw refusal(missing, 'refused' in cut ? cut : null);
      let screens: Uint8Array[] = [];
      if (flags.beltype.check) {
        step = 'check';
        screens = await screenshotPages(page);
        lap('check');
      }
      step = 'print';
      let bytes: Buffer;
      let pages: number;
      let words: number;
      if (flags.beltype.printer === 'chromium') {
        const sheet = chromiumSheet(await page.evaluate(pageSizesInPage));
        await page.evaluate(chromiumSheetInPage, sheet);
        bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
        pages = await page.locator('beltype-page').count();
        words = 0;
        lap('print');
      } else {
        const printed = await page.evaluate(printInPage, flags.caster);
        if ('refused' in printed) throw refusal(missing, printed);
        trace.process['print'] = round(printed.printMs);
        trace.process['transfer'] = round(performance.now() - mark - printed.printMs);
        mark = performance.now();
        trace.caster = printed.caster;
        for (const warning of printed.warnings) console.warn(typeof warning === 'string' ? warning : JSON.stringify(warning));
        bytes = Buffer.from(printed.base64, 'base64');
        pages = printed.pages;
        words = printed.words;
      }
      step = 'close';
      await browser.close();
      lap('close');
      if (missing.size) throw refusal(missing, null);
      step = 'write';
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(output, bytes);
      lap('write');
      let check: CheckResult | undefined;
      if (flags.beltype.check) {
        step = 'check';
        check = await checkPages(screens, bytes, path.resolve(output).replace(/\.pdf$/i, '') + '.check', flags.beltype.printer);
        lap('check');
      }
      return { output, pages, words, ms: performance.now() - started, ...(check ? { check } : {}) };
    } finally {
      await browser.close();
    }
  } catch (error) {
    trace.refused = { step, message: error instanceof Error ? error.message : String(error) };
    throw error;
  } finally {
    if (options.trace !== undefined) {
      trace.process['total'] = round(performance.now() - started);
      trace.versions = versions(chromiumVersion);
      fs.mkdirSync(path.dirname(path.resolve(options.trace)), { recursive: true });
      fs.writeFileSync(options.trace, JSON.stringify(trace, null, 2));
    }
  }
}

/** The version of each package the run used, read from the `package.json` above the module that `specifier` resolves to. */
function versions(chromiumVersion: string): Record<string, string> {
  const of = (url: string, name: string) => {
    let dir = path.dirname(fileURLToPath(url));
    for (;;) {
      const file = path.join(dir, 'package.json');
      if (fs.existsSync(file)) {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === name) return pkg.version ?? 'unknown';
      }
      const up = path.dirname(dir);
      if (up === dir) return 'unknown';
      dir = up;
    }
  };
  return {
    '@beltype/cli': of(import.meta.url, '@beltype/cli'),
    '@beltype/cicero': of(import.meta.resolve('@beltype/cicero'), '@beltype/cicero'),
    '@beltype/caster': of(import.meta.resolve('@beltype/caster'), '@beltype/caster'),
    '@beltype/common': of(import.meta.resolve('@beltype/common/errors'), '@beltype/common'),
    'playwright-core': of(import.meta.resolve('playwright-core'), 'playwright-core'),
    chromium: chromiumVersion
  };
}

/** The run's refusal: what it could not answer comes first, because a missing file's name says more than the step it broke. */
function refusal(missing: Set<string>, answer: Refusal | null): BuildError {
  if (missing.size) return new BuildError(`beltype print: the document asked for what the run cannot give it, so the print would not be the document:\n${[...missing].map((m) => `  ${m}`).join('\n')}`);
  return new BuildError(`beltype print: the ${answer?.at ?? 'run'} step refused:\n${answer?.refused || '(the refusal carried no message)'}`);
}

/** `fragment` at the top of the document's `<head>`, ahead of the author's own sheets and scripts. */
export function spliceHead(html: string, fragment: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + `\n  ${fragment}` + html.slice(head.index + head[0].length);
  const before = /^\s*(<!doctype[^>]*>\s*)?(<html\b[^>]*>)?/i.exec(html)?.[0] ?? '';
  return `${before}<head>\n  ${fragment}\n</head>${html.slice(before.length)}`;
}

// ponytail: routes only. A dedicated or shared worker's WebSocket and fetches pass no route, so a document that opens one is not refused; the monorepo's `cast` closes that with a proxy the run owns (packages/cli/src/cast.js), to be brought over when a document needs it.
async function answerFromDisk(context: BrowserContext, missing: Set<string>, o: { root: string; docPath: string; served: string; assets: Assets }): Promise<void> {
  await context.routeWebSocket(/.*/, (ws) => {
    missing.add(`${ws.url()} (a WebSocket; print opens none)`);
    return ws.close({ code: 1008, reason: 'beltype print reaches no network' });
  });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      missing.add(`${url.href} (another origin; print fetches nothing from a network)`);
      return route.abort('blockedbyclient');
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      missing.add(`${url.pathname} (a malformed percent escape, which names no file)`);
      return route.fulfill({ status: 400, body: '' });
    }
    if (url.pathname === o.docPath) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: o.served });
    const file = pathname.startsWith('/_beltype/') ? fromAssets(o.assets, pathname.slice('/_beltype/'.length)) : within(o.root, `.${pathname}`);
    if (file) return route.fulfill({ status: 200, path: file, contentType: contentType(file) });
    if (pathname !== '/favicon.ico') missing.add(pathname.startsWith('/_beltype/') ? `${pathname} (no companion holds it)` : `${pathname} (not in ${o.root})`);
    return route.fulfill({ status: 404, body: '' });
  });
}

function fromAssets(assets: Assets, assetPath: string): string | null {
  const file = assets.files[assetPath];
  if (file) return isFile(file) ? file : null;
  for (const [prefix, dir] of Object.entries(assets.dirs)) {
    if (assetPath.startsWith(prefix + '/')) return within(dir, assetPath.slice(prefix.length + 1));
  }
  return null;
}

/** `rel` under `dir`, if it is a file there and does not climb out. */
function within(dir: string, rel: string): string | null {
  const file = path.resolve(dir, rel);
  const inside = path.relative(dir, file);
  return !inside.startsWith('..') && !path.isAbsolute(inside) && isFile(file) ? file : null;
}

const isFile = (file: string) => fs.existsSync(file) && fs.statSync(file).isFile();
