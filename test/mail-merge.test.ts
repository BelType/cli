// A mail merge through beltype serve: one bill template, twenty customers. Each customer's values and meter readings open the template's data block as a graph (prosemirror-stores), the binds compute the days and the consumption, the page's fields are written from the graph, and the filled bill is posted. Every PDF must carry its own customer's name and computed totals and nothing of the bill before it, and every bill shares the kept page, its JSON-LD block notwithstanding.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { parseHTML } from 'linkedom';
import { openBlock } from 'prosemirror-stores/graph';
import { writeMicrodata } from 'prosemirror-stores/microdata';
import { specimen } from '@beltype/specimens';
import { serve } from '../src/serve.ts';

const BILL = fileURLToPath(new URL('./fixtures/bill/', import.meta.url));
const FONTS = path.join(path.dirname(specimen('paper').entry), 'fonts');
const TEMPLATE = fs.readFileSync(path.join(BILL, 'index.html'), 'utf8');
const CUSTOMERS = 20;

const NAMES = ['Paola', 'Marco', 'Giulia', 'Luca', 'Sara', 'Andrea', 'Chiara', 'Matteo', 'Elena', 'Davide'];
const SURNAMES = ['Esempio', 'Prova', 'Campione', 'Modello'];

/** Customer k: their values and their readings, deterministic, a different number of days and a different consumption for each. */
function customer(k: number) {
  const days = 28 + (k % 8);
  const letture = Array.from({ length: days }, (_, i) => {
    const totale = 2 + ((k * 7 + i * 3) % 50) / 10;
    return { giorno: String(i + 1), totale: { value: totale, text: String(totale).replace('.', ',') } };
  });
  const sum = letture.reduce((s, r) => s + r.totale.value, 0);
  return {
    values: {
      cliente: `${NAMES[k % NAMES.length]} ${SURNAMES[k % SURNAMES.length]} ${k + 1}`,
      indirizzo: `Via delle Prove ${k + 1}, Roma`,
      fattura: `2026/${String(1000 + k).padStart(7, '0')}`,
      periodo: `settembre 2026`,
      importo: `${(30 + k * 4.25).toFixed(2).replace('.', ',')}`,
      scadenza: `${String(1 + (k % 28)).padStart(2, '0')}/12/2026`,
    },
    letture,
    days,
    consumo: String(Math.round(sum * 10) / 10).replace('.', ','),
  };
}

/** The template filled for one customer: the block opened with their readings, their values set, the fields written, the block written back. */
function merge(k: number) {
  const c = customer(k);
  const { document } = parseHTML(TEMPLATE);
  const block = document.querySelector('script[type="application/ld+json"]')!;
  const graph = openBlock(block.textContent!, { rows: new Map([['letture.csv', c.letture]]) });
  for (const [key, value] of Object.entries(c.values)) graph.set('#doc', key, value);
  assert.equal(graph.get('#doc', 'giorni'), c.days, 'the bind counted the readings');
  assert.equal(graph.get('#doc', 'consumo'), c.consumo, 'the bind summed the readings');
  assert.equal(writeMicrodata(document.documentElement, graph), 9);
  block.textContent = graph.serialize();
  return { html: document.toString(), ...c };
}

function form(html: string): FormData {
  const body = new FormData();
  body.append('index.html', new Blob([html]), 'index.html');
  body.append('bill.css', new Blob([fs.readFileSync(path.join(BILL, 'bill.css'))]), 'bill.css');
  for (const name of ['SourceSerif4-Variable.woff2', 'SourceSans3-Variable.woff2']) body.append(`fonts/${name}`, new Blob([fs.readFileSync(path.join(FONTS, name))]), name);
  body.append('caster.writer', 'forme');
  return body;
}

const log: string[] = [];
let server: Awaited<ReturnType<typeof serve>>;
before(async () => {
  server = await serve({ host: '127.0.0.1', port: 0, maxUpload: 50 * 1024 * 1024, timeout: 60_000, restartAfter: 100, log: (line) => log.push(line) });
});
after(async () => {
  await server.close();
});

test(`twenty bills merged from one template print each its own customer, all on the kept page`, async (t) => {
  const started = performance.now();
  let previous: string | undefined;
  for (let k = 0; k < CUSTOMERS; k++) {
    const bill = merge(k);
    const res = await fetch(`${server.url}/print`, { method: 'POST', body: form(bill.html) });
    assert.equal(res.status, 200, await res.clone().text());
    const doc = mupdf.Document.openDocument(Buffer.from(await res.arrayBuffer()), 'application/pdf');
    const text = Array.from({ length: doc.countPages() }, (_, i) => doc.loadPage(i).toStructuredText('').asText()).join('\n');
    assert.equal(doc.countPages(), 1, `bill ${k + 1} is one page`);
    assert.equal(text.split(bill.values.cliente).length - 1, 2, `bill ${k + 1} names its customer twice`);
    for (const words of [`Bolletta n. ${bill.values.fattura}`, bill.values.indirizzo, `${bill.consumo} kWh`, `${bill.values.importo} EUR`, bill.values.scadenza]) assert.ok(text.includes(words), `bill ${k + 1} holds "${words}"`);
    assert.match(text, new RegExp(`Giorni di lettura\\s+${bill.days}\\b`), `bill ${k + 1} holds its days`);
    assert.ok(!text.includes('Nome Cognome'), `bill ${k + 1} has no field left unwritten`);
    if (previous !== undefined) assert.ok(!text.includes(previous), `bill ${k + 1} holds nothing of the bill before it`);
    previous = bill.values.cliente;
  }
  const roads = log.filter((l) => / road /.test(l)).map((l) => /road (\w+)/.exec(l)![1]);
  assert.deepEqual(roads.slice(-CUSTOMERS), Array(CUSTOMERS).fill('kept'), 'every bill shared the kept page');
  t.diagnostic(`${CUSTOMERS} bills in ${Math.round(performance.now() - started)} ms, merge and print`);
});
