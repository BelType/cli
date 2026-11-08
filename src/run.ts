/**
 * The steps of a print as functions of a page, so `beltype print` and a server that keeps a browser alive print the same way.
 *
 * @remarks
 * **Every request is answered from disk, on one made-up origin.** {@link routeCompanions} answers on the browser context what no document owns: a WebSocket and another origin are refused and named, `/_beltype/` is answered from the companions' built files. {@link routeDocument} answers on a page the document at its own name and its folder at the root, and lets everything else fall back to the context's routes (Playwright runs a page's routes before its context's). {@link printOnPage} then loads, cuts, screenshots when asked and prints, and throws the refusals `print` has always thrown.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright-core';
import { ciceroEngine } from '@beltype/cicero/engine';
import { BuildError } from '@beltype/common/errors';
import { contentType } from '@beltype/common/mime';
import { cutInPage, printInPage, reseatInPage, pageSizesInPage, chromiumSheetInPage, type CasterTrace, type Conformance, type Deferral, type Measure, type Refusal } from './in-page.ts';
import { chromiumSheet } from './chromium.ts';
import { screenshotPages, type Confession, type Shot } from './check.ts';

/** `.invalid` is reserved (RFC 2606), so nothing on a network can ever answer it instead. */
export const ORIGIN = 'https://print.invalid';
export const VIEWPORT = { width: 1200, height: 1600 };
/** Deterministic text and timers that run while nobody watches the page. */
export const ARGS = ['--font-render-hinting=none', '--force-device-scale-factor=1', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

/** Where a route writes what it could not answer: a print's own set, or a server's sink that hands it to the print running now. */
export type Missing = { add(entry: string): unknown };

/** Where each `/_beltype/` prefix is answered from: one file, or a folder. */
export type Assets = { files: Record<string, string>; dirs: Record<string, string> };

/** The values a print runs under: Caster's given values (its defaults are resolved in the page), and Cicero's and the command line's resolved ones. */
export type RunFlags = { caster: Record<string, unknown>; cicero: Record<string, unknown>; beltype: { printer: string; check: boolean | string } };

/** What {@link printOnPage} asks beyond the flags. `reseat` is the served document to write into the page's existing document in place of a navigation, for a page kept between prints. `progress` is told each step as it starts and each lap as it ends, for a trace. */
export type RunOptions = { created?: string; reseat?: string; sharedWriter?: boolean; measures?: boolean; resumeAt?: unknown; progress?: { step(name: string): void; lap(key: string): void; cicero?(measures: Measure[]): void } };

export type Printed = { bytes: Buffer; pages: number; words: number; warnings: unknown[]; deferred: Deferral[]; conformance: Conformance | null; caster: CasterTrace | null; cicero: Measure[]; screens: Shot[]; confessions: Confession[]; printMs?: number };

/** The companions' built folders and files, each folder found from a module it exports: common exports no `package.json`. */
export function documentAssets(): Assets {
  const distOf = (specifier: string, up: number) => path.resolve(path.dirname(fileURLToPath(import.meta.resolve(specifier))), ...Array<string>(up).fill('..'));
  const cicero = ciceroEngine.vendorAssets();
  // Run from src/ or from dist/src/: the package root is the first folder up that holds `assets`.
  const merge = [1, 2].map((up) => fileURLToPath(new URL(`${'../'.repeat(up)}assets/merge`, import.meta.url))).find((dir) => fs.existsSync(dir))!;
  return { files: cicero.files, dirs: { ...cicero.dirs, caster: distOf('@beltype/caster', 1), common: distOf('@beltype/common/errors', 0), merge } };
}

/** The document as the page is served it: Caster's import map and Cicero's head ahead of the author's own. */
export function servedHtml(html: string): string {
  // Caster's modules import common by its package names, which a page resolves only through an import map.
  const imports = Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/_beltype/common/${m}.js`]));
  return spliceHead(html, `<script type="importmap">${JSON.stringify({ imports })}</script>\n  ${ciceroEngine.headHtml('/')}`);
}

/** One deferral as a line of its own after the run, so a print that approximated or dropped something says so (codeberg.org/BelType/cli issue 1). */
export const deferralLine = (d: Deferral): string => `deferred: ${d.path}: ${d.feature}, painted as ${d.paintedAs}`;

/** `fragment` at the top of the document's `<head>`, ahead of the author's own sheets and scripts. */
export function spliceHead(html: string, fragment: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + `\n  ${fragment}` + html.slice(head.index + head[0].length);
  const before = /^\s*(<!doctype[^>]*>\s*)?(<html\b[^>]*>)?/i.exec(html)?.[0] ?? '';
  return `${before}<head>\n  ${fragment}\n</head>${html.slice(before.length)}`;
}

// ponytail: routes only. A dedicated or shared worker's WebSocket and fetches pass no route, so a document that opens one is not refused; the monorepo's `cast` closes that with a proxy the run owns (packages/cli/src/cast.js), to be brought over when a document needs it.
/** What no document owns, on the context: refuse a WebSocket or another origin by name, and answer `/_beltype/` from the companions. */
export async function routeCompanions(context: BrowserContext, missing: Missing, assets: Assets = documentAssets()): Promise<void> {
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
    const pathname = decoded(url, missing);
    if (pathname === null) return route.fulfill({ status: 400, body: '' });
    const file = pathname.startsWith('/_beltype/') ? fromAssets(assets, pathname.slice('/_beltype/'.length)) : null;
    if (file) return route.fulfill({ status: 200, path: file, contentType: contentType(file) });
    missing.add(`${pathname} (${pathname.startsWith('/_beltype/') ? 'no companion holds it' : 'no document answered it'})`);
    return route.fulfill({ status: 404, body: '' });
  });
}

/** The document's own files on a page: the document at `docPath`, its folder `root` at the root. Another origin and `/_beltype/` fall back to the context's routes. */
export async function routeDocument(page: Page, missing: Missing, o: { root: string; docPath: string; served: string }): Promise<void> {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.fallback();
    const pathname = decoded(url, missing);
    if (pathname === null) return route.fulfill({ status: 400, body: '' });
    if (pathname.startsWith('/_beltype/')) return route.fallback();
    if (url.pathname === o.docPath) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: o.served });
    const file = within(o.root, `.${pathname}`);
    if (file) return route.fulfill({ status: 200, path: file, contentType: contentType(file) });
    if (pathname !== '/favicon.ico') missing.add(`${pathname} (not in ${o.root})`);
    return route.fulfill({ status: 404, body: '' });
  });
}

/**
 * Load the document on `page`, cut it, screenshot its pages when `--check` asks, and print it under the flags' printer.
 *
 * @remarks
 * What the run could not answer after the print (`missing`) is the caller's to test with {@link refusal}: `print` tests it after closing the browser, as it always has.
 * @throws {BuildError} where the cut or the print refused, or the document asked for what the run could not give it.
 */
export async function printOnPage(page: Page, missing: Set<string>, flags: RunFlags, o: { docPath: string } & RunOptions): Promise<Printed> {
  const { progress } = o;
  progress?.step('load');
  if (o.reseat !== undefined) await page.evaluate(reseatInPage, o.reseat);
  else {
    page.on('pageerror', (error) => console.warn(`page error: ${error.message}`));
    await page.goto(ORIGIN + o.docPath, { waitUntil: 'load' });
  }
  progress?.lap('load');
  return cutAndPrint(page, missing, flags, o);
}

/**
 * The second half of {@link printOnPage}, on a document already in the page: a host that writes the document itself, as a mail merge does, comes in here.
 *
 * @throws {BuildError} where the cut or the print refused.
 */
export async function cutAndPrint(page: Page, missing: Set<string>, flags: RunFlags, o: RunOptions): Promise<Printed> {
  const { progress } = o;
  progress?.step('cut');
  const cut = await page.evaluate(cutInPage, { cicero: flags.cicero, measures: o.measures === true, ...(o.resumeAt ? { resumeAt: o.resumeAt } : {}) });
  progress?.lap('cut');
  const measures = 'refused' in cut ? [] : cut.measures;
  progress?.cicero?.(measures);
  if ('refused' in cut || missing.size) throw refusal(missing, 'refused' in cut ? cut : null);
  let screens: Shot[] = [];
  if (flags.beltype.check) {
    progress?.step('check');
    screens = await screenshotPages(page);
    progress?.lap('check');
  }
  progress?.step('print');
  if (flags.beltype.printer === 'chromium') {
    const sheet = chromiumSheet(await page.evaluate(pageSizesInPage));
    await page.evaluate(chromiumSheetInPage, sheet);
    const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    return { bytes, pages: await page.locator('beltype-page').count(), words: 0, warnings: [], deferred: [], conformance: null, caster: null, cicero: measures, screens, confessions: [] };
  }
  const printed = await page.evaluate(printInPage, { options: flags.caster, ...(o.created !== undefined ? { created: o.created } : {}), ...(o.sharedWriter ? { sharedWriter: true } : {}) });
  if ('refused' in printed) throw refusal(missing, printed);
  return { bytes: Buffer.from(printed.base64, 'base64'), pages: printed.pages, words: printed.words, warnings: printed.warnings, deferred: printed.deferred, conformance: printed.conformance, caster: printed.caster, cicero: measures, screens, confessions: printed.confessions, printMs: printed.printMs };
}

/** The run's refusal: what it could not answer comes first, because a missing file's name says more than the step it broke. */
export function refusal(missing: Set<string>, answer: Refusal | null): BuildError {
  if (missing.size) return new BuildError(`beltype print: the document asked for what the run cannot give it, so the print would not be the document:\n${[...missing].map((m) => `  ${m}`).join('\n')}`);
  return new BuildError(`beltype print: the ${answer?.at ?? 'run'} step refused:\n${answer?.refused || '(the refusal carried no message)'}`);
}

/** The percent-decoded path of `url`, or null (and the name of what it asked) where the escape is malformed. */
function decoded(url: URL, missing: Missing): string | null {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    missing.add(`${url.pathname} (a malformed percent escape, which names no file)`);
    return null;
  }
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
