/**
 * `beltype print`: a finished HTML document to a PDF, through Cicero and Caster, in Chromium's headless shell.
 *
 * @remarks
 * **One road.** Cicero paginates and Caster prints the pages Cicero presented. Chromium's own print (`page.pdf()`) is never called, which is why the bare headless shell is enough: where Cicero cuts is layout, the same Blink in the shell as in the full binary.
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
import { cutInPage, printInPage, type Refusal } from './in-page.ts';

/** `.invalid` is reserved (RFC 2606), so nothing on a network can ever answer it instead. */
const ORIGIN = 'https://print.invalid';
const VIEWPORT = { width: 1200, height: 1600 };
/** Deterministic text and timers that run while nobody watches the page. */
const ARGS = ['--font-render-hinting=none', '--force-device-scale-factor=1', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

/** Where each `/_beltype/` prefix is answered from: one file, or a folder. */
type Assets = { files: Record<string, string>; dirs: Record<string, string> };

export type PrintResult = { output: string; pages: number; words: number; ms: number };

/**
 * Print `input`, an HTML file, to `output`.
 *
 * @throws {BuildError} naming what the document asked for and could not be given, or the step that refused.
 */
export async function print(input: string, output: string): Promise<PrintResult> {
  const started = performance.now();
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
  const imports = Object.fromEntries(['errors', 'data-beltype', 'mime'].map((m) => [`@beltype/common/${m}`, `/_beltype/common/${m}.js`]));
  const served = spliceHead(html, `<script type="importmap">${JSON.stringify({ imports })}</script>\n  ${ciceroEngine.headHtml('/')}`);

  const missing = new Set<string>();
  const browser = await chromium.launch({ headless: true, args: ARGS });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
    await answerFromDisk(context, missing, { root, docPath, served, assets });
    const page = await context.newPage();
    page.on('pageerror', (error) => console.warn(`page error: ${error.message}`));
    await page.goto(ORIGIN + docPath, { waitUntil: 'load' });
    const cut = await page.evaluate(cutInPage);
    if ('refused' in cut || missing.size) throw refusal(missing, 'refused' in cut ? cut : null);
    const printed = await page.evaluate(printInPage);
    if ('refused' in printed) throw refusal(missing, printed);
    await browser.close();
    if (missing.size) throw refusal(missing, null);
    for (const warning of printed.warnings) console.warn(typeof warning === 'string' ? warning : JSON.stringify(warning));
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, Buffer.from(printed.base64, 'base64'));
    return { output, pages: printed.pages, words: printed.words, ms: performance.now() - started };
  } finally {
    await browser.close();
  }
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
