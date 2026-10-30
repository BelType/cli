// The whole road on the sample paper: print it, read the file back with mupdf, and hold what the page carries to what the sheet asked for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as mupdf from 'mupdf';
import { specimen } from '@beltype/specimens';
import { print } from '../src/print.ts';

const SAMPLE = specimen('paper').entry;

test('the sample paper prints, and its pages carry what the sheet asked for', async () => {
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-print-')), 'paper.pdf');
  const result = await print(SAMPLE, output);
  const doc = mupdf.Document.openDocument(fs.readFileSync(output), 'application/pdf');
  const pages = Array.from({ length: doc.countPages() }, (_, i) => doc.loadPage(i).toStructuredText('').asText());
  assert.equal(pages.length, result.pages);
  assert.ok(pages.length >= 3, `${pages.length} pages`);
  const all = pages.join('\n');
  for (const words of ['Leaf litter decomposition along an altitudinal', 'Table 1.', 'Figure 1.', 'Above the tree line', 'Bradford, M. A.']) assert.ok(all.includes(words), `the file holds "${words}"`);
  // The counters reached the text: section numbers, and the cross-references' numbers and page.
  assert.match(all, /3\. Results/);
  assert.match(all, /\(Figure 1, Table 1\)/);
  assert.match(all, /Results \(p\. \d\)/);
  // hyphens: auto: Blink's breaks reach the file as a drawn hyphen standing for a soft hyphen.
  assert.match(all, /\u00AD\n/, 'a line ends in a hyphenated word');
  // :first suppresses the margin boxes; every later page carries the running title and its own folio.
  assert.ok(!pages[0]!.includes('Leaf litter decomposition along an altitudinal gradient\n'), 'no running title on the title page');
  pages.slice(1).forEach((text, i) => {
    assert.ok(text.includes('Leaf litter decomposition along an altitudinal gradient'), `page ${i + 2} carries the running title`);
    assert.match(text, new RegExp(`(^|\\n)${i + 2}\\s*$`), `page ${i + 2} ends with its folio`);
  });
});
