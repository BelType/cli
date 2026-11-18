// The bolletta specimen as a mail merge's template: its folder, its tables typed, and the form either route takes. Shared by the merge's tests and its soak.

import fs from 'node:fs';
import path from 'node:path';
import { specimen } from '@beltype/specimens';
import type { Cell } from '../src/merge-tab.ts';

export const CREATED = '2026-11-07T00:00:00.000Z';
export const BILL = specimen('bolletta').dir;
export const TEMPLATE = fs.readFileSync(path.join(BILL, 'index.html'), 'utf8');

/** A table from the specimen's `merge/`, each decimal column typed by the CSVW metadata beside it. */
export function table(file: string): Record<string, Cell>[] {
  const meta = JSON.parse(fs.readFileSync(path.join(BILL, 'merge', `${file}-metadata.json`), 'utf8')) as { tableSchema: { columns: { name: string; datatype?: { base?: string; format?: { decimalChar?: string; groupChar?: string } } }[] } };
  const columns = new Map(meta.tableSchema.columns.map((c) => [c.name, c.datatype]));
  const [head, ...lines] = fs.readFileSync(path.join(BILL, 'merge', file), 'utf8').trimEnd().split('\n').map((l) => l.split(';'));
  return lines.map((cells) => Object.fromEntries(head!.map((name, i): [string, Cell] => {
    const text = cells[i] ?? '';
    const type = columns.get(name);
    if (type?.base !== 'decimal') return [name, text];
    const plain = text.split(type.format?.groupChar ?? '\0').join('').replace(type.format?.decimalChar ?? '.', '.');
    return [name, { value: Number(plain), text }];
  })));
}

const assets = fs.readdirSync(BILL, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(BILL, path.join(e.parentPath, e.name)).split(path.sep).join('/')).filter((n) => n !== 'index.html' && !n.startsWith('merge/') && !n.includes('.csv'));

/** The bill's folder as either route's form, `html` as its document, under forme and a fixed instant. */
export function billForm(html: string): FormData {
  const form = new FormData();
  form.append('index.html', new Blob([html]), 'index.html');
  for (const name of assets) form.append(name, new Blob([fs.readFileSync(path.join(BILL, name))]), path.basename(name));
  form.append('caster.writer', 'forme');
  form.append('created', CREATED);
  return form;
}
