// beltype serve: the paper posted as a form prints the same file as `beltype print`, and the door refuses what it should, by name.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { specimen } from '@beltype/specimens';
import { print } from '../src/print.ts';
import { serve, keptRoad, WARMUP, WARMUP_FONT } from '../src/serve.ts';

const SAMPLE = specimen('paper').entry;
const FOLDER = path.dirname(SAMPLE);
const CREATED = '2026-11-03T12:00:00.000Z';

function files(dir: string, base = ''): string[] {
  return fs.readdirSync(path.join(dir, base), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(dir, `${base}${e.name}/`) : [`${base}${e.name}`]));
}

function paperForm(fields: Record<string, string>, omit?: string, folder = FOLDER): FormData {
  const form = new FormData();
  for (const name of files(folder)) if (name !== omit) form.append(name, new Blob([fs.readFileSync(path.join(folder, name))]), path.basename(name));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

const log: string[] = [];
let server: Awaited<ReturnType<typeof serve>>;
let extras = { close: async () => {} };
let small: Awaited<ReturnType<typeof serve>>;
const options = { host: '127.0.0.1', port: 0, maxUpload: 50 * 1024 * 1024, timeout: 60_000, restartAfter: 100 };

before(async () => {
  server = await serve({ ...options, log: (line) => log.push(line) });
  small = await serve({ ...options, maxUpload: 1024 * 1024, log: () => {} });
});
after(async () => {
  await server.close();
  await small.close();
  await extras.close();
  // Brief 4, gate 5: nothing left behind. A timed-out print's folder goes before its answer; the wait is for any print still closing.
  const left = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('beltype-serve-'));
  for (let i = 0; i < 100 && left().length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(left(), []);
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

// Brief 4: kept alive and limited. Each test owns a server, so a restart or a limit never disturbs the others.
const own = async (extra: Partial<Parameters<typeof serve>[0]>) => {
  const lines: string[] = [];
  const s = await serve({ ...options, log: (l) => lines.push(l), ...extra });
  const previous = extras.close;
  extras = { close: async () => { await s.close(); await previous(); } };
  return { s, lines };
};
const post = (url: string, fields: Record<string, string> = {}) => fetch(`${url}/print`, { method: 'POST', body: paperForm({ created: CREATED, ...fields }) });
const upTo = async (url: string) => (await fetch(`${url}/health`)).json() as Promise<{ status: string }>;

test('a crashed browser: the next print succeeds after a restart, and /health said restarting meanwhile', async () => {
  let browser: { close(): Promise<void> } | undefined;
  const { s, lines } = await own({ onBrowser: (b) => { browser = b; } });
  await browser!.close();
  const seen = new Set<string>();
  let stop = false;
  const poll = (async () => { while (!stop) { seen.add((await upTo(s.url)).status); await new Promise((r) => setTimeout(r, 20)); } })();
  const res = await post(s.url);
  stop = true;
  await poll;
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(seen.has('restarting'), `statuses seen: ${[...seen]}`);
  assert.ok(lines.some((l) => /restarting the browser/.test(l)));
  assert.equal((await upTo(s.url)).status, 'up');
});

test('restartAfter 2: three prints, one restart, after the second', async () => {
  const { s, lines } = await own({ restartAfter: 2 });
  for (let i = 0; i < 3; i++) assert.equal((await post(s.url)).status, 200);
  const events = lines.filter((l) => /restarting the browser| 200,/.test(l)).map((l) => (/restarting/.test(l) ? 'restart' : 'print'));
  assert.deepEqual(events, ['print', 'print', 'restart', 'print']);
});

test('a print over the time limit is a 504 within 2 s, and the next print succeeds', async () => {
  const { s } = await own({ timeout: 1000 });
  const slow = paperForm({ created: CREATED }, 'index.html');
  // After the limit the page keeps asking for a file it was not given: what it asks must not land in the next print's refusal.
  const html = fs.readFileSync(path.join(FOLDER, 'index.html'), 'utf8').replace('</body>', '<script>for (const end = Date.now() + 1500; Date.now() < end;); setInterval(() => fetch(`late-${Math.random()}.css`), 20);</script></body>');
  slow.append('index.html', new Blob([html]), 'index.html');
  const t0 = performance.now();
  const res = await fetch(`${s.url}/print`, { method: 'POST', body: slow });
  assert.equal(res.status, 504, await res.clone().text());
  assert.ok(performance.now() - t0 < 2000, `${performance.now() - t0} ms`);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('beltype-serve-')), [], 'the timed-out print\'s folder is gone with its answer');
  const again = await fetch(`${s.url}/print`, { method: 'POST', body: paperForm({ created: CREATED }) });
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal((await upTo(s.url)).status, 'up');
});

test('the warm-up works: the first forme write is under 1.5 times the median of the next four', async () => {
  const { s, lines } = await own({});
  const emit: number[] = [];
  for (let i = 0; i < 5; i++) {
    assert.equal((await post(s.url, { 'caster.writer': 'forme' })).status, 200);
    const line = lines.filter((l) => / 200,/.test(l)).at(-1)!;
    emit.push(Number(/\(write ([\d.]+) ms\)/.exec(line)![1]));
  }
  const rest = emit.slice(1).sort((a, b) => a - b);
  const median = (rest[1]! + rest[2]!) / 2;
  console.log(`forme write ms, five prints: ${emit.join(', ')}; median of the last four ${median}`);
  assert.ok(emit[0]! < 1.5 * median, `first ${emit[0]} against median ${median}`);
});

// The kept page (plans/serve-keeps-more-warm): a script-free document re-seats one page, and must give back what a page of its own gives.
// These few lines are testbench's variant generator (src/variants.ts), copied: the same shuffles of the paper's paragraphs.
const BLOCKS = /<(p|li|td|figcaption)\b[^>]*>[\s\S]*?<\/\1>/g;
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function variant(html: string, k: number): string {
  const rand = mulberry32(k);
  return html.replace(BLOCKS, (block) => {
    const parts = block.split(/(<[^>]*>)/);
    const words = parts.filter((_, i) => i % 2 === 0).flatMap((s) => s.match(/\S+/g) ?? []);
    for (let i = words.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [words[i], words[j]] = [words[j]!, words[i]!];
    }
    let n = 0;
    return parts.map((s, i) => (i % 2 === 0 ? s.replace(/\S+/g, () => words[n++]!) : s)).join('');
  });
}
function variantFolder(k: number | null, dir: string): string {
  const folder = path.join(dir, `paper-${k ?? 0}`);
  fs.cpSync(FOLDER, folder, { recursive: true });
  const entry = path.join(folder, path.basename(SAMPLE));
  if (k !== null) fs.writeFileSync(entry, variant(fs.readFileSync(entry, 'utf8'), k));
  return folder;
}

test('keptRoad: a document with a script of its own, or any way to run one, is refused the kept page', () => {
  assert.equal(keptRoad('<html><body><p>hello</p><style>p { color: red }</style></body></html>'), true);
  for (const bad of ['<SCRIPT>1</SCRIPT>', '<iframe src=x>', '<object data=x>', '<embed src=x>', '<frameset>', '<portal src=x>', '<a href="javascript:1">x</a>', '<img src=x onerror = "1">', '<body\nonload=1>', '<svg/onload=1>', '<img src=x"onerror=1>', '<svg><set/onbegin=1>']) assert.equal(keptRoad(bad), false, bad);
  // A JSON-LD data block never runs, so it does not count; only the opening tag with that one attribute, and only up to the first </script, is let through.
  assert.equal(keptRoad('<script type="application/ld+json">{"@graph":[]}</script><p>x</p>'), true);
  assert.equal(keptRoad("<SCRIPT TYPE='application/LD+JSON'>{}</script >"), true);
  assert.equal(keptRoad('<script type="application/ld+json" id="__beltype-store">{}</script><p>x</p>'), true);
  for (const bad of ['<script type="application/ld+json" onload="1">{}</script>', '<script type="application/ld+json">{}</script x><script>1</script>', '<script type="application/ld+json">{}</script><script>1</script>', '<script type="module">1</script>', '<script type="application/ld+json" src="x.js"></script>']) assert.equal(keptRoad(bad), false, bad);
});

test('the kept page gives back, for every document of a sequence, the file a page of its own gives', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-serve-test-'));
  const previous = process.env['SOURCE_DATE_EPOCH'];
  process.env['SOURCE_DATE_EPOCH'] = String(Math.floor(Date.parse(CREATED) / 1000));
  try {
    const { s, lines } = await own({});
    // The paper, then (after the server's own warm-up, which ran first on the same page) five shuffles of it, then the paper again.
    const sequence = [null, 1, 2, 3, 4, 5, null];
    for (const k of sequence) {
      const folder = variantFolder(k, dir);
      const res = await fetch(`${s.url}/print`, { method: 'POST', body: paperForm({ created: CREATED }, undefined, folder) });
      assert.equal(res.status, 200, await res.clone().text());
      const kept = Buffer.from(await res.arrayBuffer());
      const output = path.join(dir, `fresh-${k ?? 0}.pdf`);
      await print(path.join(folder, path.basename(SAMPLE)), output, { given: {}, created: CREATED });
      assert.ok(kept.equals(fs.readFileSync(output)), `paper variant ${k ?? 'itself'}: ${kept.length} bytes on the kept page, ${fs.statSync(output).size} on a page of its own`);
    }
    const roads = lines.filter((l) => / road /.test(l)).map((l) => /road (\w+)/.exec(l)![1]);
    assert.ok(roads.length >= sequence.length && roads.every((r) => r === 'kept'), `roads: ${roads}`);
  } finally {
    if (previous === undefined) delete process.env['SOURCE_DATE_EPOCH']; else process.env['SOURCE_DATE_EPOCH'] = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the kept page survives switching families: warm-up, paper, warm-up, paper, a scripted paper, paper, each equal to its fresh print', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-serve-test-'));
  const previous = process.env['SOURCE_DATE_EPOCH'];
  process.env['SOURCE_DATE_EPOCH'] = String(Math.floor(Date.parse(CREATED) / 1000));
  try {
    const { s, lines } = await own({});
    const warm = path.join(dir, 'warm');
    fs.mkdirSync(warm);
    fs.writeFileSync(path.join(warm, 'index.html'), WARMUP);
    fs.copyFileSync(WARMUP_FONT, path.join(warm, 'warm.woff2'));
    const scripted = path.join(dir, 'scripted');
    fs.cpSync(FOLDER, scripted, { recursive: true });
    fs.writeFileSync(path.join(scripted, 'index.html'), fs.readFileSync(SAMPLE, 'utf8').replace('</body>', '<script>document.title = "scripted";</script></body>'));
    const steps = [warm, FOLDER, warm, FOLDER, scripted, FOLDER];
    for (const [i, folder] of steps.entries()) {
      const res = await fetch(`${s.url}/print`, { method: 'POST', body: paperForm({ created: CREATED }, undefined, folder) });
      assert.equal(res.status, 200, await res.clone().text());
      const served = Buffer.from(await res.arrayBuffer());
      const output = path.join(dir, `fresh-${i}.pdf`);
      await print(path.join(folder, 'index.html'), output, { given: {}, created: CREATED });
      assert.ok(served.equals(fs.readFileSync(output)), `step ${i + 1} (${path.basename(folder)}): ${served.length} bytes served, ${fs.statSync(output).size} on a page of its own`);
    }
    const roads = lines.filter((l) => / road /.test(l)).map((l) => /road (\w+)/.exec(l)![1]);
    assert.deepEqual(roads.slice(-6), ['kept', 'kept', 'kept', 'kept', 'fresh', 'kept']);
  } finally {
    if (previous === undefined) delete process.env['SOURCE_DATE_EPOCH']; else process.env['SOURCE_DATE_EPOCH'] = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a document with a script of its own takes a page of its own, the log says so, and the next script-free print is the kept one', async () => {
  const { s, lines } = await own({});
  const withScript = paperForm({ created: CREATED }, 'index.html');
  withScript.append('index.html', new Blob([fs.readFileSync(SAMPLE, 'utf8').replace('</body>', '<script>document.title = "scripted";</script></body>')]), 'index.html');
  assert.equal((await fetch(`${s.url}/print`, { method: 'POST', body: withScript })).status, 200);
  assert.equal((await post(s.url)).status, 200);
  const roads = lines.filter((l) => / road /.test(l)).map((l) => /road (\w+)/.exec(l)![1]);
  assert.deepEqual(roads.slice(-2), ['fresh', 'kept']);
});

test('a refusal on the kept page (the paper-12 shuffle) is the fresh page\'s, and the next print is still its fresh print\'s bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-serve-test-'));
  try {
    const { s } = await own({});
    const twelve = variantFolder(12, dir);
    const res = await fetch(`${s.url}/print`, { method: 'POST', body: paperForm({ created: CREATED }, undefined, twelve) });
    const status = res.status;
    const text = await res.text();
    const output = path.join(dir, 'twelve.pdf');
    let freshRefusal: string | null = null;
    try { await print(path.join(twelve, path.basename(SAMPLE)), output, { given: {}, created: CREATED }); } catch (error) { freshRefusal = (error as Error).message; }
    console.log('paper-12:', status, freshRefusal === null ? 'prints on a page of its own' : freshRefusal.slice(0, 200));
    if (freshRefusal === null) assert.equal(status, 200, `a page of its own prints it; the kept page said ${status}: ${text}`);
    else { assert.equal(status, 422); assert.equal(text.trim(), freshRefusal.trim()); }
    const next = await post(s.url);
    assert.equal(next.status, 200);
    const again = path.join(dir, 'again.pdf');
    await print(SAMPLE, again, { given: {}, created: CREATED });
    assert.ok(Buffer.from(await next.arrayBuffer()).equals(fs.readFileSync(again)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The server's own warm-up loads warm.woff2 at this very URL, so a second server is as stale as the first and cannot be the control: beltype print's fresh browser is.
test('a document on the kept page prints its own font, though the one before used the same name', { todo: 'Caster keys its shapers by URL (loadHbFont, hbShaper, varShaper) and the module outlives document.open(), so the second font is shaped with the first: the fix is in codeberg.org/BelType/caster' }, async () => {
  const serif = fs.readFileSync(path.join(FOLDER, 'fonts', 'SourceSerif4-Variable.woff2'));
  const doc = (font: Buffer) => {
    const form = new FormData();
    form.append('index.html', new Blob([WARMUP]), 'index.html');
    form.append('warm.woff2', new Blob([new Uint8Array(font)]), 'warm.woff2');
    form.append('caster.writer', 'forme');
    form.append('created', CREATED);
    return form;
  };
  const bytes = async (at: string, font: Buffer) => {
    const res = await fetch(`${at}/print`, { method: 'POST', body: doc(font) });
    assert.equal(res.status, 200, await res.clone().text());
    return Buffer.from(await res.arrayBuffer());
  };
  await bytes(server.url, fs.readFileSync(WARMUP_FONT));
  const after = await bytes(server.url, serif);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beltype-serve-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), WARMUP);
    fs.writeFileSync(path.join(dir, 'warm.woff2'), serif);
    await print(path.join(dir, 'index.html'), path.join(dir, 'fresh.pdf'), { given: { caster: { writer: 'forme' } }, created: CREATED });
    assert.ok(after.equals(fs.readFileSync(path.join(dir, 'fresh.pdf'))), 'the print after another font is the print with this font in a browser of its own');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The door: a page in the user's browser can POST a form here with no preflight, so a request that does not name this server, or comes from another origin, is refused before its body is read.
test('a request with a foreign Host or Origin is a 403, before the body is read', { timeout: 10_000 }, async () => {
  const { port } = new URL(server.url);
  const raw = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/print', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '1000000', ...headers } }, (res) => { res.resume(); req.destroy(); resolve(res.statusCode!); });
    req.on('error', reject);
    req.flushHeaders();
  });
  assert.equal(await raw({ host: 'evil.example:' + port }), 403);
  assert.equal(await raw({ host: `localhost:${port}` }), 403);
  assert.equal(await raw({ origin: 'https://evil.example' }), 403);
  assert.equal(await raw({ origin: 'null' }), 403);
  assert.equal((await fetch(`${server.url}/health`, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${server.url}/health`, { headers: { origin: server.url } })).status, 200);
  assert.equal((await fetch(`${server.url}/health`)).status, 200);
});
