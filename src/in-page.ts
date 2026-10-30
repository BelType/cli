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

/** Caster's `prepare()` makes markers real elements before the cut, then Cicero's client paginates the whole document. */
export async function cutInPage(): Promise<{ pages: number } | Refusal> {
  let at = 'prepare';
  try {
    // @ts-expect-error a URL the page resolves, not a module the checker can find. A literal on purpose: a computed `import()` is wrapped by `rewriteRelativeImportExtensions` in a helper the page does not have.
    const caster = await import('/_beltype/caster/src/index.js');
    caster.prepare(document);
    at = 'paginate';
    const cicero = (window as any).__beltypeCicero;
    if (!cicero?.run) return { refused: 'the document loaded no Cicero client, so there is nothing to paginate with', at };
    const answer = await cicero.run();
    await document.fonts.ready;
    return { pages: answer.pages };
  } catch (error) {
    return { refused: String((error as Error | undefined)?.message ?? error), at };
  }
}

/** Caster prints the presented pages; the bytes cross back as base64, the one form `evaluate` carries intact. */
export async function printInPage(): Promise<{ base64: string; pages: number; words: number; warnings: unknown[] } | Refusal> {
  try {
    // @ts-expect-error a URL the page resolves, not a module the checker can find. A literal on purpose: a computed `import()` is wrapped by `rewriteRelativeImportExtensions` in a helper the page does not have.
    const caster = await import('/_beltype/caster/src/index.js');
    const printed = await caster.print({ document });
    const bytes: Uint8Array = printed.bytes;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { base64: btoa(binary), pages: printed.report.timing?.pages ?? 0, words: printed.report.timing?.words ?? 0, warnings: printed.report.warnings ?? [] };
  } catch (error) {
    return { refused: String((error as Error | undefined)?.message ?? error), at: 'print' };
  }
}
