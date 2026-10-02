/**
 * Vite+ settings for `@railhead/scripts`. Only a `test` task: this package holds the shared task
 * definitions other packages import, and has no build of its own (see `tsconfig.json`).
 *
 * `node --test`, not vitest: these suites assert on build tooling, and pulling vitest in would mean
 * the tooling under test and the runner testing it share a resolver.
 *
 * `cwd: '..'` because these are workspace-wide guards, not unit tests of this directory. They name
 * paths from the repo root.
 */
export default {
  run: {
    tasks: {
      test: {
        command: "node --test 'scripts/**/*.test.ts'",
        cwd: "..",
        cache: {
          // Workspace-wide, matching `cwd`: the suites read across `packages/` and the root
          // manifests, and a guard that stopped seeing a file it asserts about would cache-hit its
          // way to a stale pass. A suite here must therefore never write inside the workspace.
          input: [
            { auto: true },
            { pattern: "!**/node_modules/.vite/**", base: "workspace" },
            { pattern: "!**/node_modules/.vite-temp/**", base: "workspace" },
            { pattern: "!**/.wrangler/**", base: "workspace" },
          ],
          output: [],
        },
      },
    },
  },
};
