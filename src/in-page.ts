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
 * Caster's `prepare()` makes markers real elements before the cut, and its `ready` loads the faces the document's SVG images set text in, which the document itself never asks for (codeberg.org/BelType/caster issue 11); then Cicero's client paginates the whole document. A face that arrived after the cut would make Cicero cut again under the printer.
 *
 * @param run - `cicero` is the resolved Cicero flags, handed to `run()`; `measures` asks for Cicero's own timings, read after the cut.
 */
export async function cutInPage(run: { cicero: Record<string, unknown>; measures: boolean }): Promise<{ pages: number; measures: Measure[] } | Refusal> {
  let at = 'prepare';
  try {
    // @ts-expect-error a URL the page resolves, not a module the checker can find. A literal on purpose: a computed `import()` is wrapped by `rewriteRelativeImportExtensions` in a helper the page does not have.
    const caster = await import('/_beltype/caster/src/index.js');
    await caster.prepare(document).ready;
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

/** A feature Caster drew differently or not at all, as its report's `deferred` names it: the element's path, the feature, and what it was painted as. */
export type Deferral = { path: string; feature: string; paintedAs: string };

/** What Caster's report says of its own time, as the trace carries it. */
export type CasterTrace = { ms: Record<string, number>; timing: unknown; fonts: { id: string; ms: unknown }[] };

/**
 * Caster prints the presented pages; the bytes cross back as base64, the one form `evaluate` carries intact.
 *
 * @param run - `options` is the resolved Caster flags; `created` is the instant the file says it was made, absent for the wall clock; `sharedWriter` has forme write through a `SharedWorker` the page opens (Caster's `formeSharedWorkerUrl()`), so a host that keeps the page's browser alive keeps the writer warm. `printMs` in the answer is Caster's own time in the page, before the bytes are encoded.
 */
export async function printInPage(run: { options: Record<string, unknown>; created?: string; sharedWriter?: boolean }): Promise<{ base64: string; pages: number; words: number; warnings: unknown[]; deferred: Deferral[]; printMs: number; caster: CasterTrace } | Refusal> {
  try {
    const t0 = performance.now();
    // @ts-expect-error a URL the page resolves, not a module the checker can find. A literal on purpose: a computed `import()` is wrapped by `rewriteRelativeImportExtensions` in a helper the page does not have.
    const caster = await import('/_beltype/caster/src/index.js');
    const formePort = run.sharedWriter ? new SharedWorker(caster.formeSharedWorkerUrl(), { type: 'module', name: 'forme' }).port : undefined;
    const printed = await caster.print({ document, ...(run.created !== undefined ? { created: run.created } : {}), ...(formePort ? { formePort } : {}) }, run.options);
    const printMs = performance.now() - t0;
    const bytes: Uint8Array = printed.bytes;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { base64: btoa(binary), pages: printed.report.timing?.pages ?? 0, words: printed.report.timing?.words ?? 0, warnings: printed.report.warnings ?? [], deferred: printed.report.deferred ?? [], printMs, caster: { ms: printed.report.ms ?? {}, timing: printed.report.timing ?? null, fonts: (printed.report.emission?.faces ?? []).map((f: { id: string; ms?: unknown }) => ({ id: f.id, ms: f.ms ?? null })) } };
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

/**
 * Seat `html` as the page's document without a navigation: `document.open()` keeps the `Window`, so the realm Caster measures from, its modules and its capability registry stay (Caster's DESIGN.md S87, S89). The `adoptedStyleSheets` the last document left on the Document are emptied; `load` is awaited as a navigation's would be.
 *
 * @remarks
 * The previous Cicero client is released first (`release()`, Cicero 0.1.6, SPEC XII.7): the `Window` and its one `FontFaceSet` outlive `document.open()`, and an unreleased client heard a face of the next document's family arrive as a late fact and ran beside the host's run, which was let go after one page (measured: the paper after a document of another family cut 1 page, not 4). A released client deletes its handle, so the next document's module scripts must load under a URL of their own, which `serve.ts` keys per re-seat.
 */
export async function reseatInPage(html: string): Promise<void> {
  await (window as any).__beltypeCicero?.release?.();
  document.open();
  document.adoptedStyleSheets = [];
  const loaded = new Promise<void>((resolve) => window.addEventListener('load', () => resolve(), { once: true }));
  document.write(html);
  document.close();
  await loaded;
}
