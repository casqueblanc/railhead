// Decides whether a CI job must run for a pull request, from the paths the pull request changes.
// Each job in `.github/workflows/` pipes `git diff --name-only` into it as its first step and skips
// its remaining steps on `false`, so the job still reports success under its usual name.
//
//   git diff --no-renames --name-only HEAD^1 HEAD | node scripts/ci-changes.mjs <job>
//
// prints `run=true` or `run=false` for `$GITHUB_OUTPUT`. Plain JavaScript, like rust-check.mjs, so
// it runs on whatever Node the runner has, before any setup step.
//
// Each job lists the paths known not to be its inputs, and runs when any changed path falls outside
// that list. A path no list names, such as a new top-level directory, therefore runs every job, and
// so does a change to the workflows or to this file. Pushes to `main` never come through here: the
// workflows run every job on them.

/** Root Markdown (README.md, AGENTS.md, CLAUDE.md) and the license files. */
const ROOT_PROSE = /^(?:[^/]+\.md|LICENSE|NOTICE)$/;

/** Agent and review tooling configuration that no build, test or Cargo step reads. */
const AGENT_TOOLING = /^(?:\.agents|\.claude|\.opencodereview)\//;

const OTHER_WORKFLOWS = /^\.github\/workflows\/railhead-agent-labels\.yml$/;

/** Per job, the paths that are not its inputs. */
const NOT_INPUTS = {
  // `vp check` formats Markdown, TOML (Cargo.toml, rust-toolchain.toml) and every script, and
  // `pnpm engineering:check` reads engineering/, so only Rust sources and Cargo.lock are outside it.
  lint: [/\.rs$/, /^Cargo\.lock$/],
  // `pnpm build` and `pnpm test`: the TypeScript packages, scripts/ and the fixtures they share.
  test: [
    /^crates\//,
    /^(?:Cargo\.toml|Cargo\.lock|rust-toolchain\.toml)$/,
    /^scripts\/rust-check\.mjs$/,
    /^(?:docs|engineering)\//,
    ROOT_PROSE,
    AGENT_TOOLING,
    OTHER_WORKFLOWS,
  ],
  // `node scripts/rust-check.mjs`: Cargo reads its workspace, and the crates' tests read
  // fixtures/protocol and fixtures/auth.
  rust: [
    /^(?:packages|demo|docs|engineering|containers|patches)\//,
    /^fixtures\/(?:board|demo)\//,
    /^scripts\/(?!rust-check\.mjs$|ci-changes\.mjs$)/,
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json|vite\.config\.ts)$/,
    /^(?:\.node-version|\.npmrc)$/,
    ROOT_PROSE,
    AGENT_TOOLING,
    OTHER_WORKFLOWS,
  ],
};

// A renamed file must be listed under both names (`--no-renames`), so moving a file out of a job's
// inputs still runs that job. No paths means nothing to check.
const job = process.argv[2];
if (job === undefined || !Object.hasOwn(NOT_INPUTS, job)) {
  process.stderr.write(`ci-changes: expected one of ${Object.keys(NOT_INPUTS).join(", ")}\n`);
  process.exit(2);
}
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const paths = Buffer.concat(chunks)
  .toString("utf8")
  .split("\n")
  .filter((line) => line.length > 0);
const skippable = NOT_INPUTS[job];
const run = paths.some((path) => !skippable.some((pattern) => pattern.test(path)));
process.stderr.write(`ci-changes: ${paths.length} changed paths, ${job} run=${run}\n`);
process.stdout.write(`run=${run}\n`);
