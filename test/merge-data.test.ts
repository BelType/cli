// A mail merge sent as data: one template uploaded once, each customer's values and rows as JSON, on the same page. The file's own server is asked for the kept road, whose telling of changed boxes most of these tests are about; the default road, seated, and the fresh one are set against it at the end. Each PDF must be the one the folder route prints for that customer's merged document, byte for byte, in any order of customers, so nothing of the customer before can be left in it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as mupdf from 'mupdf';
import { parseHTML } from 'linkedom';
import { openBlock } from 'prosemirror-stores/graph';
import { writeMicrodata } from 'prosemirror-stores/microdata';
import { serve, WARMUP_FONT } from '../src/serve.ts';
import { CREATED, TEMPLATE, table, billForm } from './bolletta.ts';
import { timing, wholeHoldsParts } from './server-timing.ts';

const readings = table('letture.csv');
const customers = table('clienti.csv').map((row) => {
  const values = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? v : v.text]));
  const rows = readings.filter((r) => r['codice'] === row['codice']).map(({ codice: _, ...r }) => r);
  return { values, rows: { letture: rows } };
});

/** The merged document in node, as a caller of the folder route makes it. */
function mergedHtml(c: (typeof customers)[number]): string {
  const { document } = parseHTML(TEMPLATE);
  const block = document.getElementById('__beltype-store')!;
  const graph = openBlock(block.textContent!, { rows: new Map([['letture.csv', c.rows.letture]]) });
  for (const [key, value] of Object.entries(c.values)) graph.set('#doc', key, value);
  const inert = { tag: (el: Element) => el.localName, attribute: (el: Element, n: string) => el.getAttribute(n), children: (el: Element) => (el.localName === 'template' ? [] : Array.from(el.children)), text: (el: Element) => el.textContent, setAttribute: (el: Element, n: string, v: string) => el.setAttribute(n, v), setText: (el: Element, t: string) => { el.textContent = t; } };
  (writeMicrodata as unknown as (root: Element, graph: unknown, writer: unknown) => number)(document.documentElement, graph, inert);
  const repeat = document.querySelector('template[data-repeat]')!;
  for (const cells of c.rows.letture) {
    const row = repeat.children[0]!.cloneNode(true) as Element;
    row.setAttribute('itemscope', '');
    row.setAttribute('itemprop', 'letture');
    for (const field of Array.from(row.querySelectorAll('[itemprop]'))) {
      const cell = cells[field.getAttribute('itemprop')!];
      if (cell === undefined) continue;
      if (field.localName === 'data') field.setAttribute('value', typeof cell === 'string' ? cell : String(cell.value));
      if (field.localName !== 'data' || typeof cell !== 'string') field.textContent = typeof cell === 'string' ? cell : cell.text;
    }
    repeat.before(row);
  }
  repeat.remove();
  block.remove();
  return document.toString();
}

const log: string[] = [];
let server: Awaited<ReturnType<typeof serve>>;
before(async () => {
  server = await serve({ host: '127.0.0.1', port: 0, maxUpload: 50 * 1024 * 1024, timeout: 60_000, restartAfter: 1000, mergeRoad: 'kept', log: (line) => log.push(line) });
});
after(async () => {
  await server.close();
});

const upload = async (form: FormData) => {
  const res = await fetch(`${server.url}/templates`, { method: 'POST', body: form });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { template: string }).template;
};
const printData = (template: string, body: unknown) => fetch(`${server.url}/templates/${template}/print`, { method: 'POST', body: JSON.stringify(body) });
const bytes = async (res: Response) => {
  assert.equal(res.status, 200, await res.clone().text());
  return Buffer.from(await res.arrayBuffer());
};
const roads = () => log.filter((l) => / road /.test(l)).map((l) => /road ([a-z ]+);/.exec(l)![1]);
const pdfText = (pdf: Buffer) => {
  const doc = mupdf.Document.openDocument(pdf, 'application/pdf');
  return Array.from({ length: doc.countPages() }, (_, i) => doc.loadPage(i).toStructuredText('').asText()).join('\n');
};

test('every customer from data is the folder route PDF, byte for byte, in any order, on the kept page', async () => {
  assert.ok(new Set(customers.map((c) => c.rows.letture.length)).size > 1, 'the customers differ in their number of rows');
  const folder: Buffer[] = [];
  for (const c of customers) folder.push(await bytes(await fetch(`${server.url}/print`, { method: 'POST', body: billForm(mergedHtml(c)) })));
  const template = await upload(billForm(TEMPLATE));
  assert.equal(await upload(billForm(TEMPLATE)), template, 'uploading it again is the same template');
  const order = [...customers.keys(), ...customers.keys()].reverse();
  order.splice(3, 0, order[3]!); // one customer twice in a row: nothing changed
  log.length = 0;
  for (const k of order) {
    const pdf = await bytes(await printData(template, { ...customers[k], created: CREATED }));
    assert.ok(pdf.equals(folder[k]!), `customer ${k} differs from the folder route`);
  }
  assert.deepEqual(roads(), ['merge seated', ...order.slice(1).map(() => 'merge kept')]);
});

test('Server-Timing on the data route: the first customer seats the template, the second keeps it, the parts within the whole', async () => {
  const template = await upload(billForm(TEMPLATE));
  await bytes(await fetch(`${server.url}/print`, { method: 'POST', body: billForm(mergedHtml(customers[0]!)) }));
  const roads: string[] = [];
  for (const c of customers.slice(0, 2)) {
    const res = await printData(template, { ...c, created: CREATED });
    await bytes(res);
    const metrics = timing(res.headers.get('server-timing'));
    roads.push(metrics[0]!.desc!);
    const names = metrics.filter((m) => !/^(print|caster)-/.test(m.name)).map((m) => m.name);
    assert.deepEqual(names, roads.length === 1 ? ['road', 'read', 'queue', 'page', 'load', 'merge', 'cut', 'print', 'total'] : ['road', 'read', 'queue', 'page', 'merge', 'cut', 'print', 'total']);
    wholeHoldsParts(metrics);
  }
  assert.deepEqual(roads, ['merge seated', 'merge kept']);
});

test('a folder print between two customers seats the template again', async () => {
  const template = await upload(billForm(TEMPLATE));
  const c = customers[0]!;
  const first = await bytes(await printData(template, { ...c, created: CREATED }));
  await bytes(await fetch(`${server.url}/print`, { method: 'POST', body: billForm(mergedHtml(customers[1]!)) }));
  log.length = 0;
  assert.ok((await bytes(await printData(template, { ...c, created: CREATED }))).equals(first));
  assert.deepEqual(roads(), ['merge seated']);
});

const small = (body: string, head = '') => {
  const form = new FormData();
  form.append('index.html', new Blob([`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Small</title>${head}<style>@font-face { font-family: Warm; src: url(warm.woff2) format("woff2"); font-weight: 200 900 } @page { size: A4; margin: 20mm } body { font: 11pt/1.4 Warm }</style></head><body itemscope itemid="#doc">${body}<script type="application/ld+json">{ "@graph": [ { "@id": "#doc", "nome": "", "righe": { "@type": "csvw:Table", "csvw:url": "righe.csv" } } ] }</script></body></html>`]), 'index.html');
  form.append('warm.woff2', new Blob([fs.readFileSync(WARMUP_FONT)]), 'warm.woff2');
  form.append('caster.writer', 'forme');
  return form;
};

test('rows at the top of the body change its shape: the template is seated again, and the log says why', async () => {
  const template = await upload(small('<p itemprop="nome"></p><template data-repeat="righe"><p><span itemprop="testo"></span></p></template>'));
  log.length = 0;
  const one = pdfText(await bytes(await printData(template, { values: { nome: 'Prima' }, rows: { righe: [{ testo: 'riga-a' }] } })));
  const two = pdfText(await bytes(await printData(template, { values: { nome: 'Seconda' }, rows: { righe: [{ testo: 'riga-b' }, { testo: 'riga-c' }] } })));
  assert.match(one, /Prima[\s\S]*riga-a/);
  assert.match(two, /Seconda[\s\S]*riga-b[\s\S]*riga-c/);
  assert.ok(!/Prima|riga-a/.test(two), 'nothing of the customer before');
  assert.deepEqual(roads(), ['merge seated', 'merge seated']);
  assert.ok(log.some((l) => l.includes('the top-level boxes went from 2 to 3')), log.join('\n'));
});

test('a field in the head is never kept: every customer is seated', async () => {
  const template = await upload(small('<p itemprop="nome"></p>', '<meta itemprop="nome" content="">'));
  log.length = 0;
  for (const nome of ['Prima', 'Seconda']) assert.match(pdfText(await bytes(await printData(template, { values: { nome }, created: CREATED }))), new RegExp(nome));
  assert.deepEqual(roads(), ['merge seated', 'merge seated']);
  assert.ok(log.some((l) => l.includes('a field stands in the head')));
});

test('the door refuses by name', async () => {
  const template = await upload(billForm(TEMPLATE));
  const missing = await printData('00', { values: {} });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /no template 00; POST its folder/);
  const notJson = await fetch(`${server.url}/templates/${template}/print`, { method: 'POST', body: '{' });
  assert.equal(notJson.status, 400);
  assert.match(await notJson.text(), /the body does not parse/);
  const badValues = await printData(template, { values: { a: {} } });
  assert.equal(badValues.status, 400);
  assert.match(await badValues.text(), /"values" is an object of strings/);
  const badTable = await printData(template, { values: {}, rows: { nessuna: [] } });
  assert.equal(badTable.status, 422);
  assert.match(await badTable.text(), /the data names a table "nessuna", and the block has letture/);
  const scripted = new FormData();
  scripted.append('index.html', new Blob(['<!doctype html><script>1</script><script type="application/ld+json">{}</script>']), 'index.html');
  const refused = await fetch(`${server.url}/templates`, { method: 'POST', body: scripted });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /a template holds no script of its own/);
  const blockless = new FormData();
  blockless.append('index.html', new Blob(['<!doctype html><p>no block</p>']), 'index.html');
  const none = await fetch(`${server.url}/templates`, { method: 'POST', body: blockless });
  assert.equal(none.status, 400);
  assert.match(await none.text(), /has a data block/);
  // A refused customer closes the kept page; the next one is seated and prints.
  log.length = 0;
  const after = await printData(template, { ...customers[0], created: CREATED });
  assert.equal(after.status, 200);
  assert.deepEqual(roads(), ['merge seated']);
});

test('the three roads give the same bytes, and seated is the road of a server asked for none', async () => {
  const kept = await upload(billForm(TEMPLATE));
  const order = [2, 0, 1, 1, 0];
  const want: Buffer[] = [];
  for (const k of order) want.push(await bytes(await printData(kept, { ...customers[k], created: CREATED })));
  for (const [asked, mergeRoad] of [[{}, 'seated'], [{ mergeRoad: 'fresh' }, 'fresh']] as const) {
    const other = await serve({ host: '127.0.0.1', port: 0, maxUpload: 50 * 1024 * 1024, timeout: 60_000, restartAfter: 1000, ...asked, log: () => {} });
    try {
      const made = await fetch(`${other.url}/templates`, { method: 'POST', body: billForm(TEMPLATE) });
      const { template } = (await made.json()) as { template: string };
      for (const [n, k] of order.entries()) {
        const res = await fetch(`${other.url}/templates/${template}/print`, { method: 'POST', body: JSON.stringify({ ...customers[k], created: CREATED }) });
        assert.ok((await bytes(res)).equals(want[n]!), `customer ${k} on the ${mergeRoad} road differs from the kept road`);
        const metrics = timing(res.headers.get('server-timing'));
        assert.equal(metrics[0]!.desc, `merge ${mergeRoad}`);
        assert.equal(metrics.some((m) => m.name === 'close'), mergeRoad === 'fresh');
        wholeHoldsParts(metrics);
      }
    } finally {
      await other.close();
    }
  }
});

test('a page number read in a box no customer changes is the customer\'s own on the seated and the fresh road', async () => {
  // On the kept road it is the number of the customer the box was last made for: Caster makes the pseudo-element a real element after the cut, and the merge sees a box that did not change (measured 2026-11-18; the README's `--merge-road` says so).
  const toc = (road: 'seated' | 'fresh') => serve({ host: '127.0.0.1', port: 0, maxUpload: 50 * 1024 * 1024, timeout: 60_000, restartAfter: 1000, mergeRoad: road, log: () => {} });
  const rows = (n: number) => ({ righe: Array.from({ length: n }, (_, i) => ({ testo: `riga ${i + 1}` })) });
  for (const road of ['seated', 'fresh'] as const) {
    const other = await toc(road);
    try {
      const made = await fetch(`${other.url}/templates`, { method: 'POST', body: small('<p class="toc"><a href="#end">The end</a></p><p itemprop="nome"></p><section><template data-repeat="righe"><p><span itemprop="testo"></span></p></template></section><h2 id="end">End</h2>', '<style>.toc a::after { content: " at page " target-counter(attr(href), page) }</style>') });
      const { template } = (await made.json()) as { template: string };
      const at: string[] = [];
      for (const n of [2, 200, 3]) at.push(/The end at page \d+/.exec(pdfText(await bytes(await fetch(`${other.url}/templates/${template}/print`, { method: 'POST', body: JSON.stringify({ values: { nome: `Cliente ${n}` }, rows: rows(n) }) }))))?.[0] ?? 'no line');
      assert.equal(at[0], 'The end at page 1', road);
      assert.notEqual(at[1], 'The end at page 1', `${road}: the second customer's end is pages later`);
      assert.equal(at[2], 'The end at page 1', road);
    } finally {
      await other.close();
    }
  }
});
