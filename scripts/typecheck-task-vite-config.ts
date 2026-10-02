/**
 * Shared Vite+ type-check task, used by each package's `vite.config.ts` and reached as
 * `@foreman/scripts/typecheck-task`.
 *
 * Never cached. Vite+ fingerprints a cached task by the files it observes the command reading, and
 * it does not observe the reads of the native TypeScript 7 compiler: measured on macOS with
 * vite-plus 1.0.0 and typescript 7.0.2, a type error added to a source file replayed the previous
 * pass from the cache. An uncached check costs about a second per package; a replayed pass on
 * changed sources costs the type safety `pnpm build` exists to provide.
 *
 * Re-measure before caching it: break a type in a tracked file, run `pnpm build` twice, and require
 * the second run to fail.
 */
export const typeCheckTask = (
  command: string | string[] = "tsc",
): { command: string | string[]; cache: false } => ({ command, cache: false });
