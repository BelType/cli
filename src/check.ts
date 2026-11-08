/**
 * `--check`: the PDF compared with the pages Cicero presented in the same run.
 *
 * @remarks
 * Each page Cicero presented is screenshotted at device scale 1 (96 dpi), the PDF is rasterised at 96 dpi with mupdf, and the pairs are diffed (`compare.ts`). Output goes beside the PDF, in `<name>.check/`: `screen-N.png`, `print-N.png`, `diff-N.png` and `check.json`. It is the proof that the printer drew what the engine cut, not a proof against an outside oracle: the acceptance suite of the cast road is that. Under `--check` a page whose share crosses {@link MAX_SHARE}, or a page count that differs between screen and print, fails the run ({@link gate}); `--check=report` writes the same report and never fails. `mupdf` is imported here, dynamically, so a plain print never loads it, and it is an optional peer, so a plain install never has it: it is AGPL-3.0, and this package is MIT.
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
 * Measured 2026-11-08 on Caster's corpus (`fixtures/lists/`, sixteen documents and 37 pages; `convert-images` and `convert-text` refuse at this CLI's Caster pin): median 0.73 %, 95th percentile 2.88 %. Text pages sit at 0.3 to 1.8 %, the highest cast-divided-row's page 4 at 1.76 %: Skia and mupdf shade glyph edges past the one pixel of slip `compare.ts` allows, and the screen's pages are 1122 px where the print's are 1123, so the last row reads red. The highest page whose two pictures share a size is vector-roads' page 2 at 2.88 %, its box opacity and blend over a backdrop drawn in other colours. The threshold is about twice the highest text page, above every page with matching geometry. What it catches: the paper's page 2 drawn blank reads 4.98 %, so a lost page or a page whose content moved crosses it. What it does not catch: the 120 by 30 CSS px red block in a table that Caster's acceptance suite fails (*on the cast road the oracle is the page Cicero presented*, Caster's DESIGN.md S91) reads 0.40 % of an A4 page, under the noise of a text page, so no whole-page threshold above the floor holds it. A bled page (roads, 454 px on screen and 537 in print) is compared over the common area from the corner, so it reads 18 to 26 % and fails.
 */
export const MAX_SHARE = 0.035;

/** One page of the report; `pass` is the share at or under {@link MAX_SHARE}. */
export type CheckPage = { page: number; share: number; pass: boolean; sameSize: boolean; screen: { width: number; height: number }; print: { width: number; height: number } };
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

/** Each `beltype-page` clipped to its page box. Playwright's locators pierce the root's open shadow tree. */
export async function screenshotPages(page: Page): Promise<Uint8Array[]> {
  const pages = await page.locator('beltype-page').all();
  const shots: Uint8Array[] = [];
  for (const p of pages) shots.push(await p.screenshot({ type: 'png' }));
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

/** Rasterise `pdf`, diff it page by page against `screens`, and write the evidence into `dir`. */
export async function checkPages(screens: readonly Uint8Array[], pdf: Uint8Array, dir: string, printer: string): Promise<CheckResult> {
  const { rasterize, diffPages, THRESHOLD } = await import('./compare.ts');
  const printed = rasterize(pdf);
  const screen = await Promise.all(screens.map(rasterOfPng));
  const diff = diffPages(screen, printed.pages);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const pages: CheckPage[] = diff.pages.map((d, i) => {
    const n = i + 1;
    fs.writeFileSync(path.join(dir, `screen-${n}.png`), screens[i]!);
    fs.writeFileSync(path.join(dir, `print-${n}.png`), printed.pngs[i]!);
    fs.writeFileSync(path.join(dir, `diff-${n}.png`), d.image);
    return { page: n, share: d.share, pass: d.share <= MAX_SHARE, sameSize: d.sameSize, screen: { width: screen[i]!.width, height: screen[i]!.height }, print: { width: printed.pages[i]!.width, height: printed.pages[i]!.height } };
  });
  const result: CheckResult = { dir, printer, threshold: THRESHOLD, maxShare: MAX_SHARE, screenPages: screens.length, printPages: printed.pages.length, unmatched: diff.unmatched, mean: diff.mean, pages };
  fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify(result, null, 2));
  return result;
}

/** One line a page, and the mean. */
export function checkLines(r: CheckResult): string[] {
  return [
    ...r.pages.map((p) => `check page ${p.page}: ${(p.share * 100).toFixed(2)}% differ${p.sameSize ? '' : ` (sizes differ: screen ${p.screen.width}x${p.screen.height}, print ${p.print.width}x${p.print.height})`}`),
    `check mean: ${(r.mean * 100).toFixed(2)}% over ${r.pages.length} pages${r.unmatched ? `; ${r.unmatched} page(s) unmatched (screen ${r.screenPages}, print ${r.printPages})` : ''}; ${r.dir}`
  ];
}

/**
 * Fail the run on what the report found, under `--check`; under `--check=report`, nothing.
 *
 * @throws {BuildError} one line a page over {@link MAX_SHARE}, naming its share and its diff picture, and one where the page counts differ.
 */
export function gate(r: CheckResult, mode: true | 'report'): void {
  if (mode === 'report') return;
  const lines = r.pages.filter((p) => !p.pass).map((p) => `check page ${p.page} fails: ${(p.share * 100).toFixed(2)}% differ, over ${(r.maxShare * 100).toFixed(1)}%${p.sameSize ? '' : ' (sizes differ)'}; ${path.join(r.dir, `diff-${p.page}.png`)}`);
  if (r.screenPages !== r.printPages) lines.push(`check fails: the screen has ${r.screenPages} pages and the print ${r.printPages}; ${r.dir}`);
  if (lines.length) throw new BuildError(lines.join('\n'));
}
