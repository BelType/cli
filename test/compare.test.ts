import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { specimen } from '@beltype/specimens';
import { print } from '../src/print.ts';
import { diffPage, rasterize, type Raster } from '../src/compare.ts';
import { requireMupdf } from '../src/check.ts';

async function paperPage(): Promise<Raster> {
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-compare-')), 'paper.pdf');
  await print(specimen('paper').entry, output);
  return rasterize(fs.readFileSync(output)).pages[1]!;
}

test('a page against itself shifted down one pixel reads 0 %', async () => {
  const page = await paperPage();
  const rgb = new Uint8Array(page.rgb.length).fill(255);
  rgb.set(page.rgb.subarray(0, page.rgb.length - page.width * 3), page.width * 3);
  rgb.set(page.rgb.subarray(0, page.width * 3), 0);
  const diff = diffPage(page, { ...page, rgb });
  assert.equal(diff.share, 0);
});

test('a page against a copy with a 20x20 block painted black still differs by at least the block', async () => {
  const page = await paperPage();
  const rgb = page.rgb.slice();
  // a block on the blank margin, where the page is white, so every pixel of it is a real difference
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) rgb.fill(0, (y * page.width + x) * 3, (y * page.width + x) * 3 + 3);
  const diff = diffPage(page, { ...page, rgb });
  assert.ok(diff.share * page.width * page.height >= 20 * 20, `${diff.share * page.width * page.height} pixels`);
});

test('--check names mupdf and its licence when it is not installed, and mupdf stays out of an install', async () => {
  const missing = () => Promise.reject(Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' }));
  await assert.rejects(requireMupdf(missing), /mupdf.*AGPL-3\.0.*npm install mupdf/);
  const other = new Error('a broken build');
  await assert.rejects(requireMupdf(() => Promise.reject(other)), (error) => error === other, 'any other failure is not reworded');
  await requireMupdf();
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies.mupdf, undefined);
  assert.equal(pkg.peerDependenciesMeta.mupdf.optional, true);
});
