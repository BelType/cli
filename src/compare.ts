/**
 * Rasterize a PDF and measure how far two renderings are apart.
 *
 * @remarks
 * Pages are drawn at 96 dpi, RGB, on white. A pixel differs when its largest channel difference exceeds {@link THRESHOLD} of 255 from every pixel within {@link NEIGHBOURHOOD} of it in the other raster. Pages of different sizes are compared over their common area and flagged. The numbers say how far apart two tools are, never which is right.
 *
 * Copied from the testbench's `src/compare.ts`, which keeps its own; one shared home waits until a third user appears.
 *
 * @packageDocumentation
 */

import * as mupdf from 'mupdf';

export const THRESHOLD = 32;

/**
 * How far a pixel may slip, in pixels, and still count as the same. A pixel differs only when nothing within this reach in the other raster is within {@link THRESHOLD} of it, and the same the other way round.
 *
 * @remarks
 * The screen's pages sit at fractional heights on Cicero's stack (A4 is 1122.52 px), so the screenshot slips 0 to 1 px against mupdf's exact origin; and Skia and mupdf shade letter edges differently. Without the reach every glyph edge below the slip reads as a difference. This is the reftests' `fuzzy` idea (Web Platform Tests, Mozilla).
 */
export const NEIGHBOURHOOD = 1;

export interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGB, three bytes a pixel, rows packed. */
  readonly rgb: Uint8Array;
}

export interface PageDiff {
  /** Share of the common area whose pixels differ, 0 to 1. */
  readonly share: number;
  readonly sameSize: boolean;
  readonly width: number;
  readonly height: number;
  /** The differing pixels in red over a faded copy of the reference, as a PNG. */
  readonly image: Uint8Array;
}

/** Draw every page of a PDF. */
export function rasterize(pdf: Uint8Array, dpi = 96): { pages: Raster[]; pngs: Uint8Array[] } {
  const doc = mupdf.Document.openDocument(pdf, 'application/pdf');
  const pages: Raster[] = [];
  const pngs: Uint8Array[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const pix = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false);
    const width = pix.getWidth();
    const height = pix.getHeight();
    const n = pix.getNumberOfComponents();
    const stride = pix.getStride();
    const src = pix.getPixels();
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) rgb[(y * width + x) * 3 + c] = src[y * stride + x * n + c]!;
    pages.push({ width, height, rgb });
    pngs.push(pix.asPNG());
  }
  return { pages, pngs };
}

/** Whether the pixel at (x, y) of `from` is within the threshold of any pixel of `to` within {@link NEIGHBOURHOOD} of (x, y), clipped at the edges. */
function matched(from: Raster, to: Raster, x: number, y: number, width: number, height: number): boolean {
  const a = (y * from.width + x) * 3;
  const r = from.rgb[a]!, g = from.rgb[a + 1]!, bl = from.rgb[a + 2]!;
  for (let dy = -NEIGHBOURHOOD; dy <= NEIGHBOURHOOD; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -NEIGHBOURHOOD; dx <= NEIGHBOURHOOD; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= width) continue;
      const b = (yy * to.width + xx) * 3;
      if (Math.abs(r - to.rgb[b]!) <= THRESHOLD && Math.abs(g - to.rgb[b + 1]!) <= THRESHOLD && Math.abs(bl - to.rgb[b + 2]!) <= THRESHOLD) return true;
    }
  }
  return false;
}

/** Compare two pages over their common area; the picture is that area, the reference faded and the pixels that still differ after the slip red. */
export function diffPage(ref: Raster, other: Raster): PageDiff {
  const width = Math.min(ref.width, other.width);
  const height = Math.min(ref.height, other.height);
  const out = new Uint8Array(width * height * 3);
  let differing = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = (y * ref.width + x) * 3;
      const o = (y * width + x) * 3;
      if (!matched(other, ref, x, y, width, height) || !matched(ref, other, x, y, width, height)) {
        differing++;
        out[o] = 255;
        out[o + 1] = 0;
        out[o + 2] = 0;
      } else for (let c = 0; c < 3; c++) out[o + c] = 255 - Math.round((255 - ref.rgb[a + c]!) * 0.3);
    }
  }
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  pix.getPixels().set(out);
  return { share: width * height ? differing / (width * height) : 0, sameSize: ref.width === other.width && ref.height === other.height, width, height, image: pix.asPNG() };
}

export interface PairDiff {
  readonly pages: readonly PageDiff[];
  /** Pages one has and the other lacks. */
  readonly unmatched: number;
  /** Mean share over the matched pages; 0 when none matched. */
  readonly mean: number;
}

/** Compare two page lists page by page. */
export function diffPages(ref: readonly Raster[], other: readonly Raster[]): PairDiff {
  const n = Math.min(ref.length, other.length);
  const pages = Array.from({ length: n }, (_, i) => diffPage(ref[i]!, other[i]!));
  return { pages, unmatched: Math.abs(ref.length - other.length), mean: n ? pages.reduce((s, p) => s + p.share, 0) / n : 0 };
}
