/**
 * The print sheet `--printer chromium` adds after Cicero's cut.
 *
 * @remarks
 * Chromium prints the pages Cicero presented, one sheet to a page. The sheet sets the page box to the presented pages' one size, breaks after each page, and turns off the screen surround's gap and shadow (`@media screen` in Cicero's root; `page.pdf()` prints under print media, so they are off anyway and the sheet says so).
 *
 * @packageDocumentation
 */

import { BuildError } from '@beltype/common/errors';

/** @throws {BuildError} when the presented pages are not all one size: named pages of different sizes need per-size `@page` rules, a later round. */
export function chromiumSheet(sizes: readonly { w: number; h: number }[]): { page: string; shadow: string } {
  const first = sizes[0];
  if (!first) throw new BuildError('beltype print: --printer chromium found no page Cicero presented.');
  if (sizes.some((s) => Math.abs(s.w - first.w) > 0.01 || Math.abs(s.h - first.h) > 0.01)) {
    throw new BuildError('beltype print: the presented pages are not all one size, which --printer chromium does not print yet; use --printer caster.');
  }
  return {
    page: `@page { size: ${first.w}px ${first.h}px; margin: 0 }`,
    shadow: 'beltype-page { break-after: page; margin: 0; box-shadow: none }'
  };
}
