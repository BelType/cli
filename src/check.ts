/**
 * `--check`: the PDF compared with the pages Cicero presented in the same run.
 *
 * @remarks
 * Each page Cicero presented is screenshotted at device scale 1 (96 dpi), the PDF is rasterised at 96 dpi with mupdf, and the pairs are diffed (`compare.ts`). Output goes beside the PDF, in `<name>.check/`: `screen-N.png`, `print-N.png`, `diff-N.png` and `check.json`. It is the proof that the printer drew what the engine cut, not a proof against an outside oracle: the acceptance suite of the cast road is that. Under `--check` a page whose share crosses {@link MAX_SHARE}, a page whose worst tile crosses its kind's floor in {@link TILE_FLOORS}, or a page count that differs between screen and print, fails the run ({@link gate}); `--check=report` writes the same report and never fails. `mupdf` is imported here, dynamically, so a plain print never loads it, and it is an optional peer, so a plain install never has it: it is AGPL-3.0, and this package is MIT.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';
import { BuildError } from '@beltype/common/errors';
import type { Page } from 'playwright-core';
import type { Raster } from './compare.ts';

/**
 * The share of a page's pixels that may differ before the page fails the check: 3.5 %.
 *
 * @remarks
 * Measured 2026-11-08 on Caster's corpus (`fixtures/lists/`, sixteen documents and 37 pages; `convert-images` and `convert-text` refuse at this CLI's Caster pin), with a bled page aligned on its trim: median 0.73 %, 95th percentile 2.26 %. Text pages sit at 0.3 to 1.8 %, the highest cast-divided-row's page 4 at 1.76 %: Skia and mupdf shade glyph edges past the one pixel of slip `compare.ts` allows. The highest page short of a real disagreement is vector-roads' page 2 at 2.88 %, its box opacity and blend over a backdrop drawn in other colours. The threshold is about twice the highest text page. What it catches: the paper's page 2 drawn blank reads 4.98 %, so a lost page or a page whose content moved crosses it; roads' page 2 reads 13.01 %, its blurred shadow drawn as a raster and its text under `blackText: 100k`. What it does not catch: the 120 by 30 CSS px red block in a table that Caster's acceptance suite fails (*on the cast road the oracle is the page Cicero presented*, Caster's DESIGN.md S91) reads 0.40 % of an A4 page, under the noise of a text page; the tile floors ({@link TILE_FLOORS}) hold it.
 */
export const MAX_SHARE = 0.035;

/** The side of a tile in pixels: the 24 px square Caster's acceptance suite reads (*on the cast road the oracle is the page Cicero presented*, Caster's DESIGN.md S91). */
export const TILE = 24;

/**
 * What a presented page holds, as far as the tile gate cares: `picture` where anything on it is drawn rather than set (an image, a canvas, an SVG, a background image, a blend, a filter, a shadow, an opacity under 1), else `text`.
 *
 * @remarks
 * Caster's acceptance suite reads one tile floor for every page and masks the known defects instead, so it has no classification to reuse; this one is read off the presented page by {@link kindInPage}.
 */
export type PageKind = 'text' | 'picture';

/**
 * The share of one tile's pixels that may differ before its page fails, by what the page holds: 40 % for each kind.
 *
 * @remarks
 * Measured 2026-11-08 on the same 37 pages as {@link MAX_SHARE}, the worst tile of each. Text pages (18): median 7.1 %, highest 19.62 % (cast-divided-row's page 4, the glyph edges of a table's cells). Picture pages (19): median 12.5 %, highest clean 17.71 % (facsimile-pages' page 2, glyph edges again). Five picture pages read higher, and each is a real disagreement the gate is for, so none sets a floor: roads' page 1 at 43.6 % (its text under `blackText: 100k`, drawn in another black), images' page 1 at 58.3 % (a band of the CMYK JPEG), arithmetic's page 1 at 63.9 % (a JPEG the browser cannot decode and the file carries), roads' page 2 and vector-roads' page 2 at 100 % (a blurred shadow drawn as a raster; box opacity and a blend over a backdrop). The floor is about twice the clean maximum of either kind. S91's 120 by 30 px block fills a tile it lands squarely on, and wherever it falls its 30 rows cover at least 15 of some tile's 24, 62.5 %, half again the floor. The two kinds measured alike once the disagreements were set aside, so the floors are equal; they stay two so that a kind that measures noisier can move alone.
 */
export const TILE_FLOORS: Readonly<Record<PageKind, number>> = { text: 0.4, picture: 0.4 };

/** One presented page: its screenshot and what it holds. */
export type Shot = { png: Uint8Array; kind: PageKind };

/** One page of the report; `pass` is the share at or under {@link MAX_SHARE} and the worst tile at or under its kind's floor in {@link TILE_FLOORS}; `trimAt` is where the presented page was found in a print larger than it. */
export type CheckPage = { page: number; share: number; tile: { share: number; x: number; y: number }; kind: PageKind; pass: boolean; sameSize: boolean; screen: { width: number; height: number }; print: { width: number; height: number }; trimAt?: { x: number; y: number } };
/** The report; `threshold` is the pixel's channel tolerance (`compare.ts`), `maxShare` the page's. */
export type CheckResult = { dir: string; printer: string; threshold: number; maxShare: number; screenPages: number; printPages: number; unmatched: number; mean: number; pages: CheckPage[] };

/**
 * Refuse `--check` before the run spends anything, when mupdf is not installed.
 *
 * @throws {BuildError} naming the package, its licence and the command.
 */
export async function requireMupdf(load: () => Promise<unknown> = () => import('mupdf')): Promise<void> {
  try {
    await load();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new BuildError('beltype print: --check rasterises with mupdf, which is not installed. It is under the AGPL-3.0, so this package does not bring it: `npm install mupdf@1.28.1` where you run beltype, or print without --check.');
  }
}

/** Whether a presented page holds anything drawn rather than set; runs in the page, so it closes over nothing. Cicero assigns the document's own elements to the page's slots by hand, so a slot is followed to what it holds, and a shadow root into its tree. */
export function kindInPage(page: Element): PageKind {
  const drawn = new Set(['IMG', 'CANVAS', 'VIDEO', 'SVG', 'IFRAME', 'OBJECT', 'EMBED', 'PICTURE']);
  const stack: Element[] = [page];
  while (stack.length) {
    const el = stack.pop()!;
    if (el !== page) {
      if (drawn.has(el.tagName.toUpperCase())) return 'picture';
      const s = getComputedStyle(el);
      if (s.backgroundImage !== 'none' || s.mixBlendMode !== 'normal' || s.filter !== 'none' || s.boxShadow !== 'none' || Number(s.opacity) < 1) return 'picture';
    }
    stack.push(...el.children);
    if (el.shadowRoot) stack.push(...el.shadowRoot.children);
    if (el instanceof HTMLSlotElement) stack.push(...el.assignedElements());
  }
  return 'text';
}

/** Each `beltype-page` clipped to its page box, and what it holds. Playwright's locators pierce the root's open shadow tree. */
export async function screenshotPages(page: Page): Promise<Shot[]> {
  const pages = await page.locator('beltype-page').all();
  const shots: Shot[] = [];
  for (const p of pages) shots.push({ png: await p.screenshot({ type: 'png' }), kind: await p.evaluate(kindInPage) });
  return shots;
}

/** The PNG's pixels as RGB, three bytes a pixel. */
async function rasterOfPng(png: Uint8Array): Promise<Raster> {
  const mupdf = await import('mupdf');
  const pix = new mupdf.Image(png).toPixmap();
  const width = pix.getWidth();
  const height = pix.getHeight();
  const n = pix.getNumberOfComponents();
  const stride = pix.getStride();
  const src = pix.getPixels();
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) rgb[(y * width + x) * 3 + c] = src[y * stride + x * n + c]!;
  return { width, height, rgb };
}

/**
 * Rasterise `pdf`, diff it page by page against `shots`, and write the evidence into `dir`.
 *
 * @remarks
 * A printed page larger than its screenshot (a bleed and print marks grow Caster's media round the page) is cropped to the presented page before the diff: its bottom-left corner is the page's user-space origin (`rasterize`), so the window is the screenshot's size with its bottom edge there. `print-N.png` stays the whole printed page.
 */
export async function checkPages(shots: readonly Shot[], pdf: Uint8Array, dir: string, printer: string): Promise<CheckResult> {
  const { rasterize, diffPages, crop, THRESHOLD } = await import('./compare.ts');
  const printed = rasterize(pdf);
  const screen = await Promise.all(shots.map((s) => rasterOfPng(s.png)));
  const trims = printed.pages.map((p, i) => {
    const s = screen[i];
    // a page at a fractional height prints one pixel taller than its screenshot, which the slip covers; only a page grown past that is cropped
    if (!s || (p.width <= s.width + 1 && p.height <= s.height + 1)) return undefined;
    const o = printed.origins[i]!;
    return { x: Math.round(o.x), y: Math.round(o.y) - s.height };
  });
  const aligned = printed.pages.map((p, i) => (trims[i] ? crop(p, trims[i].x, trims[i].y, screen[i]!.width, screen[i]!.height) : p));
  const diff = diffPages(screen, aligned, TILE);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const pages: CheckPage[] = diff.pages.map((d, i) => {
    const n = i + 1;
    fs.writeFileSync(path.join(dir, `screen-${n}.png`), shots[i]!.png);
    fs.writeFileSync(path.join(dir, `print-${n}.png`), printed.pngs[i]!);
    fs.writeFileSync(path.join(dir, `diff-${n}.png`), d.image);
    const kind = shots[i]!.kind;
    const trimAt = trims[i];
    return { page: n, share: d.share, tile: d.tile, kind, pass: d.share <= MAX_SHARE && d.tile.share <= TILE_FLOORS[kind], sameSize: d.sameSize, screen: { width: screen[i]!.width, height: screen[i]!.height }, print: { width: printed.pages[i]!.width, height: printed.pages[i]!.height }, ...(trimAt ? { trimAt } : {}) };
  });
  const result: CheckResult = { dir, printer, threshold: THRESHOLD, maxShare: MAX_SHARE, screenPages: shots.length, printPages: printed.pages.length, unmatched: diff.unmatched, mean: diff.mean, pages };
  fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify(result, null, 2));
  return result;
}

/** One line a page, and the mean. */
export function checkLines(r: CheckResult): string[] {
  return [
    ...r.pages.map((p) => `check page ${p.page}: ${(p.share * 100).toFixed(2)}% differ, worst tile ${(p.tile.share * 100).toFixed(1)}% at (${p.tile.x}, ${p.tile.y}), a ${p.kind} page${p.sameSize ? '' : ` (sizes differ: screen ${p.screen.width}x${p.screen.height}, print ${p.print.width}x${p.print.height})`}`),
    `check mean: ${(r.mean * 100).toFixed(2)}% over ${r.pages.length} pages${r.unmatched ? `; ${r.unmatched} page(s) unmatched (screen ${r.screenPages}, print ${r.printPages})` : ''}; ${r.dir}`
  ];
}

/**
 * Fail the run on what the report found, under `--check`; under `--check=report`, nothing.
 *
 * @throws {BuildError} one line a failing page, naming its share where that is over {@link MAX_SHARE}, else its worst tile and the floor of its kind, and its diff picture; and one where the page counts differ.
 */
export function gate(r: CheckResult, mode: true | 'report'): void {
  if (mode === 'report') return;
  const lines = r.pages.filter((p) => !p.pass).map((p) => {
    const why = p.share > r.maxShare ? `${(p.share * 100).toFixed(2)}% differ, over ${(r.maxShare * 100).toFixed(1)}%${p.sameSize ? '' : ' (sizes differ)'}` : `tile at (${p.tile.x}, ${p.tile.y}) differs ${(p.tile.share * 100).toFixed(0)}%, over the ${(TILE_FLOORS[p.kind] * 100).toFixed(0)}% floor for a ${p.kind} page`;
    return `check page ${p.page} fails: ${why}; ${path.join(r.dir, `diff-${p.page}.png`)}`;
  });
  if (r.screenPages !== r.printPages) lines.push(`check fails: the screen has ${r.screenPages} pages and the print ${r.printPages}; ${r.dir}`);
  if (lines.length) throw new BuildError(lines.join('\n'));
}
