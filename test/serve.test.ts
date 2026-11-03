// beltype serve: the paper posted as a form prints the same file as `beltype print`, and the door refuses what it should, by name.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { specimen } from '@beltype/specimens';
import { print } from '../src/print.ts';
import { serve } from '../src/serve.ts';

const SAMPLE = specimen('paper').entry;
const FOLDER = path.dirname(SAMPLE);
const CREATED = '2026-11-03T12:00:00.000Z';

function files(dir: string, base = ''): string[] {
  return fs.readdirSync(path.join(dir, base), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(dir, `${base}${e.name}/`) : [`${base}${e.name}`]));
}

function paperForm(fields: Record<string, string>, omit?: string): FormData {
  const form = new FormData();
  for (const name of files(FOLDER)) if (name !== omit) form.append(name, new Blob([fs.readFileSync(path.join(FOLDER, name))]), path.basename(name));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

const log: string[] = [];
let server: Awaited<ReturnType<typeof serve>>;
let small: Awaited<ReturnType<typeof serve>>;
const options = { host: '127.0.0.1', port: 0, maxUpload: 50 * 1024 * 1024, timeout: 60_000, restartAfter: 100 };

before(async () => {
  server = await serve({ ...options, log: (line) => log.push(line) });
  small = await serve({ ...options, maxUpload: 1024 * 1024, log: () => {} });
});
after(async () => {
  await server.close();
  await small.close();
});

const health = async () => (await fetch(`${server.url}/health`)).json() as Promise<{ status: string; prints: number; queued: number }>;

for (const writer of ['pdf-lib', 'forme']) {
  test(`the paper posted under ${writer} equals beltype print's file, byte for byte`, async () => {
    const before = (await health()).prints;
    const res = await fetch(`${server.url}/print`, { method: 'POST', body: paperForm({ 'caster.writer': writer, created: CREATED }) });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.ok(Number(res.headers.get('x-beltype-pages')) >= 3);
    const served = Buffer.from(await res.arrayBuffer());
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-serve-test-')), 'paper.pdf');
    await print(SAMPLE, output, { given: { caster: { writer } }, created: CREATED });
    const printed = fs.readFileSync(output);
    fs.rmSync(path.dirname(output), { recursive: true });
    assert.ok(served.equals(printed), `${served.length} bytes served, ${printed.length} printed`);
    assert.equal((await health()).prints, before + 1);
  });
}

test('a document asking for a file it was not given is refused with 422, naming the file', async () => {
  const res = await fetch(`${server.url}/print`, { method: 'POST', body: paperForm({}, 'paper.css') });
  assert.equal(res.status, 422);
  assert.match(await res.text(), /beltype print: the document asked for what the run cannot give it[\s\S]*\/paper\.css/);
});

test('a file name that climbs out is a 400, as is beltype.check', async () => {
  const bad = paperForm({});
  bad.append('../x.css', new Blob(['x']), 'x.css');
  assert.equal((await fetch(`${server.url}/print`, { method: 'POST', body: bad })).status, 400);
  const check = await fetch(`${server.url}/print`, { method: 'POST', body: paperForm({ 'beltype.check': 'true' }) });
  assert.equal(check.status, 400);
});

test('a body over maxUpload is a 413', async () => {
  const form = paperForm({});
  form.append('big.bin', new Blob([new Uint8Array(2 * 1024 * 1024)]), 'big.bin');
  const res = await fetch(`${small.url}/print`, { method: 'POST', body: form });
  assert.equal(res.status, 413);
});

test('two prints at once both succeed, the second starting after the first ends', async () => {
  log.length = 0;
  const post = () => fetch(`${server.url}/print`, { method: 'POST', body: paperForm({ created: CREATED }) });
  const both = await Promise.all([post(), post()]);
  assert.deepEqual(both.map((r) => r.status), [200, 200]);
  const events = log.filter((l) => / started$| 200,/.test(l)).map((l) => (l.endsWith('started') ? 'start' : 'end'));
  assert.deepEqual(events, ['start', 'end', 'start', 'end']);
});
