/**
 * The `beltype` command.
 *
 * @remarks
 * One verb so far: `beltype print <file.html> [-o <file.pdf>]`. The output defaults to the input's name with `.pdf`, beside it. A flag the parser does not know is refused, never ignored.
 *
 * Flags have one shape across BelType: `--flag <owner>.<name>=<value>`, repeatable, names a row of a package's table (`beltype print --help` lists them all). `--printer` and `--check` are the command line's own rows spelled plainly; `--trace <file>` takes a free string, so it is a plain option beside the table.
 *
 * @packageDocumentation
 */

import { parseArgs } from 'node:util';
import { BelTypeError } from '@beltype/common/errors';
import { checkLines } from './check.ts';
import { cliFlags, flagsHelp, parseFlagArgs } from './flags.ts';
import { print } from './print.ts';

const USAGE = 'usage: beltype print <file.html> [-o <file.pdf>] [--printer caster|chromium] [--check] [--trace <file.json>] [--flag <owner>.<name>=<value>]...';

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    output: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
    flag: { type: 'string', multiple: true },
    printer: { type: 'string' },
    check: { type: 'boolean' },
    trace: { type: 'string' }
  } });
  const [verb, input, ...rest] = positionals;
  if (values.help || !verb) {
    console.log(`${USAGE}\n\nflags:\n${flagsHelp()}`);
    return values.help ? 0 : 1;
  }
  if (verb !== 'print' || !input || rest.length) {
    console.error(verb !== 'print' ? `beltype: no verb '${verb}'\n${USAGE}` : USAGE);
    return 1;
  }
  const given = parseFlagArgs(values.flag ?? []);
  if (values.printer !== undefined) given.beltype['printer'] = cliFlags.parse('printer', values.printer);
  if (values.check) given.beltype['check'] = true;
  const output = values.output ?? input.replace(/\.html?$/i, '') + '.pdf';
  const result = await print(input, output, { given, ...(values.trace !== undefined ? { trace: values.trace } : {}) });
  console.log(`${result.output}: ${result.pages} pages, ${result.words} words, ${(result.ms / 1000).toFixed(1)} s`);
  if (result.check) for (const line of checkLines(result.check)) console.log(line);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof BelTypeError ? error.message : error);
    process.exit(1);
  },
);
