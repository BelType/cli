// The provvedimento-imu as data: five copies of four notices, each merged in the tab from the specimen's own tables. The oracle is batch.html, the specimen's hand-checked print run: each copy, alone in the template's head, through the folder route. The PDF from data must match it pixel for pixel, in any order, with nothing left of the copy before.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { specimen } from '@beltype/specimens';
import { serve } from '../src/serve.ts';
import { rasterize, type Raster } from '../src/compare.ts';
import type { Cell } from '../src/merge-tab.ts';

const CREATED = '2026-11-07T00:00:00.000Z';
const DIR = specimen('provvedimento-imu').dir;
const TEMPLATE = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const BATCH = fs.readFileSync(path.join(DIR, 'batch.html'), 'utf8');

type Row = Record<string, Cell>;
function table(name: string): Row[] {
  const file = path.join(DIR, 'merge', `${name}.csv`);
  const meta = JSON.parse(fs.readFileSync(`${file}-metadata.json`, 'utf8')) as { tableSchema: { columns: { name: string; datatype?: { base?: string; format?: { decimalChar?: string; groupChar?: string } } }[] } };
  const columns = new Map(meta.tableSchema.columns.map((c) => [c.name, c.datatype]));
  const [head, ...lines] = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => l.split(';'));
  return lines.map((cells) => Object.fromEntries(head!.map((column, i): [string, Cell] => {
    const text = cells[i] ?? '';
    const type = columns.get(column);
    if (type?.base !== 'decimal' || text === '') return [column, text];
    return [column, { value: Number(text.split(type.format?.groupChar ?? '\0').join('').replace(type.format?.decimalChar ?? '.', '.')), text }];
  })));
}

const flat = (row: Row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? v : v.text]));
const TABLES = ['immobili', 'versamenti', 'interessi', 'sanzioni', 'eredi'];
const avvisi = table('avvisi');
const tables = Object.fromEntries(TABLES.map((name) => [name, table(name)]));
const copies = table('destinatari').map((copy) => {
  const notice = copy['avviso'];
  const values = { ...flat(avvisi.find((a) => a['avviso'] === notice)!), ...flat(copy) };
  const rows = Object.fromEntries(TABLES.map((name) => [name, tables[name]!.filter((r) => r['avviso'] === notice).map(({ avviso: _, ...r }) => r)]));
  return { values, rows };
});

const head = BATCH.slice(0, BATCH.indexOf('<article '));
const articles = BATCH.split(/(?=<article )/).slice(1).map((a) => a.slice(0, a.indexOf('</article>') + '</article>'.length));

const assets = fs.readdirSync(DIR, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(DIR, path.join(e.parentPath, e.name)).split(path.sep).join('/')).filter((n) => !['index.html', 'batch.html'].includes(n) && !n.startsWith('merge/') && !n.includes('.csv'));
function form(html: string): FormData {
  const f = new FormData();
  f.append('index.html', new Blob([html]), 'index.html');
  for (const name of assets) f.append(name, new Blob([fs.readFileSync(path.join(DIR, name))]), path.basename(name));
  f.append('caster.writer', 'forme');
  f.append('created', CREATED);
  return f;
}

const log: string[] = [];
let server: Awaited<ReturnType<typeof serve>>;
before(async () => {
  server = await serve({ host: '127.0.0.1', port: 0, maxUpload: 50 * 1024 * 1024, timeout: 60_000, restartAfter: 1000, log: (line) => log.push(line) });
});
after(async () => {
  await server.close();
});
const bytes = async (res: Response) => {
  assert.equal(res.status, 200, await res.clone().text());
  return Buffer.from(await res.arrayBuffer());
};
const samePixels = (a: readonly Raster[], b: readonly Raster[]) => a.length === b.length && a.every((r, i) => Buffer.compare(Buffer.from(r.rgb), Buffer.from(b[i]!.rgb)) === 0);

test('every copy from data matches batch.html pixel for pixel, in any order', async () => {
  assert.equal(copies.length, articles.length);
  const oracle: Raster[][] = [];
  for (const article of articles) oracle.push(rasterize(await bytes(await fetch(`${server.url}/print`, { method: 'POST', body: form(`${head}${article}</body></html>`) }))).pages);
  const uploaded = await fetch(`${server.url}/templates`, { method: 'POST', body: form(TEMPLATE) });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const { template } = (await uploaded.json()) as { template: string };
  log.length = 0;
  // Its running elements are lifted out of its one top-level box, so Cicero will not promise a patch and most of these are seated again; the road may improve, the pixels may not move.
  const order = [0, 1, 2, 3, 4, 4, 2, 0, 3, 1];
  for (const k of order) {
    const pdf = await bytes(await fetch(`${server.url}/templates/${template}/print`, { method: 'POST', body: JSON.stringify({ ...copies[k], created: CREATED }) }));
    assert.ok(samePixels(rasterize(pdf).pages, oracle[k]!), `copy ${k} (step ${order.indexOf(k)}) differs from its article in batch.html\n${log.slice(-6).join('\n')}`);
  }
});
