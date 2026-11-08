// --check and --trace on the sample paper, under each printer; and the gate, over pages drawn by mupdf with no browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { specimen } from '@beltype/specimens';
import * as mupdf from 'mupdf';
import { BuildError } from '@beltype/common/errors';
import { print } from '../src/print.ts';
import { checkLines, checkPages, gate, MAX_SHARE, TILE, TILE_FLOORS, type Confession, type Shot } from '../src/check.ts';
import { cliFlags } from '../src/flags.ts';

const SAMPLE = specimen('paper').entry;

for (const printer of ['caster', 'chromium'] as const) {
  test(`--check under --printer ${printer}: the pages agree in number, each has its share, and the trace has its layers`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `beltype-check-${printer}-`));
    const output = path.join(dir, 'paper.pdf');
    const tracePath = path.join(dir, 'trace.json');
    const result = await print(SAMPLE, output, { given: { beltype: { printer, check: true } }, trace: tracePath });
    const check = JSON.parse(fs.readFileSync(path.join(dir, 'paper.check', 'check.json'), 'utf8'));
    assert.equal(check.screenPages, check.printPages);
    assert.equal(check.maxShare, MAX_SHARE);
    assert.ok(check.pages.every((p: { pass: boolean }) => p.pass), 'every page of the paper passes');
    assert.equal(check.screenPages, result.pages);
    assert.equal(check.pages.length, check.screenPages);
    for (const [i, p] of check.pages.entries()) {
      assert.ok(typeof p.share === 'number' && p.share >= 0 && p.share <= 1, `page ${i + 1} share ${p.share}`);
      for (const f of ['screen', 'print', 'diff']) assert.ok(fs.existsSync(path.join(dir, 'paper.check', `${f}-${i + 1}.png`)));
    }
    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    assert.ok(Object.keys(trace.process).length > 0 && trace.process.total > 0);
    assert.ok(trace.cicero.length > 0 && trace.cicero.every((m: { name: string }) => m.name.startsWith('cicero:')));
    if (printer === 'caster') assert.ok(Object.keys(trace.caster.ms).length > 0);
    else assert.equal(trace.caster, null);
    assert.equal(trace.flags.beltype.printer, printer);
  });
}

/** A PDF of `n` A4 pages, each with a grey bar, and the same pages as PNGs the way the screen would hand them over. */
function pages(n: number): { pdf: Uint8Array; pngs: Uint8Array[] } {
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < n; i++) doc.insertPage(-1, doc.addPage([0, 0, 595.28, 841.89], 0, {}, '0.5 g 72 700 300 40 re f'));
  const pdf = doc.saveToBuffer('').asUint8Array().slice();
  const reopened = mupdf.Document.openDocument(pdf, 'application/pdf');
  const pngs = Array.from({ length: n }, (_, i) => reopened.loadPage(i).toPixmap(mupdf.Matrix.scale(96 / 72, 96 / 72), mupdf.ColorSpace.DeviceRGB, false).asPNG());
  return { pdf, pngs };
}

/** The pages as the screen hands them over, each of one kind. */
const shots = (pngs: Uint8Array[], kind: Shot['kind'] = 'text'): Shot[] => pngs.map((png) => ({ png, kind }));

/** The PNG with a `w` by `h` block of `rgb` painted at (x, y). */
function painted(png: Uint8Array, x0: number, y0: number, w: number, h: number, rgb: [number, number, number] = [255, 0, 0]): Uint8Array {
  const pix = new mupdf.Image(png).toPixmap();
  const n = pix.getNumberOfComponents(), stride = pix.getStride(), px = pix.getPixels();
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) for (let c = 0; c < 3; c++) px[y * stride + x * n + c] = rgb[c]!;
  return pix.asPNG();
}

/** The PNG with a black block over `share` of its area painted into its top left. */
function blocked(png: Uint8Array, share: number): Uint8Array {
  const pix = new mupdf.Image(png).toPixmap();
  const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), stride = pix.getStride(), px = pix.getPixels();
  const side = Math.ceil(Math.sqrt(share * w * h));
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) for (let c = 0; c < 3; c++) px[y * stride + x * n + c] = 0;
  return pix.asPNG();
}

const scratch = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-gate-')), 'doc.check');

test('the gate: pages all under the threshold pass, and the run goes on', async () => {
  const { pdf, pngs } = pages(2);
  const r = await checkPages(shots(pngs), pdf, scratch(), 'caster');
  assert.ok(r.pages.every((p) => p.pass));
  assert.doesNotThrow(() => gate(r, true));
});

test('the gate: one page over the threshold fails the run, naming the page, its share and its picture; the report is written all the same', async () => {
  const { pdf, pngs } = pages(3);
  const dir = scratch();
  const r = await checkPages(shots([pngs[0]!, blocked(pngs[1]!, MAX_SHARE * 2), pngs[2]!]), pdf, dir, 'caster');
  assert.deepEqual(r.pages.map((p) => p.pass), [true, false, true]);
  assert.throws(() => gate(r, true), (e: unknown) => e instanceof BuildError && new RegExp(`^check page 2 fails: \\d+\\.\\d\\d% differ, over 3\\.5%; ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/diff-2\\.png$`).test(e.message));
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8'));
  assert.equal(written.maxShare, MAX_SHARE);
  assert.deepEqual(written.pages.map((p: { pass: boolean }) => p.pass), [true, false, true]);
});

test('--check=report: the same page over the threshold leaves the run alone and the report written', async () => {
  const { pdf, pngs } = pages(1);
  const dir = scratch();
  const r = await checkPages(shots([blocked(pngs[0]!, MAX_SHARE * 2)]), pdf, dir, 'caster');
  assert.equal(r.pages[0]!.pass, false);
  assert.doesNotThrow(() => gate(r, 'report'));
  assert.ok(fs.existsSync(path.join(dir, 'check.json')) && fs.existsSync(path.join(dir, 'diff-1.png')));
  assert.equal(cliFlags.parse('check', 'report'), 'report');
  assert.equal(cliFlags.parse('check', 'true'), true);
});

test('the gate: a page count that differs between screen and print fails the run', async () => {
  const { pdf, pngs } = pages(2);
  const r = await checkPages(shots([pngs[0]!]), pdf, scratch(), 'caster');
  assert.ok(r.pages.every((p) => p.pass));
  assert.throws(() => gate(r, true), (e: unknown) => e instanceof BuildError && /^check fails: the screen has 1 pages and the print 2; .*doc\.check$/.test(e.message));
});

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('the tile gate: the 120 by 30 px block of Caster\'s acceptance suite passes the share and fails a tile, named where it is', async () => {
  const { pdf, pngs } = pages(1);
  const dir = scratch();
  const r = await checkPages(shots([painted(pngs[0]!, 300, 340, 120, 30)]), pdf, dir, 'caster');
  const p = r.pages[0]!;
  assert.ok(p.share < MAX_SHARE, `share ${p.share}`);
  // a block 30 px tall covers at least 15 of some tile's 24 rows wherever it falls, and 120 px wide covers whole tiles across
  assert.ok(p.tile.share >= 15 / 24, `tile ${p.tile.share}`);
  assert.equal(p.kind, 'text');
  assert.equal(p.pass, false);
  assert.throws(() => gate(r, true), (e: unknown) => e instanceof BuildError && new RegExp(`^check page 1 fails: tile at \\(\\d+, \\d+\\) differs \\d+%, over the ${TILE_FLOORS.text * 100}% floor for a text page; ${escaped(dir)}/diff-1\\.png$`).test(e.message));
  assert.doesNotThrow(() => gate(r, 'report'));
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8'));
  assert.deepEqual(Object.keys(written.pages[0].tile).sort(), ['share', 'x', 'y']);
  assert.equal(written.pages[0].kind, 'text');
});

test('the tile gate: a clean text page and a clean picture page pass, and a tile over the floor fails either, naming its kind', async () => {
  const { pdf, pngs } = pages(2);
  const clean = await checkPages([{ png: pngs[0]!, kind: 'text' }, { png: pngs[1]!, kind: 'picture' }], pdf, scratch(), 'caster');
  assert.deepEqual(clean.pages.map((p) => p.pass), [true, true]);
  assert.deepEqual(clean.pages.map((p) => p.kind), ['text', 'picture']);
  const rows = Math.ceil(TILE_FLOORS.picture * TILE) + 1;
  const over = (png: Uint8Array) => painted(png, TILE * 10, TILE * 10, TILE, rows, [0, 0, 0]);
  const dir = scratch();
  const r = await checkPages([{ png: over(pngs[0]!), kind: 'text' }, { png: over(pngs[1]!), kind: 'picture' }], pdf, dir, 'caster');
  assert.deepEqual(r.pages.map((p) => p.pass), [false, false]);
  assert.deepEqual([r.pages[1]!.tile.x, r.pages[1]!.tile.y], [TILE * 10, TILE * 10]);
  assert.throws(() => gate(r, true), (e: unknown) => e instanceof BuildError && e.message.split('\n')[1] === `check page 2 fails: tile at (240, 240) differs ${Math.round(rows / TILE * 100)}%, over the 40% floor for a picture page; ${dir}/diff-2.png`);
});

test('the share gate still holds: a page drawn blank fails on its share', async () => {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 595.28, 841.89], 0, {}, '0.2 g 72 72 451 600 re f'));
  const pdf = doc.saveToBuffer('').asUint8Array().slice();
  const { pngs } = pages(1);
  const blank = painted(pngs[0]!, 0, 0, 794, 1122, [255, 255, 255]);
  const r = await checkPages(shots([blank]), pdf, scratch(), 'caster');
  assert.ok(r.pages[0]!.share > MAX_SHARE);
  assert.throws(() => gate(r, true), /check page 1 fails: \d+\.\d\d% differ, over 3\.5%/);
});

test('a bled page is aligned on the trim: the print\'s media grows round the presented page, which sits at the origin, and the two compare at one size', async () => {
  const content = '0.5 g 40 200 260 40 re f 0 g 20 20 300 2 re f';
  const marks = '0 g 0.5 w -31 0 m -8 0 l S 0 -31 m 0 -8 l S 371 340.157 m 348 340.157 l S 340.157 371 m 340.157 348 l S';
  const bled = new mupdf.PDFDocument();
  bled.insertPage(-1, bled.addPage([-31.181, -31.181, 371.338, 371.338], 0, {}, `${content} ${marks}`));
  const pdf = bled.saveToBuffer('').asUint8Array().slice();
  const trim = new mupdf.PDFDocument();
  trim.insertPage(-1, trim.addPage([0, 0, 340.157, 340.157], 0, {}, content));
  const screen = mupdf.Document.openDocument(trim.saveToBuffer('').asUint8Array().slice(), 'application/pdf').loadPage(0).toPixmap(mupdf.Matrix.scale(96 / 72, 96 / 72), mupdf.ColorSpace.DeviceRGB, false).asPNG();
  const r = await checkPages(shots([screen]), pdf, scratch(), 'caster');
  const p = r.pages[0]!;
  assert.ok(p.share < MAX_SHARE && p.tile.share <= TILE_FLOORS.text, `share ${p.share}, tile ${p.tile.share}`);
  assert.equal(p.sameSize, true);
  assert.doesNotThrow(() => gate(r, true));
});

/** A confession of page 1 over the rectangle, in the presented page's CSS px. */
const confessed = (x: number, y: number, width: number, height: number, kind = 'black-text', element = 'table[0]'): Confession => ({ page: 1, kind, rect: { x, y, width, height }, element, note: '' });

test('a confession whose region covers S91\'s block excuses its tiles, and the report line and check.json name it', async () => {
  const { pdf, pngs } = pages(1);
  const dir = scratch();
  const r = await checkPages(shots([painted(pngs[0]!, 300, 340, 120, 30)]), pdf, dir, 'caster', [confessed(296, 336, 128, 38)]);
  const p = r.pages[0]!;
  assert.equal(p.pass, true);
  assert.ok(p.tile.share <= TILE_FLOORS.text, `worst unexcused tile ${p.tile.share}`);
  assert.ok(p.excused.length > 0 && p.excused.every((t) => t.kind === 'black-text' && t.element === 'table[0]'));
  assert.doesNotThrow(() => gate(r, true));
  assert.match(checkLines(r)[0]!, /^check page 1: \d+\.\d\d% differ, worst tile \d+% at \(\d+, \d+\) excused by black-text on table\[0\]; a text page$/);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8'));
  assert.deepEqual(Object.keys(written.pages[0].excused[0]).sort(), ['element', 'kind', 'share', 'x', 'y']);
});

test('a confession elsewhere on the page excuses nothing: the block fails as before', async () => {
  const { pdf, pngs } = pages(1);
  const r = await checkPages(shots([painted(pngs[0]!, 300, 340, 120, 30)]), pdf, scratch(), 'caster', [confessed(40, 900, 300, 60), { ...confessed(0, 0, 794, 1122), page: 2 }]);
  assert.equal(r.pages[0]!.pass, false);
  assert.deepEqual(r.pages[0]!.excused, []);
  assert.throws(() => gate(r, true), /check page 1 fails: tile at \(\d+, \d+\) differs \d+%, over the 40% floor for a text page/);
});

test('a tile straddling a confessed region is excused only when what lies outside it, on its own, is under the floor', async () => {
  const { pdf, pngs } = pages(1);
  // the block fills the tile at (240, 240); the confession covers its left 12 columns only, so the right half still differs whole
  const r = await checkPages(shots([painted(pngs[0]!, 240, 240, 24, 24)]), pdf, scratch(), 'caster', [confessed(240, 240, 12, 24)]);
  assert.equal(r.pages[0]!.pass, false);
  assert.deepEqual([r.pages[0]!.tile.x, r.pages[0]!.tile.y], [240, 240]);
});

test('a confession never excuses the share: a blank page under a full-page confession still fails', async () => {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 595.28, 841.89], 0, {}, '0.2 g 72 72 451 600 re f'));
  const pdf = doc.saveToBuffer('').asUint8Array().slice();
  const { pngs } = pages(1);
  const r = await checkPages(shots([painted(pngs[0]!, 0, 0, 794, 1122, [255, 255, 255])]), pdf, scratch(), 'caster', [confessed(0, 0, 794, 1123, 'raster')]);
  assert.equal(r.pages[0]!.pass, false);
  assert.throws(() => gate(r, true), /check page 1 fails: \d+\.\d\d% differ, over 3\.5%/);
});
