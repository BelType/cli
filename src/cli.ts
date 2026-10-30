#!/usr/bin/env node
/**
 * The `beltype` command.
 *
 * @remarks
 * One verb so far: `beltype print <file.html> [-o <file.pdf>]`. The output defaults to the input's name with `.pdf`, beside it. A flag the parser does not know is refused, never ignored.
 *
 * @packageDocumentation
 */

import { parseArgs } from 'node:util';
import { BelTypeError } from '@beltype/common/errors';
import { print } from './print.ts';

const USAGE = 'usage: beltype print <file.html> [-o <file.pdf>]';

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { output: { type: 'string', short: 'o' }, help: { type: 'boolean', short: 'h' } } });
  const [verb, input, ...rest] = positionals;
  if (values.help || !verb) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (verb !== 'print' || !input || rest.length) {
    console.error(verb !== 'print' ? `beltype: no verb '${verb}'\n${USAGE}` : USAGE);
    return 1;
  }
  const output = values.output ?? input.replace(/\.html?$/i, '') + '.pdf';
  const result = await print(input, output);
  console.log(`${result.output}: ${result.pages} pages, ${result.words} words, ${(result.ms / 1000).toFixed(1)} s`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof BelTypeError ? error.message : error);
    process.exit(1);
  },
);
