// A plain print does not load Caster in Node: the page resolves Caster's defaults itself, and the table is imported only for --flag caster.*, --help and the trace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { specimen } from '@beltype/specimens';

const resolved: string[] = [];
// `load`, not `resolve`: `import.meta.resolve` asks where a package is without loading it, which the run does for the folder it serves.
registerHooks({ load: (url, context, next) => {
  resolved.push(url);
  return next(url, context);
} });
const { print } = await import('../src/print.ts');

test('a plain print loads no Caster module in Node', async () => {
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-lazy-')), 'paper.pdf');
  await print(specimen('paper').entry, output);
  assert.ok(resolved.length > 50, `${resolved.length} loads seen`);
  const caster = resolved.filter((url) => /\/caster\/(dist|src)\//.test(url));
  assert.deepEqual(caster, []);
});
