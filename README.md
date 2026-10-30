# beltype

The BelType command line. It prints a finished HTML document to PDF: Cicero cuts the document into pages in the browser, and Caster prints the pages Cicero presented. Chromium's own print is never called, so the run needs only Playwright's bare headless shell.

```bash
beltype print samples/paper/index.html            # writes samples/paper/index.pdf
beltype print samples/paper/index.html -o paper.pdf
```

The document is plain HTML, CSS and the files beside it. The run answers every request from the document's folder, on a made-up `.invalid` address, and refuses anything else by name: a document that asks for a file it does not have, or for anything on a network, prints nothing. Fonts must be declared with `@font-face` and their files, because Caster embeds every face it draws.

## The sample

`samples/paper/` is a short scientific article on A4 (its data are invented). It exercises what a paged document needs:

- the page box, with margins and an `@page :first` that withholds the margin boxes on the title page;
- margin boxes: a running title and a running section from named strings (`string-set`), and the folio from `counter(page)`;
- numbered sections, figures and tables from author counters;
- cross-references by number (`target-counter(…, figure)`) and by page (`target-counter(…, page)`);
- a table with tabular figures, and a figure drawn in SVG;
- `break-after: avoid` on headings and `break-inside: avoid` on figures;
- `hyphens: auto`, the hyphen drawn where Blink breaks and extracted as a soft hyphen.

Its fonts, Source Serif 4 and Source Sans 3, are under the SIL Open Font License (`samples/paper/fonts/`).

## What is not printed yet

Found while writing the sample, and left out of it until the companions print them:

- `counter(pages)` in a margin box: Caster refuses the content.
- SVG text under `transform="rotate(…)"`: Caster draws it broken.
- `content()` in `string-set` includes the heading's `::before` under Cicero, so the sample's running section reads "3. Results" from `content()` alone.

## Requirements

Node 22 or later, and Playwright's headless shell for `playwright-core` 1.63.0:

```bash
npx playwright-core@1.63.0 install chromium-headless-shell
```

The companions come from the organization's repositories as git dependencies, each built by its own `prepare`: `@beltype/cicero`, `@beltype/caster` and `@beltype/common`.

## Working on it

```bash
pnpm install
pnpm run check    # tsc over src and test, strict
pnpm test         # prints the sample and reads the file back with mupdf
pnpm run build    # dist/, which the beltype command runs
```
