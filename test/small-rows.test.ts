// Three small rows of the fifth batch: a refused print leaves no file, the print says the standard its file claims, and a symlink cannot pull a file from outside the document's folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { specimen } from '@beltype/specimens';
import { print } from '../src/print.ts';

const FONTS = path.join(path.dirname(specimen('paper').entry), 'fonts');
const MAIN = path.join(import.meta.dirname, '..', 'src', 'main.ts');

const page = (head = '', body = '<p>Words.</p>') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title><style>
@font-face { font-family: "Source Serif 4"; src: url("fonts/SourceSerif4-Variable.woff2") format("woff2"); font-weight: 200 900; }
@page { size: A5; margin: 20mm; }
body { font: 12pt/1.4 "Source Serif 4"; }
</style>${head}</head><body>${body}</body></html>`;

function folder(html: string): { dir: string; input: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-small-'));
  fs.cpSync(FONTS, path.join(dir, 'fonts'), { recursive: true });
  const input = path.join(dir, 'doc.html');
  fs.writeFileSync(input, html);
  return { dir, input };
}

test('a refused print leaves no file, not even the one an earlier run wrote', async () => {
  const { dir, input } = folder(page('<link rel="stylesheet" href="absent.css">'));
  const output = path.join(dir, 'doc.pdf');
  fs.writeFileSync(output, 'an earlier print');
  await assert.rejects(print(input, output), /absent\.css/);
  assert.ok(!fs.existsSync(output), 'the old file is gone');
});

test('the print says the standard its file claims', () => {
  const { dir, input } = folder(page());
  const out = execFileSync('node', [MAIN, 'print', input, '-o', path.join(dir, 'doc.pdf')], { encoding: 'utf8' });
  assert.match(out, /words, [\d.]+ s, pdf-2\.0; pdf-ua-2/);
});

test('a symlink inside the folder does not pull in a file from outside it', async () => {
  const { dir, input } = folder(page('<link rel="stylesheet" href="leak.css">'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.css'), 'body { color: red }');
  fs.symlinkSync(path.join(outside, 'secret.css'), path.join(dir, 'leak.css'));
  await assert.rejects(print(input, path.join(dir, 'doc.pdf')), /leak\.css/);
});

test('a symlink that stays inside the folder is served', async () => {
  const { dir, input } = folder(page('<link rel="stylesheet" href="alias.css">'));
  fs.writeFileSync(path.join(dir, 'real.css'), 'body { color: #333 }');
  fs.symlinkSync('real.css', path.join(dir, 'alias.css'));
  await print(input, path.join(dir, 'doc.pdf'));
});
