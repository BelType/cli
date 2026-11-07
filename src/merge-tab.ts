/**
 * The mail merge inside the tab: a template's data block opened with one customer's values and rows, its fields written, each `<template data-repeat>` filled.
 *
 * @remarks
 * This file is bundled with `prosemirror-stores` into `assets/merge/merge.js` by `scripts/bundle-merge.ts`, and the page imports that bundle by URL; a change here means running the script. `test/merge-bundle.test.ts` holds the two together.
 *
 * **Two roads.** {@link seat} merges into the document just written into the page. {@link keep} merges into a detached copy of the template and replaces only the top-level boxes that differ from the last customer's, through Cicero's patch door, so the sheets, the faces and the unchanged boxes stay. Its answer `{ again }` asks the host to seat the template afresh, and names why: a merge that changes the shape of the body, or that Cicero will not promise, is never forced.
 *
 * What it does not do: it reads no CSVW. A table's cells arrive typed as `openBlock` takes them, a string or `{ value, text }`.
 *
 * @see codeberg.org/BelType/cli issue 2
 * @packageDocumentation
 */

import { openBlock } from 'prosemirror-stores/graph';
import { writeMicrodata } from 'prosemirror-stores/microdata';

/** A table's cell: a string, or a typed value and the text it shows. */
export type Cell = string | { value: number | boolean; text: string };

/** One customer: the values of the document's item, and the rows of each table by the name its `<template data-repeat>` and its block use. */
export type MergeData = { values: Record<string, string | number | boolean>; rows: Record<string, Record<string, Cell>[]> };

/** What {@link keep} answers: the address a resumed run starts from (none when nothing changed), or why the template must be seated again. */
export type KeepAnswer = { resumeAt: unknown; changed: number } | { again: string };

type Snapshot = { boxes: string[]; text: string };

const BLOCK = 'script[type="application/ld+json"]';
/** What Caster's preparation stamps on an element, and Cicero's patch door compares on a top-level box. */
const SOURCE = 'data-pdf-source';

let template = '';
let last: Snapshot = { boxes: [], text: '' };
let unkept: string | null = null;

/** The table names of a block, each with the `csvw:url` its rows are handed to `openBlock` under. */
function tablesOf(text: string): Map<string, string> {
  const tables = new Map<string, string>();
  const graph = (JSON.parse(text) as { '@graph'?: Record<string, unknown>[] })['@graph'] ?? [];
  for (const node of graph) {
    for (const [key, value] of Object.entries(node)) {
      const table = value as { '@type'?: unknown; 'csvw:url'?: unknown } | null;
      if (table?.['@type'] === 'csvw:Table' && typeof table['csvw:url'] === 'string') tables.set(key, table['csvw:url']);
    }
  }
  return tables;
}

/** The fields of one repeated row. */
function writeRow(row: Element, cells: Record<string, Cell>): void {
  for (const field of row.querySelectorAll('[itemprop]')) {
    const cell = cells[field.getAttribute('itemprop') as string];
    if (cell === undefined) continue;
    const shown = typeof cell === 'string' ? cell : cell.text;
    if (field.localName === 'data') field.setAttribute('value', typeof cell === 'string' ? cell : String(cell.value));
    if (field.localName !== 'data' || typeof cell !== 'string') field.textContent = shown;
  }
}

/**
 * Merge `data` into `doc`: the graph opened on the block, the values set on the document's item, the fields written, the templates replaced by their rows, the block gone.
 *
 * @throws {Error} Where the document has no block or no item, or `data` names a table the block does not.
 */
function merge(doc: Document, data: MergeData): void {
  const block = doc.querySelector(BLOCK);
  if (!block) throw new Error('the template has no data block (<script type="application/ld+json">)');
  const item = doc.querySelector('[itemscope][itemid]:not([itemprop])')?.getAttribute('itemid');
  if (!item) throw new Error('the template has no top-level item (an element with itemscope and itemid, and no itemprop)');
  const text = block.textContent as string;
  const tables = tablesOf(text);
  for (const name of Object.keys(data.rows)) if (!tables.has(name)) throw new Error(`the data names a table "${name}", and the block has ${[...tables.keys()].join(', ') || 'none'}`);
  const graph = openBlock(text, { rows: new Map([...tables].map(([name, url]) => [url, data.rows[name] ?? []])) });
  for (const [key, value] of Object.entries(data.values)) graph.set(item, key, value);
  writeMicrodata(doc.documentElement, graph);
  for (const repeat of [...doc.querySelectorAll('template[data-repeat]')] as HTMLTemplateElement[]) {
    const name = repeat.getAttribute('data-repeat') as string;
    const rowElement = repeat.content.firstElementChild;
    if (rowElement) {
      for (const cells of data.rows[name] ?? []) {
        const row = rowElement.cloneNode(true) as Element;
        row.setAttribute('itemscope', '');
        row.setAttribute('itemprop', name);
        writeRow(row, cells);
        repeat.before(row);
      }
    }
    repeat.remove();
  }
  block.remove();
}

const snapshot = (doc: Document): Snapshot => ({
  boxes: [...doc.body.children].map((box) => box.outerHTML),
  text: [...doc.body.childNodes].filter((node) => node.nodeType === 3).map((node) => (node as Text).data.trim()).join(''),
});

/**
 * The first customer on a seated document: `html` is the template as it was uploaded, kept for the customers after.
 *
 * @throws {Error} From {@link merge}.
 */
export function seat(html: string, data: MergeData): void {
  template = html;
  merge(document, data);
  last = snapshot(document);
  // The patch door numbers the boxes the engine took, and nothing keeps a field in the head up to date: a document like this is seated for every customer.
  unkept = document.head.querySelector('[itemprop]') ? 'a field stands in the head' : document.body.querySelector(':scope > :is(script, style, template, link, meta)') ? 'the body holds a child that is no box' : null;
}

/**
 * A later customer on the document already presented.
 *
 * @throws {Error} From {@link merge}.
 */
export function keep(data: MergeData): KeepAnswer {
  if (unkept) return { again: unkept };
  const handle = (window as unknown as { __beltypeCicero?: { box?(i: number): Element | null; patch?(i: number, path: number[], el: Element): unknown } }).__beltypeCicero;
  if (!handle?.box || !handle.patch) return { again: 'the page shows no presented run' };
  const copy = new DOMParser().parseFromString(template, 'text/html');
  merge(copy, data);
  const next = snapshot(copy);
  if (next.boxes.length !== last.boxes.length) return { again: `the top-level boxes went from ${last.boxes.length} to ${next.boxes.length}` };
  if (next.text !== last.text) return { again: 'text directly in the body changed' };
  const fresh = [...copy.body.children];
  let resumeAt: unknown = null;
  let changed = 0;
  for (const [i, box] of fresh.entries()) {
    if (next.boxes[i] === last.boxes[i]) continue;
    const old = handle.box(i);
    if (!old) return { again: `box ${i} is no flow block` };
    const stamp = old.getAttribute(SOURCE);
    if (stamp !== null) box.setAttribute(SOURCE, stamp);
    const address = handle.patch(i, [], document.adoptNode(box));
    if (address === null) return { again: `Cicero's patch door refused box ${i}` };
    resumeAt ??= address;
    changed++;
  }
  last = next;
  return { resumeAt, changed };
}
