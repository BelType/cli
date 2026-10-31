#!/usr/bin/env node
/**
 * The `beltype` executable: turns on Node's compile cache, then runs `main.ts`.
 *
 * @remarks
 * The cache has to be on before the modules it covers are loaded, and a static import is loaded before the importing file's own statements run, so the command itself lives in `main.ts` and is imported here once the cache is enabled. The cache is Node's own, in the operating system's temporary directory (`node-compile-cache`), and holds compiled code only: a few megabytes, rebuilt if it is deleted.
 *
 * @packageDocumentation
 */

import { enableCompileCache } from 'node:module';

enableCompileCache();
await import('./main.ts');
