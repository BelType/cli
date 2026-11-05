# Changelog

## Unreleased

- **The cut waits for the faces an SVG image's text needs.** `beltype print` awaits Caster's `prepare(document).ready` before Cicero cuts, so a face only an SVG `<img>` names is loaded first and embedded (codeberg.org/BelType/caster issue 11). With a Caster that has no `ready`, nothing changes.
- **A JSON-LD data block no longer costs the kept page.** `<script type="application/ld+json">`, with that one attribute, is data the browser never runs, so `beltype serve` leaves it out of the script test, up to its first `</script`.
- **A mail-merge test** (`test/mail-merge.test.ts`): one bill template, twenty customers. prosemirror-stores opens each customer's values and meter readings as the template's graph, its binds compute the days and the consumption, `writeMicrodata` fills the fields, and every bill prints through `beltype serve` on the kept page, each with its own customer and totals and nothing of the bill before it. On the Mac, twenty bills merged and printed in about 1.9 s.

## 0.1.7 — 2026-11-04

- **Caster 0.1.7**: an image that prints far above its target is reduced before the list (`downsampleImages`, on by default: 300 ppi for anything above 450, Caster's own Catmull-Rom), with `imageResolution`, `downsampleThreshold` and `downsampleType` beside it as `--flag caster.<name>=<value>`; and a `<canvas>` figure prints. Cicero 0.1.6 and common 0.1.2 are unchanged. No code change in the command.

## 0.1.6 — 2026-11-04

- **`beltype serve` keeps one print page.** A document with no script of its own is written into it with `document.open()`, so the realm, Caster's capability registry and the warmed code stay between prints; the previous Cicero client is let go with Cicero 0.1.6's `release()` first. A document that carries a `<script>`, an `<iframe>`, an `<object>`, an `<embed>`, a `javascript:` URL or an `on…=` attribute takes a fresh page, since the `Window` outlives `document.open()` and a script could watch the next client's document. A failed print discards the kept page. Measured on the Mac, medians of 20 warm prints of the paper: 570 ms to 271 ms. Every kept print is byte-identical to the same document printed alone (`test/serve.test.ts`).
- **The log line says where each print's time went**: the road (kept or fresh), the page, the load, the cut, the print, the close, and Caster's stages.
- **Cicero 0.1.6.** Caster 0.1.6 and common 0.1.2 are unchanged.

## 0.1.5 — 2026-11-03

- **`beltype serve`**, `beltype print` behind an HTTP door in Gotenberg's shape: `POST /print` (`multipart/form-data`, `index.html` and the files beside it, flags as plain fields) answers the PDF, and `GET /health` the server's state. One Chromium stays warm, and forme, Caster's Rust writer, stays warm in a shared worker that every document's page hands its display list to. Under forme the sample paper prints in 533 ms against `beltype print`'s 753, its write in about 50 ms against 133. One print runs at a time; the browser restarts after a crash, after `--restart-after` prints, and after a print over `--timeout`. It binds `127.0.0.1` and fetches nothing from a network. The warm-up document ships one font, Source Sans 3 (SIL OFL), in `assets/warmup/`.
- **Caster 0.1.6**, which carries forme behind `writer: 'forme'` and the shared worker the server keeps warm. Cicero 0.1.5 and common 0.1.2 are unchanged.
- **The print's steps leave `print()`** for `src/run.ts` (`documentAssets`, `servedHtml`, `routeCompanions`, `routeDocument`, `printOnPage`), so a server can share them; `print()` behaves, says and traces as before. The document's own files are answered on the page, the companions' and the refusals on the context.
- **`SOURCE_DATE_EPOCH`** sets the file's creation and modification dates, so the same document prints to the same bytes twice.

## 0.1.4 — 2026-11-03

- **Caster 0.1.5, Cicero 0.1.5 and common 0.1.2**, the first versions that carry the flags in one shape and the engine's own subpaths.
- **Flags in one shape.** `--flag <owner>.<name>=<value>`, repeatable, sets a row of Caster's, Cicero's or the command line's own table, each declared with `@beltype/common/flags`. `--printer` and `--check` are the command line's rows spelled plainly. `beltype print --help` lists every table. Every default reproduces today's behaviour.
- **`--printer chromium`.** Chromium's own print (`page.pdf()`) prints the pages Cicero presented, one sheet to a page; it refuses when the pages are not all one size. Caster stays the default. This reverses the earlier "one road" rule, at Egildo's request of 2026-10-30.
- **`--trace <file.json>`.** Where a run's time went: node's clock around each step, Cicero's `performance.measure` entries, Caster's report timings, the versions and the resolved flags. Written even when the run refuses.
- **`--check`.** Screenshots each presented page, rasterises the PDF at 96 dpi and diffs the pairs into `<name>.check/`. It reports and never fails.
- **The trace gains `caster.fonts`**, the per-instance milliseconds of Caster's report.
- **`mupdf` 1.28.1 is a dependency**, loaded only under `--check`. The import map the page gets now maps `@beltype/common/flags`, which Caster 0.1.4 imports. Needs `@beltype/common` 0.1.2, `@beltype/caster` 0.1.4 and `@beltype/cicero` 0.1.5.
- **Node's compile cache is on.** `cli.ts` is now a stub that calls `module.enableCompileCache()` and imports `main.ts`, where the command lives. A warm run of the sample paper saves about 35 ms of the 280 ms Node spends before `print()` starts. The cache is Node's own, in the temporary directory (`node-compile-cache`), about 2 MB.
- **A plain print does not load Caster's flag table in Node.** `flags.ts` imports each package's table when it is needed: `--flag caster.*`, `--help`, and the trace's `flags` field (loaded after the total is taken, so the trace does not count it). Caster resolves its own defaults in the page. About 30 ms off a warm print of the sample paper. Cicero's table is still loaded, because the run needs Cicero's engine in Node anyway.

## 0.1.3 — 2026-10-30

- **The sample paper lives in `@beltype/specimens`.** `samples/` is gone; the test prints `specimen('paper').entry` from the dev dependency `@beltype/specimens` 0.1.0, and its assertions are unchanged. No code change in the command.

## 0.1.2 — 2026-10-30

- **The companions come from npm.** `@beltype/caster`, `@beltype/cicero` and `@beltype/common` were Codeberg git addresses over SSH, which only an installer with a Codeberg key could reach; they are now `0.1.3`, `0.1.4` and `0.1.1`, exact, from npmjs.com. `private` is gone from `package.json`, so the package can be published. No code change.

## 0.1.1 — 2026-10-30

- **`@beltype/caster` moves to v0.1.2**, which draws a word Blink hyphenates as Blink lays it out.
- **The sample paper sets `hyphens: auto`** again, and the test holds that a line ends in a hyphenated word.

## 0.1.0 — 2026-10-30

- **`beltype print <file.html> [-o <file.pdf>]`**: a finished HTML document to PDF through Cicero and Caster in Playwright's headless shell, with no Chromium print. Every request is answered from the document's folder or the companions' built files on a made-up `.invalid` origin; anything else is refused by name and no file is written.
- **Companions by git tag**: `@beltype/cicero` v0.1.3, `@beltype/caster` v0.1.1, `@beltype/common` v0.1.0; `playwright-core` pinned at 1.63.0.
- **`samples/paper/`**, a short scientific article on A4: margin boxes from named strings and the page counter, `@page :first`, numbered sections, figures and tables, cross-references by number and by page, an SVG figure. Three pages print in under a second.
- **One end-to-end test** prints the sample and reads it back with mupdf.
- **Not yet**: the proxy that catches what routes cannot see (a worker's sockets), which the monorepo's `beltype cast` has; Markdown and configuration.
