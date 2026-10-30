/**
 * The two steps that run inside the page: Cicero cuts the document into pages, and Caster prints the pages Cicero presented.
 *
 * @remarks
 * Each function is handed to `page.evaluate`, which sends its source text, so neither may close over anything in this module: the modules it needs are imported by URL, from the `/_beltype/` routes `print.ts` answers. A refusal comes back as data, never as a throw across the boundary, so the message survives the trip.
 *
 * @packageDocumentation
 */

/** What either step answers when it refuses. */
export type Refusal = { refused: string; at: string };

/** One of Cicero's `performance.measure` entries, as the trace carries it. */
export type Measure = { name: string; ms: number; detail: unknown };

/**
 * Caster's `prepare()` makes markers real elements before the cut, then Cicero's client paginates the whole document.
 *
 * @param run - `cicero` is the resolved Cicero flags, handed to `run()`; `measures` asks for Cicero's own timings, read after the cut.
 */
export async function cutInPage(run: { cicero: Record<string, unknown>; measures: boolean }): Promise<{ pages: number; measures: Measure[] } | Refusal> {
  let at = 'prepare';
  try {
    // @ts-expect-error a URL the page resolves, not a module the checker can find. A literal on purpose: a computed `import()` is wrapped by `rewriteRelativeImportExtensions` in a helper the page does not have.
    const caster = await import('/_beltype/caster/src/index.js');
    caster.prepare(document);
    at = 'paginate';
    const cicero = (window as any).__beltypeCicero;
    if (!cicero?.run) return { refused: 'the document loaded no Cicero client, so there is nothing to paginate with', at };
    const answer = await cicero.run(run.cicero);
    await document.fonts.ready;
    const measures = run.measures ? performance.getEntriesByType('measure').filter((m) => m.name.startsWith('cicero:')).map((m) => ({ name: m.name, ms: Math.round(m.duration * 100) / 100, detail: (m as PerformanceMeasure).detail ?? null })) : [];
    return { pages: answer.pages, measures };
  } catch (error) {
    return { refused: String((error as Error | undefined)?.message ?? error), at };
  }
}

/** What Caster's report says of its own time, as the trace carries it. */
export type CasterTrace = { ms: Record<string, number>; timing: unknown };

/**
 * Caster prints the presented pages; the bytes cross back as base64, the one form `evaluate` carries intact.
 *
 * @param options - the resolved Caster flags. `printMs` in the answer is Caster's own time in the page, before the bytes are encoded.
 */
export async function printInPage(options: Record<string, unknown>): Promise<{ base64: string; pages: number; words: number; warnings: unknown[]; printMs: number; caster: CasterTrace } | Refusal> {
  try {
    const t0 = performance.now();
    // @ts-expect-error a URL the page resolves, not a module the checker can find. A literal on purpose: a computed `import()` is wrapped by `rewriteRelativeImportExtensions` in a helper the page does not have.
    const caster = await import('/_beltype/caster/src/index.js');
    const printed = await caster.print({ document }, options);
    const printMs = performance.now() - t0;
    const bytes: Uint8Array = printed.bytes;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { base64: btoa(binary), pages: printed.report.timing?.pages ?? 0, words: printed.report.timing?.words ?? 0, warnings: printed.report.warnings ?? [], printMs, caster: { ms: printed.report.ms ?? {}, timing: printed.report.timing ?? null } };
  } catch (error) {
    return { refused: String((error as Error | undefined)?.message ?? error), at: 'print' };
  }
}

/** The size of each page Cicero presented, in CSS px. Cicero's pages live in the root's shadow tree. */
export function pageSizesInPage(): { w: number; h: number }[] {
  const root = document.querySelector('beltype-root');
  return [...(root?.shadowRoot?.querySelectorAll('beltype-page') ?? [])].map((p) => {
    const r = p.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
}

/** Chromium's print sheet: `@page` is document-level, the page-break rule belongs in the shadow tree the pages live in. */
export function chromiumSheetInPage(sheet: { page: string; shadow: string }): void {
  const doc = document.createElement('style');
  doc.textContent = sheet.page;
  document.head.appendChild(doc);
  const shadow = document.createElement('style');
  shadow.textContent = sheet.shadow;
  document.querySelector('beltype-root')?.shadowRoot?.appendChild(shadow);
}
