import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { specimen } from '@beltype/specimens';
import { print } from '../src/print.ts';
import { diffPage, rasterize, type Raster } from '../src/compare.ts';

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
