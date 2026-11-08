/**
 * `beltype print`: a finished HTML document to a PDF, through Cicero and Caster, in Chromium's headless shell.
 *
 * @remarks
 * **Two printers.** Cicero paginates, then Caster prints the pages Cicero presented (the default), or `--printer chromium` has Chromium's `page.pdf()` print them. Under Caster the bare headless shell is enough: where Cicero cuts is layout, the same Blink in the shell as in the full binary.
 *
 * **Every request is answered from disk, on one made-up origin.** The browser context's `route` answers the document at its own name, the document's folder at the root, and `/_beltype/` from the companions' built files. A request for anything else is refused and named, and a run that refused anything writes no file, because the print would not be the document.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { ciceroFlags } from '@beltype/cicero/flags';
import type { CasterTrace, Measure } from './in-page.ts';
import { cliFlags, tableOf, type Given } from './flags.ts';
import { checkPages, requireMupdf, type CheckResult } from './check.ts';
import { ARGS, VIEWPORT, documentAssets, servedHtml, routeCompanions, routeDocument, printOnPage, refusal, deferralLine, standardOf } from './run.ts';

export { spliceHead } from './run.ts';

export type PrintResult = { output: string; pages: number; words: number; deferred: number; ms: number; standard: string | null; check?: CheckResult };

/** What a run asks for beyond the document: the values given per owner (anything not given is its default), and where to write the trace. `sandbox` false launches Chromium without its sandbox, for a container that runs as root. */
export type PrintOptions = { given?: Partial<Given>; trace?: string; created?: string; sandbox?: boolean };

/** Where a run's time went, in three layers, with the versions and flags it used. */
export type Trace = {
  process: Record<string, number>;
  cicero: Measure[];
  caster: CasterTrace | null;
  versions: Record<string, string>;
  flags: Record<string, Record<string, unknown>>;
  /** Set when the run refused: the step it refused at, and why. */
  refused?: { step: string; message: string };
};

const round = (ms: number) => Math.round(ms * 10) / 10;

/**
 * Print `input`, an HTML file, to `output`.
 *
 * @throws {BuildError} naming what the document asked for and could not be given, or the step that refused.
 */
export async function print(input: string, output: string, options: PrintOptions = {}): Promise<PrintResult> {
  const started = performance.now();
  // Caster's own defaults are resolved in the page by `caster.print`, so the given values are all the page is handed; its table is loaded for the trace alone, at the end.
  const flags = {
    caster: options.given?.caster ?? {},
    cicero: ciceroFlags.resolve(options.given?.cicero as never),
    beltype: cliFlags.resolve(options.given?.beltype as never)
  };
  const trace: Trace = { process: {}, cicero: [], caster: null, versions: {}, flags: {} };
  let mark = started;
  const lap = (key: string) => {
    const now = performance.now();
    trace.process[key] = round(now - mark);
    mark = now;
  };
  let step = 'launch';
  let chromiumVersion = 'unknown';
  try {
    // A run that refuses writes no file, so an earlier print at this path must not stand for it.
    fs.rmSync(output, { force: true });
    if (flags.beltype.check) await requireMupdf();
    const html = fs.readFileSync(input, 'utf8');
    const root = path.dirname(path.resolve(input));
    const docPath = `/${encodeURIComponent(path.basename(input))}`;
    const assets = documentAssets();
    const served = servedHtml(html);

    const missing = new Set<string>();
    const browser = await chromium.launch({ headless: true, args: ARGS, chromiumSandbox: options.sandbox ?? true });
    chromiumVersion = browser.version();
    lap('launch');
    try {
      step = 'context';
      const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
      await routeCompanions(context, missing, assets);
      const page = await context.newPage();
      await routeDocument(page, missing, { root, docPath, served });
      lap('context');
      const printed = await printOnPage(page, missing, flags, {
        docPath,
        measures: options.trace !== undefined,
        ...(options.created !== undefined ? { created: options.created } : {}),
        progress: { step: (name) => { step = name; }, lap, cicero: (measures) => { trace.cicero = measures; } }
      });
      if (printed.printMs !== undefined) {
        trace.process['print'] = round(printed.printMs);
        trace.process['transfer'] = round(performance.now() - mark - printed.printMs);
        mark = performance.now();
        trace.caster = printed.caster;
        for (const warning of printed.warnings) console.warn(typeof warning === 'string' ? warning : JSON.stringify(warning));
        for (const deferral of printed.deferred) console.warn(deferralLine(deferral));
      } else lap('print');
      const { bytes, pages, words, screens, confessions, conformance } = printed;
      step = 'close';
      await browser.close();
      lap('close');
      if (missing.size) throw refusal(missing, null);
      step = 'write';
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(output, bytes);
      lap('write');
      let check: CheckResult | undefined;
      if (flags.beltype.check) {
        step = 'check';
        check = await checkPages(screens, bytes, path.resolve(output).replace(/\.pdf$/i, '') + '.check', flags.beltype.printer, confessions);
        lap('check');
      }
      return { output, pages, words, deferred: printed.deferred.length, standard: standardOf(conformance), ms: performance.now() - started, ...(check ? { check } : {}) };
    } finally {
      await browser.close();
    }
  } catch (error) {
    trace.refused = { step, message: error instanceof Error ? error.message : String(error) };
    throw error;
  } finally {
    if (options.trace !== undefined) {
      trace.process['total'] = round(performance.now() - started);
      trace.versions = versions(chromiumVersion);
      // After the total: importing Caster's table here costs about 40 ms in Node, which is not the run's.
      trace.flags = { ...flags, caster: (await tableOf('caster')).resolve(flags.caster as never) };
      fs.mkdirSync(path.dirname(path.resolve(options.trace)), { recursive: true });
      fs.writeFileSync(options.trace, JSON.stringify(trace, null, 2));
    }
  }
}

/** The version of each package the run used, read from the `package.json` above the module that `specifier` resolves to. */
function versions(chromiumVersion: string): Record<string, string> {
  const of = (url: string, name: string) => {
    let dir = path.dirname(fileURLToPath(url));
    for (;;) {
      const file = path.join(dir, 'package.json');
      if (fs.existsSync(file)) {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === name) return pkg.version ?? 'unknown';
      }
      const up = path.dirname(dir);
      if (up === dir) return 'unknown';
      dir = up;
    }
  };
  return {
    '@beltype/cli': of(import.meta.url, '@beltype/cli'),
    '@beltype/cicero': of(import.meta.resolve('@beltype/cicero'), '@beltype/cicero'),
    '@beltype/caster': of(import.meta.resolve('@beltype/caster'), '@beltype/caster'),
    '@beltype/common': of(import.meta.resolve('@beltype/common/errors'), '@beltype/common'),
    'playwright-core': of(import.meta.resolve('playwright-core'), 'playwright-core'),
    chromium: chromiumVersion
  };
}
