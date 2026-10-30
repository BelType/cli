# Working on beltype

Read the [README](README.md) first.

- **One road**: Cicero cuts, Caster prints, in the headless shell. Never `page.pdf()`.
- **Every request is answered from disk or refused by name.** A run that refused anything writes no file.
- **The companions are dependencies, never copies.** A fix to pagination or printing lands in `codeberg.org/BelType/cicero` or `/caster`, is tagged there, and the pin here moves.
- **The functions in `src/in-page.ts` run in the page**: they close over nothing, and they import by literal URL, because a computed `import()` is wrapped by `rewriteRelativeImportExtensions` in a helper the page does not have.
- **A change to the sample is checked by eye**: print it and look at every page before trusting the test, which reads text only.
- TypeScript `strict` with `noUncheckedIndexedAccess`; errors are `@beltype/common/errors` subclasses; no hard-wrapping.
- New decision records go to `codeberg.org/BelType/decisions`.
