import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlagArgs, flagsHelp } from '../src/flags.ts';
import { chromiumSheet } from '../src/chromium.ts';
import { BuildError, FlagError, ValidationError } from '@beltype/common/errors';

test('--flag reads owner.name=value against the owner\'s table', async () => {
  assert.deepEqual(await parseFlagArgs(['caster.shaper=fontkit', 'caster.rasterDpi=150', 'cicero.composed=true', 'beltype.printer=chromium', 'caster.skipInk=false']), {
    caster: { shaper: 'fontkit', rasterDpi: 150, skipInk: false }, cicero: { composed: true }, beltype: { printer: 'chromium' }
  });
  assert.deepEqual(await parseFlagArgs([]), { caster: {}, cicero: {}, beltype: {} });
});

test('an unknown owner, an unknown name and a bad value are each refused by name', async () => {
  await assert.rejects(() => parseFlagArgs(['nobody.x=1']), (e: unknown) => e instanceof ValidationError && /no flag owner 'nobody'.*caster, cicero, beltype/.test(e.message));
  await assert.rejects(() => parseFlagArgs(['caster.nope=1']), (e: unknown) => e instanceof FlagError && /unknown option 'nope'/.test(e.message));
  await assert.rejects(() => parseFlagArgs(['caster.shaper=x']), (e: unknown) => e instanceof FlagError && /takes "harfbuzz" or "fontkit"; got "x"/.test(e.message));
  await assert.rejects(() => parseFlagArgs(['shaper=fontkit']), ValidationError);
});

test('--help lists every table: owner, name, values, default', async () => {
  const help = await flagsHelp();
  assert.match(help, /caster\.shaper\s+harfbuzz \| fontkit\s+default harfbuzz/);
  assert.match(help, /cicero\.composed\s+false \| true\s+default false/);
  assert.match(help, /beltype\.printer\s+caster \| chromium\s+default caster/);
  assert.match(help, /beltype\.check\s+false \| true\s+default false/);
});

test('Chromium\'s print sheet for one page size, and the refusal for two', () => {
  const sheet = chromiumSheet([{ w: 793.7, h: 1122.5 }, { w: 793.7, h: 1122.5 }]);
  assert.equal(sheet.page, '@page { size: 793.7px 1122.5px; margin: 0 }');
  assert.match(sheet.shadow, /beltype-page \{ break-after: page/);
  assert.throws(() => chromiumSheet([{ w: 793.7, h: 1122.5 }, { w: 500, h: 700 }]), (e: unknown) => e instanceof BuildError && /--printer caster/.test(e.message));
});
