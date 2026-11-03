# beltype

The BelType command line. It prints a finished HTML document to PDF: Cicero cuts the document into pages in the browser, and Caster prints the pages Cicero presented. There are two printers: Caster, the default, and Chromium's own print (`--printer chromium`), which prints the same pages Cicero presented. Under Caster the run needs only Playwright's bare headless shell.

```bash
beltype print paper/index.html            # writes paper/index.pdf
beltype print paper/index.html -o paper.pdf
beltype print paper/index.html --printer chromium --check --trace trace.json
beltype serve                             # the same, behind HTTP: see below
```

## Flags

One shape across BelType: every package declares a table of name, accepted values and default (`@beltype/common/flags`), and `--flag <owner>.<name>=<value>`, repeatable, sets a row of any of them. `beltype print --help` lists the tables. A value outside a row, or a name no table holds, is refused by name. The defaults reproduce the previous behaviour exactly.

```bash
beltype print paper/index.html --flag caster.shaper=fontkit --flag cicero.composed=true
```

- `--printer caster|chromium`: who prints the pages Cicero presented. Chromium prints them one sheet to a page; it refuses, naming `--printer caster`, when the pages are not all one size.
- `--trace <file.json>`: where the run's time went. `process` is node's clock around each step (launch, context, load, cut, print, transfer, close, write), `cicero` is Cicero's own `performance.measure` entries, `caster` is Caster's report (`ms` per stage and `timing`; `null` under Chromium), with the versions and the resolved flags. It is written even when the run refuses, with the step that refused.
- `--check`: the proof that the PDF is the screen. Each presented page is screenshotted at 96 dpi, the PDF is rasterised at 96 dpi and the pairs are diffed into `<name>.check/` (`screen-N.png`, `print-N.png`, `diff-N.png`, `check.json`). It reports a share of differing pixels per page and a mean, and never fails the run. It tolerates one pixel of slip, because the screen's pages sit at fractional heights (A4 is 1122.52 px) and Skia and mupdf shade letter edges differently.
- `SOURCE_DATE_EPOCH=<seconds>` (an environment variable, not a flag): the moment the file says it was made, whole seconds since 1970 as the reproducible-builds convention has it. Set, the file's `/CreationDate` and `/ModDate` are that instant and the same document printed twice gives the same bytes; unset, they are the wall clock.

The document is plain HTML, CSS and the files beside it. The run answers every request from the document's folder, on a made-up `.invalid` address, and refuses anything else by name: a document that asks for a file it does not have, or for anything on a network, prints nothing. Fonts must be declared with `@font-face` and their files, because Caster embeds every face it draws.

## beltype serve

`beltype serve` is `beltype print` behind an HTTP door, in Gotenberg's shape: one Chromium kept warm, and forme kept warm in a shared worker that every document's page hands its display list to, so a print skips the browser's launch and forme's cold first write. A print is still `beltype print`'s: Cicero cuts and Caster prints in the document's own page, answered from the files it was posted with.

```bash
beltype serve --port 3000
curl -F index.html=@index.html -F paper.css=@paper.css -F fonts/a.woff2=@fonts/a.woff2 -F caster.writer=forme http://127.0.0.1:3000/print -o out.pdf
```

- `POST /print`, `multipart/form-data`. `index.html` is required; every other file keeps its form field name as its path relative to the document (`fonts/a.woff2`), plain segments with `/` separators, never absolute and never `..`. A field that is not a file is a flag, `<owner>.<name>` = value (`caster.writer=forme`, `cicero.…`); `beltype.check` is refused. A field `created` (an ISO 8601 instant) fixes the file's dates, else `SOURCE_DATE_EPOCH`, else the clock. The answer is `200 application/pdf` with `X-Beltype-Pages`, `X-Beltype-Words` and `X-Beltype-Warnings` (the count); `422` with `beltype print`'s sentence where the document is refused (a file it asked for and was not given, among them); `400` for a bad request; `413` over the upload limit; `504` over the time limit; `500` otherwise, after which the browser is restarted.
- `GET /health`: `{ "status": "up", "chromium": …, "prints": …, "queued": … }`, or `503` with `"status": "restarting"` while the browser starts again.
- `--host 127.0.0.1`, `--port 3000`, `--max-upload 50` (MB), `--timeout 60` (seconds per print), `--restart-after 100` (prints before the browser is restarted).
- One print runs at a time; the others wait their turn. After every start the server prints a built-in document twice under forme (the log shows both writes), so the first request is warm.
- It binds `127.0.0.1` unless `--host` says otherwise, and fetches nothing from a network: a document that asks for anything it was not posted is refused by name, as in `beltype print`. The built-in warm-up document ships one font, Source Sans 3 (SIL OFL), in `assets/warmup/`.

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
