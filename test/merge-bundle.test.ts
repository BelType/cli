// The bundle the page imports is what src/merge-tab.ts and the pinned prosemirror-stores build to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { options } from '../scripts/bundle-merge.ts';

test('assets/merge/merge.js is up to date: run node scripts/bundle-merge.ts', async () => {
  const built = await build({ ...options, write: false });
  assert.equal(built.outputFiles![0]!.text, fs.readFileSync('assets/merge/merge.js', 'utf8'));
});
