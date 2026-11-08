// The printer waits (Cicero's `settled()`, SPEC XII.5): a document with no text in the body, whose only text is in a margin box and whose face is inherited from the root, has the face requested when the pages are presented, after `run()` has answered. The face arrives, Cicero cuts again, and a print that did not wait found 'the pages were replaced while they were being printed' (the essay's `margin-boxes/content-001`: 4 prints in 12 on 0.1.9 with Cicero 0.1.11).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { specimen } from '@beltype/specimens';
import { print } from '../src/print.ts';

const FACE = fs.readFileSync(path.join(path.dirname(specimen('paper').entry), 'fonts', 'SourceSerif4-Variable.woff2')).toString('base64');

test('twelve prints of a document whose only text is in a margin box refuse none', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-settled-'));
  const input = path.join(dir, 'doc.html');
  fs.writeFileSync(input, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title><style>
@font-face { font-family: "Source Serif 4"; src: url(data:font/woff2;base64,${FACE}) format("woff2"); font-weight: 200 900; }
@page { size: 400px; margin: 100px; @top-left { content: "PASS"; } @top-right { content: "PA" "SS"; } }
html { font-family: "Source Serif 4", serif; }
</style></head><body></body></html>`);
  for (let i = 1; i <= 12; i++) await assert.doesNotReject(print(input, path.join(dir, 'doc.pdf')), `print ${i}`);
});

test('the print awaits Cicero\'s settled() before it reads the pages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-settled-'));
  const input = path.join(dir, 'doc.html');
  // The document wraps `settled()` to rename itself once it has been awaited, and the file names the title it had when Caster read it.
  fs.writeFileSync(input, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not-awaited</title><style>
@font-face { font-family: "Source Serif 4"; src: url(data:font/woff2;base64,${FACE}) format("woff2"); font-weight: 200 900; }
@page { size: 400px; margin: 100px; @top-left { content: "PASS"; } }
html { font-family: "Source Serif 4", serif; }
</style><script>addEventListener('load', () => { const h = window.__beltypeCicero; const settled = h.settled; h.settled = async () => { await settled.call(h); document.title = 'Awaited'; }; });</script></head><body></body></html>`);
  const output = path.join(dir, 'doc.pdf');
  await print(input, output);
  const bytes = fs.readFileSync(output).toString('latin1');
  assert.ok(/Awaited/.test(bytes) || /A\0w\0a\0i\0t/.test(bytes), 'the file carries the title the document had after settled() was awaited');
  assert.ok(!/Not-awaited/.test(bytes));
});
