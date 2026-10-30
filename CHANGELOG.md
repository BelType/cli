# Changelog

## 0.1.1 — 2026-10-30

- **`@beltype/caster` moves to v0.1.2**, which draws a word Blink hyphenates as Blink lays it out.
- **The sample paper sets `hyphens: auto`** again, and the test holds that a line ends in a hyphenated word.

## 0.1.0 — 2026-10-30

- **`beltype print <file.html> [-o <file.pdf>]`**: a finished HTML document to PDF through Cicero and Caster in Playwright's headless shell, with no Chromium print. Every request is answered from the document's folder or the companions' built files on a made-up `.invalid` origin; anything else is refused by name and no file is written.
- **Companions by git tag**: `@beltype/cicero` v0.1.3, `@beltype/caster` v0.1.1, `@beltype/common` v0.1.0; `playwright-core` pinned at 1.63.0.
- **`samples/paper/`**, a short scientific article on A4: margin boxes from named strings and the page counter, `@page :first`, numbered sections, figures and tables, cross-references by number and by page, an SVG figure. Three pages print in under a second.
- **One end-to-end test** prints the sample and reads it back with mupdf.
- **Not yet**: the proxy that catches what routes cannot see (a worker's sockets), which the monorepo's `beltype cast` has; Markdown and configuration.
