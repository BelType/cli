// What Caster draws differently or not at all is said on the command line (codeberg.org/BelType/cli issue 1): a box-shadow, which Caster paints as a raster, is named in a line after the run, with the element and what it was painted as.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { specimen } from '@beltype/specimens';
import { print } from '../src/print.ts';

const FONTS = path.join(path.dirname(specimen('paper').entry), 'fonts');

test('a deferral is printed after the run, naming the element, the feature and what it was painted as', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-deferred-'));
  fs.cpSync(FONTS, path.join(dir, 'fonts'), { recursive: true });
  const input = path.join(dir, 'shadow.html');
  fs.writeFileSync(input, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shadow</title><style>
@font-face { font-family: "Source Serif 4"; src: url("fonts/SourceSerif4-Variable.woff2") format("woff2"); font-weight: 200 900; }
@page { size: A5; margin: 20mm; }
body { font: 12pt/1.4 "Source Serif 4"; }
.box { padding: 4mm; border: 0.5pt solid #000; box-shadow: 2mm 2mm 3mm #888; }
</style></head><body><div class="box" id="boxed">A box with a shadow.</div></body></html>`);
  const lines: string[] = [];
  t.mock.method(console, 'warn', (line: unknown) => { lines.push(String(line)); });
  const result = await print(input, path.join(dir, 'shadow.pdf'));
  const deferral = lines.find((line) => line.includes('box-shadow'));
  assert.ok(deferral, `a line names the box-shadow: ${JSON.stringify(lines)}`);
  assert.match(deferral, /boxed|div/, 'the line names the element');
  assert.match(deferral, /raster/, 'the line says what it was painted as');
  assert.equal(result.deferred, 1, 'the result counts the deferral');
});
