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

export interface TileDiff {
  readonly x: number;
  readonly y: number;
  readonly share: number;
  readonly outside: number;
}

export interface PageDiff {
  /** Share of the common area whose pixels differ, 0 to 1. */
  readonly share: number;
  readonly sameSize: boolean;
  readonly width: number;
  readonly height: number;
  /** Every tile with a differing pixel, by its top-left corner in the picture: `share` of its pixels differ, and `outside` of those its `cover` leaves out. A tile cut by the edge, or by the cover, is counted against at least a quarter of a tile. */
  readonly tiles: readonly TileDiff[];
  /** The differing pixels in red over a faded copy of the reference, as a PNG. */
  readonly image: Uint8Array;
}

/**
 * Draw every page of a PDF; `origins` is where each page's user-space origin falls in its picture, in pixels.
 *
 * @remarks
 * The presented page sits on the origin, its bottom-left corner there: Chromium's media is `[0 0 w h]`, and Caster grows its media round the page for a bleed and print marks (`[-31.181 -31.181 371.338 371.338]` on Caster's `roads`) and writes no `/TrimBox`, so the origin is where the trim is found.
 */
export function rasterize(pdf: Uint8Array, dpi = 96): { pages: Raster[]; pngs: Uint8Array[]; origins: { x: number; y: number }[] } {
  const doc = mupdf.Document.openDocument(pdf, 'application/pdf');
  const pages: Raster[] = [];
  const pngs: Uint8Array[] = [];
  const origins: { x: number; y: number }[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const t = (page as mupdf.PDFPage).getTransform();
    origins.push({ x: t[4] * dpi / 72, y: t[5] * dpi / 72 });
    const pix = page.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false);
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
  return { pages, pngs, origins };
}

/** The `width` by `height` window of `r` whose top-left corner is (x, y), clipped to `r`. */
export function crop(r: Raster, x: number, y: number, width: number, height: number): Raster {
  const x0 = Math.max(0, Math.min(x, r.width)), y0 = Math.max(0, Math.min(y, r.height));
  const w = Math.min(width, r.width - x0), h = Math.min(height, r.height - y0);
  const rgb = new Uint8Array(w * h * 3);
  for (let row = 0; row < h; row++) rgb.set(r.rgb.subarray(((y0 + row) * r.width + x0) * 3, ((y0 + row) * r.width + x0 + w) * 3), row * w * 3);
  return { width: w, height: h, rgb };
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

/** Compare two pages over their common area, read in `tile`-pixel squares; the picture is that area, the reference faded and the pixels that still differ after the slip red. `cover`, one byte a pixel of `ref`, marks the pixels a tile's `outside` leaves out. */
export function diffPage(ref: Raster, other: Raster, tile = 24, cover?: Uint8Array): PageDiff {
  const width = Math.min(ref.width, other.width);
  const height = Math.min(ref.height, other.height);
  const out = new Uint8Array(width * height * 3);
  const across = Math.ceil(width / tile);
  const count = across * Math.ceil(height / tile);
  const tiles = new Uint32Array(count);
  const outside = new Uint32Array(count);
  const covered = new Uint32Array(count);
  let differing = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = (y * ref.width + x) * 3;
      const o = (y * width + x) * 3;
      const t = Math.floor(y / tile) * across + Math.floor(x / tile);
      const inCover = cover ? cover[y * ref.width + x] === 1 : false;
      if (inCover) covered[t]!++;
      if (!matched(other, ref, x, y, width, height) || !matched(ref, other, x, y, width, height)) {
        differing++;
        tiles[t]!++;
        if (!inCover) outside[t]!++;
        out[o] = 255;
        out[o + 1] = 0;
        out[o + 2] = 0;
      } else for (let c = 0; c < 3; c++) out[o + c] = 255 - Math.round((255 - ref.rgb[a + c]!) * 0.3);
    }
  }
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  pix.getPixels().set(out);
  const least = tile * tile / 4;
  const diffs: TileDiff[] = [];
  tiles.forEach((n, i) => {
    if (!n) return;
    const x = (i % across) * tile, y = Math.floor(i / across) * tile;
    const area = (Math.min(x + tile, width) - x) * (Math.min(y + tile, height) - y);
    diffs.push({ x, y, share: n / Math.max(area, least), outside: outside[i]! / Math.max(area - covered[i]!, least) });
  });
  return { share: width * height ? differing / (width * height) : 0, sameSize: ref.width === other.width && ref.height === other.height, width, height, tiles: diffs, image: pix.asPNG() };
}

export interface PairDiff {
  readonly pages: readonly PageDiff[];
  /** Pages one has and the other lacks. */
  readonly unmatched: number;
  /** Mean share over the matched pages; 0 when none matched. */
  readonly mean: number;
}

/** Compare two page lists page by page. */
export function diffPages(ref: readonly Raster[], other: readonly Raster[], tile = 24, covers: readonly (Uint8Array | undefined)[] = []): PairDiff {
  const n = Math.min(ref.length, other.length);
  const pages = Array.from({ length: n }, (_, i) => diffPage(ref[i]!, other[i]!, tile, covers[i]));
  return { pages, unmatched: Math.abs(ref.length - other.length), mean: n ? pages.reduce((s, p) => s + p.share, 0) / n : 0 };
}
