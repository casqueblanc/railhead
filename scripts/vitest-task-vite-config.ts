/**
 * Shared Vite+ `test` task for every package whose tests run under vitest, used by each such
 * package's `vite.config.ts`. Plain objects rather than `defineConfig`, so the packages need no
 * resolvable `vite-plus` import of their own. The task types below are structural copies of
 * Vite+'s rather than imports of them, which is what keeps that true.
 *
 * Reached as `@railhead/scripts/vitest-task`, an `exports` subpath of this directory's package. This
 * module is loaded by `node` as well as by vite -- vp resolves it through the `exports` map when it
 * loads a consumer's task graph -- so intra-directory imports must name the file on disk.
 *
 * `test` is a task rather than a package.json script so the scratch paths every `vitest run` writes
 * and then reads back can be kept out of the fingerprint: vp declines to cache a task that reads a
 * path it also wrote. vp forbids a task and a script sharing a name, so the packages have a
 * `test:run` script for direct runs and `vp run -F <package> test` for the cached one.
 */

/** A glob paired with the directory its pattern resolves against. */
export type GlobWithBase = {
  pattern: string;
  base: "package" | "workspace";
};

/** The subset of a Vite+ task this factory produces. */
export type VitestTask = {
  command: string | string[];
  cache: {
    input: (GlobWithBase | { auto: boolean })[];
    output: (GlobWithBase | { auto: boolean })[];
  };
};

/**
 * Paths vitest and wrangler generate and read back on the next run, excluded from both the
 * fingerprint and the archived outputs:
 *
 * - `node_modules/.vite/vitest/<project-hash>/results.json` -- per-file durations and pass/fail,
 *   read by vitest's sequencer.
 * - `node_modules/.vite-temp/*.config.ts.timestamp-*.mjs` -- vite compiles a TS config to a temp
 *   module here. The name carries a timestamp, so no run could match a previous fingerprint.
 * - `.wrangler/**` -- the capnweb-validate build tree and wrangler's per-run scratch. The tree is
 *   derived from sources the same task already tracks, so dropping it loses no invalidation.
 *
 * Workspace-wide rather than package-relative: tracking reaches past the package that owns the
 * task, so a sibling's scratch files would otherwise invalidate this package.
 *
 * When a test task stops caching, `vp run --last-details` names the path it read and wrote -- add
 * it here if it is shared, or at the call site if it is one package's own.
 */
export const SCRATCH_EXCLUSIONS: GlobWithBase[] = [
  { pattern: "!**/node_modules/.vite/**", base: "workspace" },
  { pattern: "!**/node_modules/.vite-temp/**", base: "workspace" },
  { pattern: "!**/.wrangler/**", base: "workspace" },
];

/**
 * The `test` task for a package, given its vitest invocation. An array of commands is run in order
 * and cached as one entry per command. `extraExclusions` adds package-specific patterns, such as a
 * build output the package's own tests track.
 */
export function vitestTask(
  command: string | string[],
  extraExclusions: GlobWithBase[] = [],
): VitestTask {
  const exclusions = [...SCRATCH_EXCLUSIONS, ...extraExclusions];
  return {
    command,
    cache: {
      input: [{ auto: true }, ...exclusions],
      output: [{ auto: true }, ...exclusions],
    },
  };
}
