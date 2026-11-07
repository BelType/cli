/**
 * The `beltype` command.
 *
 * @remarks
 * Two verbs: `beltype print <file.html> [-o <file.pdf>]` and `beltype serve` (see `serve.ts`). The output defaults to the input's name with `.pdf`, beside it. A flag the parser does not know is refused, never ignored.
 *
 * Flags have one shape across BelType: `--flag <owner>.<name>=<value>`, repeatable, names a row of a package's table (`beltype print --help` lists them all). `--printer` and `--check` are the command line's own rows spelled plainly; `--trace <file>` takes a free string, so it is a plain option beside the table, and so is `--no-sandbox`, which belongs to the launch and to no package's table.
 *
 * @packageDocumentation
 */

import { parseArgs } from 'node:util';
import { BelTypeError, ValidationError } from '@beltype/common/errors';
import { checkLines } from './check.ts';
import { cliFlags, createdFromEnv, flagsHelp, parseFlagArgs } from './flags.ts';
import { print } from './print.ts';
import { serve } from './serve.ts';

const USAGE = 'usage: beltype serve [--host 127.0.0.1] [--port 3000] [--max-upload 50] [--timeout 60] [--restart-after 100] [--no-sandbox]\n       beltype print <file.html> [-o <file.pdf>] [--printer caster|chromium] [--check] [--trace <file.json>] [--no-sandbox] [--flag <owner>.<name>=<value>]...';

async function serveVerb(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '3000' },
    'max-upload': { type: 'string', default: '50' },
    timeout: { type: 'string', default: '60' },
    'restart-after': { type: 'string', default: '100' },
    'no-sandbox': { type: 'boolean' }
  } });
  const number = (name: string, raw: string, min: number) => {
    if (!/^\d+$/.test(raw) || Number(raw) < min) throw new ValidationError(`beltype serve: --${name} is a whole number of at least ${min}; got "${raw}".`);
    return Number(raw);
  };
  const server = await serve({
    host: values.host!,
    port: number('port', values.port!, 0),
    maxUpload: number('max-upload', values['max-upload']!, 1) * 1024 * 1024,
    timeout: number('timeout', values.timeout!, 1) * 1000,
    restartAfter: number('restart-after', values['restart-after']!, 1),
    sandbox: !values['no-sandbox']
  });
  const stop = () => { void server.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'serve') {
    await serveVerb(argv.slice(1));
    return -1;
  }
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    output: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
    flag: { type: 'string', multiple: true },
    printer: { type: 'string' },
    check: { type: 'boolean' },
    trace: { type: 'string' },
    'no-sandbox': { type: 'boolean' }
  } });
  const [verb, input, ...rest] = positionals;
  if (values.help || !verb) {
    console.log(`${USAGE}\n\nflags:\n${await flagsHelp()}`);
    return values.help ? 0 : 1;
  }
  if (verb !== 'print' || !input || rest.length) {
    console.error(verb !== 'print' ? `beltype: no verb '${verb}'\n${USAGE}` : USAGE);
    return 1;
  }
  const given = await parseFlagArgs(values.flag ?? []);
  if (values.printer !== undefined) given.beltype['printer'] = cliFlags.parse('printer', values.printer);
  if (values.check) given.beltype['check'] = true;
  const output = values.output ?? input.replace(/\.html?$/i, '') + '.pdf';
  const created = createdFromEnv();
  const result = await print(input, output, { given, sandbox: !values['no-sandbox'], ...(values.trace !== undefined ? { trace: values.trace } : {}), ...(created ? { created } : {}) });
  console.log(`${result.output}: ${result.pages} pages, ${result.words} words, ${(result.ms / 1000).toFixed(1)} s`);
  if (result.check) for (const line of checkLines(result.check)) console.log(line);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => { if (code >= 0) process.exit(code); },
  (error) => {
    console.error(error instanceof BelTypeError ? error.message : error);
    process.exit(1);
  },
);
