/**
 * `--check`: the proof that the PDF is the screen.
 *
 * @remarks
 * Each page Cicero presented is screenshotted at device scale 1 (96 dpi), the PDF is rasterised at 96 dpi with mupdf, and the pairs are diffed (`compare.ts`). Output goes beside the PDF, in `<name>.check/`: `screen-N.png`, `print-N.png`, `diff-N.png` and `check.json`. It reports and never fails; a threshold waits until the first runs show where the noise floor is. `mupdf` is imported here, dynamically, so a plain print never loads it, and it is an optional peer, so a plain install never has it: it is AGPL-3.0, and this package is MIT.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';
import { BuildError } from '@beltype/common/errors';
import type { Page } from 'playwright-core';
import type { Raster } from './compare.ts';

export type CheckPage = { page: number; share: number; sameSize: boolean; screen: { width: number; height: number }; print: { width: number; height: number } };
export type CheckResult = { dir: string; printer: string; threshold: number; screenPages: number; printPages: number; unmatched: number; mean: number; pages: CheckPage[] };

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
    return { page: n, share: d.share, sameSize: d.sameSize, screen: { width: screen[i]!.width, height: screen[i]!.height }, print: { width: printed.pages[i]!.width, height: printed.pages[i]!.height } };
  });
  const result: CheckResult = { dir, printer, threshold: THRESHOLD, screenPages: screens.length, printPages: printed.pages.length, unmatched: diff.unmatched, mean: diff.mean, pages };
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
