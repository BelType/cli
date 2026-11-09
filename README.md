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
- `--check` and `--check=report` (need `npm install mupdf@1.28.1`: mupdf is under the AGPL-3.0, so this package does not bring it): the PDF compared with the pages Cicero presented in the same run. Each presented page is screenshotted at 96 dpi, the PDF is rasterised at 96 dpi and the pairs are diffed into `<name>.check/` (`screen-N.png`, `print-N.png`, `diff-N.png`, `check.json`), with a share of differing pixels per page, its worst tile, whether it passes, and a mean. It is the proof that the printer drew what the engine cut, not a proof against an outside oracle: Caster's acceptance suite for the cast road is that. Under `--check` a page over 3.5 % differing, or a page count that differs between screen and print, fails the run with one line a page (`check page 2 fails: 25.70% differ, over 3.5%; <name>.check/diff-2.png`); `--check=report` writes the same report and never fails. It tolerates one pixel of slip, because the screen's pages sit at fractional heights (A4 is 1122.52 px) and Skia and mupdf shade letter edges differently; a text page still reads 0.3 to 1.8 %, so a small defect (a 120 by 30 px block is 0.4 % of an A4 page) passes the share. The diff is also read in 24 px tiles, and a page whose worst tile differs over 40 % fails (`check page 1 fails: tile at (48, 168) differs 58%, over the 40% floor for a picture page; <name>.check/diff-1.png`); `check.json` carries each page's worst tile, where it is, and its kind, `text` or `picture` (an image, a canvas, an SVG, a background image, a blend, a filter, a shadow or an opacity on the page). A print grown round its page by a bleed and print marks is cropped to the page first, which sits at the PDF's origin. A tile over the floor is excused where Caster's report confessed a region over it, a transform or a guess (`black-text`, `cmyk-image`, `undecodable-image`, `raster-shadow`, `blend`, `opacity` and the rest), and the page's line names the confession (`worst tile 44% at (48, 72) excused by black-text on h1[0]`); a tile straddling a region's edge is excused only when its part outside, on its own, is under the floor, and the share is never excused. Excusing needs a Caster whose report carries `confessions`, which the pinned 0.1.7 does not: under it nothing is excused.
- `--no-sandbox`: launch Chromium without its sandbox. By default it runs in it; a container that runs as root needs this, since Chromium will not start sandboxed as root. Give the container a user of its own instead where you can.
- `SOURCE_DATE_EPOCH=<seconds>` (an environment variable, not a flag): the moment the file says it was made, whole seconds since 1970 as the reproducible-builds convention has it. Set, the file's `/CreationDate` and `/ModDate` are that instant and the same document printed twice gives the same bytes; unset, they are the wall clock.

The document is plain HTML, CSS and the files beside it. The run answers every request from the document's folder, on a made-up `.invalid` address, and refuses anything else by name: a document that asks for a file it does not have, or for anything on a network, prints nothing. Fonts must be declared with `@font-face` and their files, because Caster embeds every face it draws.

## beltype serve

`beltype serve` is `beltype print` behind an HTTP door, in Gotenberg's shape: one Chromium kept warm, and forme kept warm in a shared worker that every document's page hands its display list to, so a print skips the browser's launch and forme's cold first write. A print is still `beltype print`'s: Cicero cuts and Caster prints in the document's own page, answered from the files it was posted with.

```bash
beltype serve --port 3000
curl -F index.html=@index.html -F paper.css=@paper.css -F fonts/a.woff2=@fonts/a.woff2 -F caster.writer=forme http://127.0.0.1:3000/print -o out.pdf
```

- `POST /print`, `multipart/form-data`. `index.html` is required; every other file keeps its form field name as its path relative to the document (`fonts/a.woff2`), plain segments with `/` separators, never absolute and never `..`. A field that is not a file is a flag, `<owner>.<name>` = value (`caster.writer=forme`, `cicero.…`); `beltype.check` is refused. A field `created` (an ISO 8601 instant) fixes the file's dates, else `SOURCE_DATE_EPOCH`, else the clock. The answer is `200 application/pdf` with `X-Beltype-Pages`, `X-Beltype-Words`, `X-Beltype-Warnings` (the count), `X-Beltype-Deferred` (the count of Caster's deferrals) and `X-Beltype-Standard`, what the file claims as Caster reports it: `pdf-2.0; pdf-ua-2`, or `pdf-2.0` alone under `caster.standard=none` or where Caster guessed a tag and withdrew the claim (a print under `beltype.printer=chromium` is Chromium's own file and carries none); `422` with `beltype print`'s sentence where the document is refused (a file it asked for and was not given, among them); `400` for a bad request; `413` over the upload limit; `504` over the time limit; `500` otherwise, after which the browser is restarted.
- `GET /health`: `{ "status": "up", "chromium": …, "prints": …, "queued": … }`, or `503` with `"status": "restarting"` while the browser starts again.
- `--host 127.0.0.1`, `--port 3000`, `--max-upload 50` (MB), `--timeout 60` (seconds per print), `--restart-after 100` (prints before the browser is restarted), `--allowed-hosts <name[:port],…>` (the `Host` values it answers besides the bound address; a name with no port is that name on any port), `--no-sandbox` (as `beltype print`'s).
- A request whose `Host` is not the bound address and port, or whose `Origin` is another page's, is refused with `403` before its body is read, since any page in a browser can post a form without asking first. Bound to `0.0.0.0` or `::`, the server cannot know the name it is reached by, so it answers only the names `--allowed-hosts` lists, and without the list it refuses to start: `beltype serve --host 0.0.0.0 --port 3000 --allowed-hosts beltype-serve:3000`, for a container its neighbours reach as `beltype-serve`. On a loopback bind the list is accepted and not needed.
- Why a list: a page in your browser can make a name it controls resolve to your machine (DNS rebinding), and its requests then arrive from its own origin under its own `Host`, so the `Origin` check alone passes them. Only a server that knows which names it answers can refuse them, and on a wildcard bind only you can tell it.
- A document whose text, its JSON-LD data blocks (`<script type="application/ld+json">`, which never run) aside, holds no `<script`, `<iframe`, `<object`, `<embed`, `<frame`, `<portal`, `javascript:` or `on…=` attribute is printed on one kept page, re-seated for each print as Caster's kept frame is (`document.open()` keeps the realm, so Caster's registry and the companions' modules stay warm); any other document gets a page of its own, because a script's timers, listeners and globals would outlive it on a kept `Window`. The log line of each print names the road (`road kept` or `road fresh`) and the time of every step. A print that fails or times out closes the kept page.
- `POST /templates`: a mail merge's template, the same form as `/print`, once. It answers `201` and `{ "template": "<id>" }`; uploading the same files and flags again is the same id. A template has a data block (`<script type="application/ld+json">`) and no script of its own. The server keeps the last sixteen.
- `POST /templates/<id>/print`: one customer as JSON, `{ "values": { … }, "rows": { "<table>": [ { … } ] }, "created": "…" }`. `values` are set on the document's item, `rows` fill each `<template data-repeat>` of that name, and a cell is a string or, for a typed column, `{ "value": 7398.4, "text": "7.398,4" }`. It answers what `/print` answers. The merge runs in the tab with `prosemirror-stores`, on the same page for every customer: only the top-level boxes that changed are replaced, and the PDF is the one `/print` makes of the same merged document. A customer who changes the shape of the body, such as rows directly in `<body>`, has the template seated again, and the log line says why.
- One print runs at a time; the others wait their turn. After every start the server prints a built-in document twice under forme (the log shows both writes), so the first request is warm.
- It binds `127.0.0.1` unless `--host` says otherwise, and a page's own requests reach no network: a document that asks for anything it was not posted is refused by name, as in `beltype print`. The limit: a document's dedicated or shared worker passes no route, so what a worker fetches is not refused. The built-in warm-up document ships one font, Source Sans 3 (SIL OFL), in `assets/warmup/`.

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
- `content()` in `string-set` includes the heading's `::before`, so the sample's running section reads "3. Results" from `content()` alone. This is Caster's, not Cicero's: Caster's preparation turns the heading's `::before` into a real span before Cicero cuts, and `content()` then reads it.

## Requirements

Node 22 or later, and Playwright's headless shell for `playwright-core` 1.63.0:

```bash
npx playwright-core@1.63.0 install chromium-headless-shell
```

The companions come from npm, pinned exactly: `@beltype/cicero` 0.1.10, `@beltype/caster` 0.2.5 and `@beltype/common` 0.1.2.

The package is a binary, not a module: it has no `exports` map and ships no typings, so `import '@beltype/cli'` is not a supported road until a consumer asks for one.

## Working on it

```bash
pnpm install
pnpm run check    # tsc over src and test, strict
pnpm test         # prints the specimen under each printer, and reads the files back with mupdf
pnpm run build    # dist/, which the beltype command runs
```
