/**
 * The command line's flags: its own table, and the way `--flag <owner>.<name>=<value>` reaches every package's table.
 *
 * @remarks
 * Each package declares its flags with `defineFlags` from `@beltype/common/flags`; the command line reads the tables and parses a string against the row it names. `--trace <file>` takes a free string, which a {@link FlagSpec} row does not express, so it stays a plain `parseArgs` option beside this table.
 *
 * @packageDocumentation
 */

import { ciceroFlags } from '@beltype/cicero';
import { casterFlags } from '@beltype/caster';
import { defineFlags } from '@beltype/common/flags';
import { ValidationError } from '@beltype/common/errors';

export { casterFlags, ciceroFlags };

export const cliFlags = defineFlags('beltype', {
  /** Default `'caster'`: Cicero cuts and Caster prints. `'chromium'` has Chromium print the pages Cicero presented, which is what `check` compares Caster against. */
  printer: { values: ['caster', 'chromium'], default: 'caster' },
  /** Default `false`: no proof. `true` screenshots each presented page, rasterises the PDF and diffs the pairs into `<name>.check/`. */
  check: { values: [false, true], default: false }
});

/** Every table the command line exposes, by owner. */
export const TABLES = { caster: casterFlags, cicero: ciceroFlags, beltype: cliFlags } as const;
export type Owner = keyof typeof TABLES;

/** The values asked for on the command line, by owner and flag name. */
export type Given = Record<Owner, Record<string, unknown>>;

/** Read `owner.name=value` strings (the repeated `--flag`) against the tables. @throws {ValidationError} on a malformed string or an unknown owner; {FlagError} on an unknown name or a bad value. */
export function parseFlagArgs(args: readonly string[]): Given {
  const given: Given = { caster: {}, cicero: {}, beltype: {} };
  for (const arg of args) {
    const m = /^([^.=]+)\.([^=]+)=(.*)$/s.exec(arg);
    if (!m) throw new ValidationError(`beltype: --flag takes <owner>.<name>=<value>; got "${arg}".`);
    const [, owner, name, raw] = m as unknown as [string, string, string, string];
    if (!Object.hasOwn(TABLES, owner)) throw new ValidationError(`beltype: no flag owner '${owner}'. The owners are ${Object.keys(TABLES).join(', ')}.`);
    given[owner as Owner][name] = TABLES[owner as Owner].parse(name, raw);
  }
  return given;
}

/** Every table, one row a flag: owner, name, values and default. */
export function flagsHelp(): string {
  const rows = Object.values(TABLES).flatMap((t) => Object.entries(t.table).map(([name, spec]) => [`${t.owner}.${name}`, spec.values === null ? 'a positive number' : spec.values.map(String).join(' | '), String(spec.default)] as const));
  const width = Math.max(...rows.map((r) => r[0].length));
  const valuesWidth = Math.max(...rows.map((r) => r[1].length));
  return `${rows.map(([flag, values, def]) => `  ${flag.padEnd(width)}  ${values.padEnd(valuesWidth)}  default ${def}`).join('\n')}`;
}
