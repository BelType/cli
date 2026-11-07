// Bundles src/merge-tab.ts with prosemirror-stores into assets/merge/merge.js, the one module the page imports for a mail merge. node scripts/bundle-merge.ts. esbuild keeps every licence comment, and assets/merge/NOTICE names what is inside.

import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';

export const options: BuildOptions = { entryPoints: ['src/merge-tab.ts'], bundle: true, format: 'esm', minify: true, legalComments: 'inline', target: 'chrome120', logLevel: 'warning' };

if (process.argv[1] === fileURLToPath(import.meta.url)) await build({ ...options, outfile: 'assets/merge/merge.js' });
