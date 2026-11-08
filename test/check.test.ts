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
import { checkPages, gate, MAX_SHARE } from '../src/check.ts';
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
  const r = await checkPages(pngs, pdf, scratch(), 'caster');
  assert.ok(r.pages.every((p) => p.pass));
  assert.doesNotThrow(() => gate(r, true));
});

test('the gate: one page over the threshold fails the run, naming the page, its share and its picture; the report is written all the same', async () => {
  const { pdf, pngs } = pages(3);
  const dir = scratch();
  const r = await checkPages([pngs[0]!, blocked(pngs[1]!, MAX_SHARE * 2), pngs[2]!], pdf, dir, 'caster');
  assert.deepEqual(r.pages.map((p) => p.pass), [true, false, true]);
  assert.throws(() => gate(r, true), (e: unknown) => e instanceof BuildError && new RegExp(`^check page 2 fails: \\d+\\.\\d\\d% differ, over 3\\.5%; ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/diff-2\\.png$`).test(e.message));
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8'));
  assert.equal(written.maxShare, MAX_SHARE);
  assert.deepEqual(written.pages.map((p: { pass: boolean }) => p.pass), [true, false, true]);
});

test('--check=report: the same page over the threshold leaves the run alone and the report written', async () => {
  const { pdf, pngs } = pages(1);
  const dir = scratch();
  const r = await checkPages([blocked(pngs[0]!, MAX_SHARE * 2)], pdf, dir, 'caster');
  assert.equal(r.pages[0]!.pass, false);
  assert.doesNotThrow(() => gate(r, 'report'));
  assert.ok(fs.existsSync(path.join(dir, 'check.json')) && fs.existsSync(path.join(dir, 'diff-1.png')));
  assert.equal(cliFlags.parse('check', 'report'), 'report');
  assert.equal(cliFlags.parse('check', 'true'), true);
});

test('the gate: a page count that differs between screen and print fails the run', async () => {
  const { pdf, pngs } = pages(2);
  const r = await checkPages([pngs[0]!], pdf, scratch(), 'caster');
  assert.ok(r.pages.every((p) => p.pass));
  assert.throws(() => gate(r, true), (e: unknown) => e instanceof BuildError && /^check fails: the screen has 1 pages and the print 2; .*doc\.check$/.test(e.message));
});
