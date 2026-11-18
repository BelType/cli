// The mail merge's soak: seeded customers with varied row counts, each printed on the three merge roads (`kept`, `seated`, `fresh`), and every PDF set against the one the same customer gets on a page of their own. Not a test of `npm test`: it runs minutes. `node test/soak-merge.ts [--customers 200] [--workers 3] [--clients 6] [--seed 1] [--keep-fonts]`.
//
// Two parts. One at a time: every customer on each road in a rotating order, one worker each, so the roads' times are a paired comparison under the same load, and the fresh road's bytes are the reference. Then under load: each road with several workers and clients, every customer twice in a shuffled order, a folder print of another document thrown in now and then, a browser restart every hundred prints, each PDF against the reference. It exits 1 on any difference.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { serve, WARMUP, WARMUP_FONT, type MergeRoad } from '../src/serve.ts';
import { CREATED, TEMPLATE, table, billForm } from './bolletta.ts';
import { timing } from './server-timing.ts';

const { values: args } = parseArgs({ options: { customers: { type: 'string', default: '200' }, workers: { type: 'string', default: '3' }, clients: { type: 'string', default: '6' }, seed: { type: 'string', default: '1' }, 'keep-fonts': { type: 'boolean' }, replay: { type: 'string' } } });
const N = Number(args.customers);
const WORKERS = Number(args.workers);
const CLIENTS = Number(args.clients);
const keepFonts = args['keep-fonts'] === true;

/** mulberry32: the same customers and the same order for the same seed. */
const prng = (a: number) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const random = prng(Number(args.seed));
const below = (n: number) => Math.floor(random() * n);

const readings = table('letture.csv').map(({ codice: _, ...row }) => row);
const people = table('clienti.csv').map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? v : v.text])));
/** A customer: a specimen customer's values with a name, an address, an invoice and an amount of their own, and a run of readings of any length, none included. */
const customers = Array.from({ length: N }, (_, i) => {
  const rows = random() < 0.05 ? 0 : 1 + below(120);
  const from = below(readings.length);
  return { values: { ...people[below(people.length)]!, cliente: `Cliente ${i} di ${N}`, indirizzo: `Via della Prova ${i + 1}`, fattura: `2026/${String(i).padStart(7, '0')}`, importo: `${100 + i},${String(below(100)).padStart(2, '0')} €` }, rows: { letture: Array.from({ length: rows }, (_, r) => readings[(from + r) % readings.length]!) }, created: CREATED };
});

const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
const summary = (ms: number[]) => { const s = [...ms].sort((a, b) => a - b); return { n: s.length, median: Math.round(quantile(s, 0.5)), q1: Math.round(quantile(s, 0.25)), q3: Math.round(quantile(s, 0.75)), mean: Math.round(s.reduce((t, v) => t + v, 0) / s.length) }; };

async function open(mergeRoad: MergeRoad, workers: number, restartAfter: number) {
  const server = await serve({ host: '127.0.0.1', port: 0, maxUpload: 50 * 1024 * 1024, timeout: 120_000, restartAfter, workers, mergeRoad, keepFonts, log: () => {} });
  const made = await fetch(`${server.url}/templates`, { method: 'POST', body: billForm(TEMPLATE) });
  const { template } = (await made.json()) as { template: string };
  const print = async (k: number) => {
    const t0 = performance.now();
    const res = await fetch(`${server.url}/templates/${template}/print`, { method: 'POST', body: JSON.stringify(customers[k]) });
    const bytes = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200) throw new Error(`customer ${k} on the ${mergeRoad} road: ${res.status} ${bytes.toString('utf8')}`);
    const metrics = timing(res.headers.get('server-timing'));
    return { bytes, pages: Number(res.headers.get('x-beltype-pages')), wall: performance.now() - t0, road: metrics[0]!.desc!, steps: Object.fromEntries(metrics.filter((m) => m.dur !== undefined).map((m) => [m.name, m.dur!])) };
  };
  const folder = async () => {
    const form = new FormData();
    form.append('index.html', new Blob([WARMUP]), 'index.html');
    form.append('warm.woff2', new Blob([fs.readFileSync(WARMUP_FONT)]), 'warm.woff2');
    form.append('caster.writer', 'forme');
    const res = await fetch(`${server.url}/print`, { method: 'POST', body: form });
    await res.arrayBuffer();
    if (res.status !== 200) throw new Error(`a folder print on the ${mergeRoad} road: ${res.status}`);
  };
  return { print, folder, close: () => server.close() };
}

const differences: string[] = [];
const reference: string[] = [];
const differs = (where: string, k: number, bytes: Buffer) => {
  if (sha(bytes) === reference[k]) return;
  const file = `${fs.mkdtempSync('/tmp/soak-merge-')}/customer-${k}.pdf`;
  fs.writeFileSync(file, bytes);
  differences.push(`${where}: customer ${k} (${customers[k]!.rows.letture.length} rows) differs from their fresh page; kept at ${file}`);
};

// `--replay 18,19`: those customers in that order on the kept road, each on a fresh page too, with their rows and pages, and both files written where they differ. The customers are those of the same `--customers` and `--seed`.
if (args.replay) {
  const order = args.replay.split(',').map(Number);
  const [keptRoad, freshRoad] = [await open('kept', 1, 1_000_000), await open('fresh', 1, 1_000_000)];
  const dir = fs.mkdtempSync('/tmp/soak-replay-');
  for (const k of order) {
    const [onKept, onFresh] = [await keptRoad.print(k), await freshRoad.print(k)];
    const same = onKept.bytes.equals(onFresh.bytes);
    console.log(`customer ${k}: ${customers[k]!.rows.letture.length} rows, ${onKept.pages} pages kept and ${onFresh.pages} fresh, ${onKept.road}, ${same ? 'the same bytes' : 'DIFFERS'}`);
    if (!same) { fs.writeFileSync(`${dir}/kept-${k}.pdf`, onKept.bytes); fs.writeFileSync(`${dir}/fresh-${k}.pdf`, onFresh.bytes); }
  }
  await Promise.all([keptRoad.close(), freshRoad.close()]);
  console.log(dir);
  process.exit(0);
}

// One at a time: the three roads in a rotating order, the fresh road's bytes the reference.
const ROADS: MergeRoad[] = ['kept', 'seated', 'fresh'];
const one = Object.fromEntries(await Promise.all(ROADS.map(async (road) => [road, await open(road, 1, 1_000_000)] as const)));
const walls: Record<string, number[]> = { kept: [], seated: [], fresh: [] };
const steps: Record<string, Record<string, number[]>> = { kept: {}, seated: {}, fresh: {} };
const taken: Record<string, Record<string, number>> = { kept: {}, seated: {}, fresh: {} };
const held: Record<string, Buffer> = {};
for (let k = 0; k < N; k++) {
  for (let r = 0; r < 3; r++) {
    const road = ROADS[(k + r) % 3]!;
    const printed = await one[road]!.print(k);
    held[road] = printed.bytes;
    taken[road]![printed.road] = (taken[road]![printed.road] ?? 0) + 1;
    if (k < 3) continue; // the first prints warm each road
    walls[road]!.push(printed.wall);
    for (const [name, ms] of Object.entries(printed.steps)) (steps[road]![name] ??= []).push(ms);
  }
  reference[k] = sha(held['fresh']!);
  differs('one at a time, kept', k, held['kept']!);
  differs('one at a time, seated', k, held['seated']!);
}
await Promise.all(ROADS.map((road) => one[road]!.close()));
if (new Set(reference).size !== N) throw new Error('two customers print the same bytes, so the comparison could not tell them apart');
console.log(`one at a time, ${N} customers, rows ${Math.min(...customers.map((c) => c.rows.letture.length))} to ${Math.max(...customers.map((c) => c.rows.letture.length))}${keepFonts ? ', --keep-fonts' : ''}`);
for (const road of ROADS) {
  const names = ['page', 'load', 'merge', 'cut', 'print', 'close', 'total'].filter((n) => steps[road]![n]);
  console.log(`  ${road}: ${JSON.stringify(summary(walls[road]!))} ms a bill at the client; the server's steps, median: ${names.map((n) => `${n} ${summary(steps[road]![n]!).median}`).join(', ')}; roads taken ${JSON.stringify(taken[road])}`);
}

// Under load: several workers and clients, every customer twice in a shuffled order, a folder print now and then, a restart every hundred prints, each road twice in a mirrored order so that none has the quieter half of the run.
for (const road of ['kept', 'seated', 'fresh', 'fresh', 'seated', 'kept'] as const) {
  const server = await open(road, WORKERS, 100);
  const jobs = [...customers.keys(), ...customers.keys()];
  for (let i = jobs.length - 1; i > 0; i--) { const j = below(i + 1); [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!]; }
  const roads: Record<string, number> = {};
  let next = 0;
  let folders = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CLIENTS }, async () => {
    while (next < jobs.length) {
      const n = next++;
      if (n % 25 === 24) { await server.folder(); folders++; }
      const k = jobs[n]!;
      const printed = await server.print(k);
      roads[printed.road] = (roads[printed.road] ?? 0) + 1;
      differs(`under load, ${road}`, k, printed.bytes);
    }
  }));
  const seconds = (performance.now() - t0) / 1000;
  await server.close();
  console.log(`under load, ${road}: ${jobs.length} bills and ${folders} folder prints, ${WORKERS} workers, ${CLIENTS} clients, ${Math.round(seconds)} s, ${Math.round((jobs.length / seconds) * 60)} bills a minute; roads taken ${JSON.stringify(roads)}`);
}

console.log(differences.length ? `${differences.length} differences:\n${differences.join('\n')}` : 'no bill differs from the same customer on a page of their own');
process.exit(differences.length ? 1 : 0);
