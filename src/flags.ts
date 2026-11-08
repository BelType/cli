/**
 * The command line's flags: its own table, and the way `--flag <owner>.<name>=<value>` reaches every package's table.
 *
 * @remarks
 * Each package declares its flags with `defineFlags` from `@beltype/common/flags`; the command line reads the tables and parses a string against the row it names. `--trace <file>` takes a free string, which a {@link FlagSpec} row does not express, so it stays a plain `parseArgs` option beside this table.
 *
 * @packageDocumentation
 */

import { defineFlags } from '@beltype/common/flags';
import { ValidationError } from '@beltype/common/errors';

export const cliFlags = defineFlags('beltype', {
  /** Default `'caster'`: Cicero cuts and Caster prints. `'chromium'` has Chromium print the pages Cicero presented, which is what `check` compares Caster against. */
  printer: { values: ['caster', 'chromium'], default: 'caster' },
  /** Default `false`: no check. `true` screenshots each presented page, rasterises the PDF, diffs the pairs into `<name>.check/` and fails the run on a page over the threshold or a page count that differs; `'report'` writes the same report and never fails. */
  check: { values: [false, true, 'report'], default: false as boolean | 'report' }
});

/**
 * The tables of the packages, each loaded the first time a run needs it.
 *
 * @remarks
 * `import('@beltype/caster')` loads every module of Caster, which costs about 40 ms in Node, and a plain print does not read its table: the page resolves Caster's defaults itself. So the table is imported when a `--flag caster.*` names it, for `--help`, and for the trace's `flags` field.
 */
const LOADERS = {
  caster: async () => (await import('@beltype/caster')).casterFlags,
  cicero: async () => (await import('@beltype/cicero/flags')).ciceroFlags,
  beltype: async () => cliFlags
} as const;
export type Owner = keyof typeof LOADERS;
const OWNERS = Object.keys(LOADERS);

/** The table of one owner. */
export function tableOf<K extends Owner>(owner: K): ReturnType<(typeof LOADERS)[K]> {
  return LOADERS[owner]() as ReturnType<(typeof LOADERS)[K]>;
}

/** The values asked for on the command line, by owner and flag name. */
export type Given = Record<Owner, Record<string, unknown>>;

/** Read `owner.name=value` strings (the repeated `--flag`) against the tables, loading only the tables they name. @throws {ValidationError} on a malformed string or an unknown owner; {FlagError} on an unknown name or a bad value. */
export async function parseFlagArgs(args: readonly string[]): Promise<Given> {
  const given: Given = { caster: {}, cicero: {}, beltype: {} };
  for (const arg of args) {
    const m = /^([^.=]+)\.([^=]+)=(.*)$/s.exec(arg);
    if (!m) throw new ValidationError(`beltype: --flag takes <owner>.<name>=<value>; got "${arg}".`);
    const [, owner, name, raw] = m as unknown as [string, string, string, string];
    if (!Object.hasOwn(LOADERS, owner)) throw new ValidationError(`beltype: no flag owner '${owner}'. The owners are ${OWNERS.join(', ')}.`);
    given[owner as Owner][name] = (await tableOf(owner as Owner)).parse(name, raw);
  }
  return given;
}

/** Every table, one row a flag: owner, name, values and default. */
export async function flagsHelp(): Promise<string> {
  const tables = await Promise.all(OWNERS.map((owner) => tableOf(owner as Owner)));
  const rows = tables.flatMap((t) => Object.entries(t.table).map(([name, spec]) => [`${t.owner}.${name}`, spec.values === null ? 'a positive number' : spec.values.map(String).join(' | '), String(spec.default)] as const));
  const width = Math.max(...rows.map((r) => r[0].length));
  const valuesWidth = Math.max(...rows.map((r) => r[1].length));
  return `${rows.map(([flag, values, def]) => `  ${flag.padEnd(width)}  ${values.padEnd(valuesWidth)}  default ${def}`).join('\n')}`;
}

/** The instant `SOURCE_DATE_EPOCH` names (whole seconds since 1970, the reproducible-builds convention), as an ISO 8601 string; undefined where the variable is not set. @throws {ValidationError} where it is not whole seconds. */
export function createdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const epoch = env['SOURCE_DATE_EPOCH'];
  if (epoch === undefined || epoch === '') return undefined;
  if (!/^\d{1,15}$/.test(epoch)) throw new ValidationError(`beltype: SOURCE_DATE_EPOCH is whole seconds since 1970; got "${epoch}".`);
  return new Date(Number(epoch) * 1000).toISOString();
}
