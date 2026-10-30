// --check and --trace on the sample paper, under each printer. No threshold is asserted: where the noise floor is waits for the first runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { specimen } from '@beltype/specimens';
import { print } from '../src/print.ts';

const SAMPLE = specimen('paper').entry;

for (const printer of ['caster', 'chromium'] as const) {
  test(`--check under --printer ${printer}: the pages agree in number, each has its share, and the trace has its layers`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `beltype-check-${printer}-`));
    const output = path.join(dir, 'paper.pdf');
    const tracePath = path.join(dir, 'trace.json');
    const result = await print(SAMPLE, output, { given: { beltype: { printer, check: true } }, trace: tracePath });
    const check = JSON.parse(fs.readFileSync(path.join(dir, 'paper.check', 'check.json'), 'utf8'));
    assert.equal(check.screenPages, check.printPages);
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
