# beltype

The BelType command line. It prints a finished HTML document to PDF: Cicero cuts the document into pages in the browser, and Caster prints the pages Cicero presented. There are two printers: Caster, the default, and Chromium's own print (`--printer chromium`), which prints the same pages Cicero presented. Under Caster the run needs only Playwright's bare headless shell.

```bash
beltype print paper/index.html            # writes paper/index.pdf
beltype print paper/index.html -o paper.pdf
beltype print paper/index.html --printer chromium --check --trace trace.json
```

## Flags

One shape across BelType: every package declares a table of name, accepted values and default (`@beltype/common/flags`), and `--flag <owner>.<name>=<value>`, repeatable, sets a row of any of them. `beltype print --help` lists the tables. A value outside a row, or a name no table holds, is refused by name. The defaults reproduce the previous behaviour exactly.

```bash
beltype print paper/index.html --flag caster.shaper=fontkit --flag cicero.composed=true
```

- `--printer caster|chromium`: who prints the pages Cicero presented. Chromium prints them one sheet to a page; it refuses, naming `--printer caster`, when the pages are not all one size.
- `--trace <file.json>`: where the run's time went. `process` is node's clock around each step (launch, context, load, cut, print, transfer, close, write), `cicero` is Cicero's own `performance.measure` entries, `caster` is Caster's report (`ms` per stage and `timing`; `null` under Chromium), with the versions and the resolved flags. It is written even when the run refuses, with the step that refused.
- `--check`: the proof that the PDF is the screen. Each presented page is screenshotted at 96 dpi, the PDF is rasterised at 96 dpi and the pairs are diffed into `<name>.check/` (`screen-N.png`, `print-N.png`, `diff-N.png`, `check.json`). It reports a share of differing pixels per page and a mean, and never fails the run.

The document is plain HTML, CSS and the files beside it. The run answers every request from the document's folder, on a made-up `.invalid` address, and refuses anything else by name: a document that asks for a file it does not have, or for anything on a network, prints nothing. Fonts must be declared with `@font-face` and their files, because Caster embeds every face it draws.

## The sample

`paper`, from [`@beltype/specimens`](https://codeberg.org/BelType/specimens), is a short scientific article on A4 (its data are invented). It exercises what a paged document needs:

- the page box, with margins and an `@page :first` that withholds the margin boxes on the title page;
- margin boxes: a running title and a running section from named strings (`string-set`), and the folio from `counter(page)`;
- numbered sections, figures and tables from author counters;
- cross-references by number (`target-counter(…, figure)`) and by page (`target-counter(…, page)`);
- a table with tabular figures, and a figure drawn in SVG;
- `break-after: avoid` on headings and `break-inside: avoid` on figures;
- `hyphens: auto`, the hyphen drawn where Blink breaks and extracted as a soft hyphen.

Its fonts, Source Serif 4 and Source Sans 3, are under the SIL Open Font License, with their licences in the specimen's `fonts/`. A change to it is made in the specimens repository, and the pin here moves.

## What is not printed yet

Found while writing the sample, and left out of it until the companions print them:

- `counter(pages)` in a margin box: Caster refuses the content.
- SVG text under `transform="rotate(…)"`: Caster draws it broken.
- `content()` in `string-set` includes the heading's `::before` under Cicero, so the sample's running section reads "3. Results" from `content()` alone.

## Known limits

- **`--check` shares are inflated by a half-pixel slip.** A4 is 1122.5 px tall at 96 dpi; the screenshot rounds it to 1122 and mupdf to 1123, so every glyph edge below the slip differs. The 3–5 % on `paper` is mostly that, not a real fault: lines where the slip lands on whole pixels show clean. Read the shares as an upper bound until the comparison aligns the two.

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
pnpm test         # prints the specimen under each printer, and reads the files back with mupdf
pnpm run build    # dist/, which the beltype command runs
```
