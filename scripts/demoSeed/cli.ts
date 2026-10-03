// `node scripts/demoSeed/cli.ts <seed|reset|bundle> ...`: the demo seed and reset commands.
//
//   seed --dry-run      plan the seed of demo/upload-app, name every target and print each issue's
//                       exact title and body for the owner to file; it builds the bundle in
//                       scratch, so it refuses whatever bundle refuses, and writes nothing
//   reset --dry-run     plan the reset, which deletes demo/upload-app and nothing else
//   seed|reset --target ORIGIN [--assertion FILE]
//                       run against the deployed Railhead at ORIGIN; with --dry-run, plan against it
//   bundle --out FILE   write the imported main as the Git bundle the seed takes, main alone;
//                       refuses --dry-run, since seed --dry-run is the preview
//
// The manifest, the checks, the paths the manifest names and the history are all read from
// `--revision`; `--manifest FILE` is an explicit override read from disk. Reset reads none of them:
// it deletes the demo repository by name, so a commit whose manifest or checks are inconsistent
// cannot block the way out. `--org` and `--repo` may be given, and anything but demo/upload-app is
// refused.
//
// Without `--target`, seed and reset only plan, against an empty instance. With it they read the
// live `DemoSeedApi` and, without `--dry-run`, write. Each write needs an owner passkey assertion,
// and there is no command-line signer yet (#148): without `--assertion` the write stops after
// `prepare`, prints the challenge and exits 3, writing nothing; `--assertion FILE` performs it with
// `{ challengeId, assertion }` the owner signed for that challenge. The owner's steps are in
// `docs/demo-seed.md`. A refusal exits 2; a backend failure or timeout prints the backend's sentence
// and exits 1. Nothing here creates a Cloudflare resource or reads a secret.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  buildMainBundle,
  hasPathAt,
  planHistory,
  readFileAt,
  resolveCommit,
  writeHistoryBundle,
  type ImportedHistory,
  type ImportRequest,
} from "./history.ts";
import {
  assertDemoTarget,
  assertMatchesChecks,
  loadManifest,
  parseManifest,
  SeedRefusal,
  type SeedManifest,
} from "./manifest.ts";
import {
  ApprovalNeeded,
  BackendFailure,
  LiveTarget,
  liveApiUrl,
  openLiveSession,
  parseSignedApproval,
  type Approval,
  type LiveSession,
} from "./liveTarget.ts";
import { MemoryTarget } from "./memoryTarget.ts";
import {
  DEMO_REF,
  describeIssues,
  describePlan,
  planReset,
  planSeed,
  reset,
  seed,
} from "./reconcile.ts";
import { STANDALONE_OVERLAY, STANDALONE_SUBJECT } from "./standalone.ts";

/** The repository root, which holds the default manifest and the demo app's history. */
const ROOT = resolve(import.meta.dirname, "..", "..");

/** The manifest's path in the source repository, read at the selected commit. */
const MANIFEST_PATH = "fixtures/demo/seed.json";

/** Opens the session `--target` names; tests pass their own. */
export type OpenSession = (origin: string) => LiveSession;

/**
 * Runs one command and returns the lines it prints. Throws `SeedRefusal` on a refused request and
 * `ApprovalNeeded` when a live write stopped after `prepare`.
 */
export async function run(
  argv: readonly string[],
  openSession: OpenSession = openLiveSession,
): Promise<string[]> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      manifest: { type: "string" },
      "source-root": { type: "string", default: ROOT },
      revision: { type: "string", default: "HEAD" },
      org: { type: "string" },
      repo: { type: "string" },
      out: { type: "string" },
      target: { type: "string" },
      assertion: { type: "string" },
    },
  });
  const [command, ...extra] = positionals;
  if (extra.length > 0) throw new SeedRefusal(`Unexpected arguments: ${extra.join(" ")}.`);
  // Refused before any other work: a preview must never leave a bundle behind.
  if (command === "bundle" && values["dry-run"]) {
    throw new SeedRefusal("bundle has no dry run; use seed --dry-run to plan the import.");
  }
  const live = liveOptions(values.target, values.assertion, values["dry-run"]);
  if (command === "reset") {
    const ref = { org: values.org ?? DEMO_REF.org, repo: values.repo ?? DEMO_REF.repo };
    const plan = describePlan(planReset(ref));
    if (live === null) {
      requireDryRun(values["dry-run"], "reset");
      return [...plan, "note planned without a target: pass --target ORIGIN to run it"];
    }
    if (values["dry-run"]) return [...plan, `note planned for ${live.origin}`];
    using session = openSession(live.origin);
    const deleted = await reset(ref, new LiveTarget(session, live.approval));
    return [
      ...plan,
      deleted ? `deleted ${ref.org}/${ref.repo}` : `${ref.org}/${ref.repo} held nothing to delete`,
    ];
  }

  // Resolved once, so the manifest, the checks validated below and the history exported are the
  // same commit's.
  const sourceRoot = values["source-root"];
  const commit = resolveCommit(sourceRoot, values.revision);
  const manifest =
    values.manifest === undefined
      ? parseManifest(readJsonAt(sourceRoot, commit, MANIFEST_PATH, "manifest"))
      : loadManifest(resolve(values.manifest));
  assertDemoTarget(values.org ?? manifest.org, values.repo ?? manifest.repo);
  const request: ImportRequest = {
    sourceRoot,
    commit,
    directory: manifest.source,
    overlay: STANDALONE_OVERLAY,
    overlaySubject: STANDALONE_SUBJECT,
  };
  const suites = assertMatchesChecks(
    manifest,
    readJsonAt(
      sourceRoot,
      commit,
      `${manifest.source}/acceptance/checks.json`,
      "acceptance checks",
    ),
  );
  assertPathsInApp(sourceRoot, commit, manifest, suites);

  switch (command) {
    case "seed": {
      const decision = decisionLines(
        manifest.decision.key,
        manifest.decision.options.map((o) => o.key),
      );
      if (live === null) {
        requireDryRun(values["dry-run"], "seed");
        const history = planHistory(request);
        const empty = new MemoryTarget();
        const plan = await planSeed(manifest, history, empty, empty);
        return [
          ...header(history),
          ...describePlan(plan),
          ...describeIssues(plan),
          ...decision,
          "note planned against an empty instance, so every issue shows as still to file: plan with --target ORIGIN before filing any",
        ];
      }
      using session = openSession(live.origin);
      const target = new LiveTarget(session, live.approval);
      if (values["dry-run"]) {
        const history = planHistory(request);
        const plan = await planSeed(manifest, history, target, target);
        return [
          ...header(history),
          ...describePlan(plan),
          ...describeIssues(plan),
          ...decision,
          `note planned against ${live.origin}`,
        ];
      }
      const bundle = buildMainBundle(request);
      const plan = await seed(manifest, bundle, target, target);
      return [...header(bundle), ...describePlan(plan), ...describeIssues(plan), ...decision];
    }
    case "bundle": {
      if (values.out === undefined) throw new SeedRefusal("bundle needs --out FILE.");
      const history = writeHistoryBundle(request, resolve(values.out));
      return [...header(history), `wrote ${resolve(values.out)}`];
    }
    default:
      throw new SeedRefusal("Usage: cli.ts <seed|reset> --dry-run | bundle --out FILE");
  }
}

/** A JSON file as committed at `commit`, never the working tree's. */
function readJsonAt(sourceRoot: string, commit: string, path: string, what: string): unknown {
  // A missing file is already a refusal; a failure to read the repository is not one.
  const text = readFileAt(sourceRoot, commit, path);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SeedRefusal(`The ${what} at ${commit}:${path} is not JSON.`, { cause: error });
  }
}

/**
 * Refuses a decision scope, issue path or acceptance suite the app does not have at `commit`. The
 * manifest's collision check compares only its own strings, so a renamed or misspelt file would
 * leave two issues colliding on paper over code neither of them changes; a missing suite would
 * leave its option with no check to run once the decision chooses it.
 */
function assertPathsInApp(
  sourceRoot: string,
  commit: string,
  manifest: SeedManifest,
  suites: readonly string[],
): void {
  const named = [
    ...manifest.decision.scope.map((path) => ({ field: "decision.scope", path })),
    ...manifest.issues.flatMap((issue, index) =>
      issue.touches.map((path) => ({ field: `issues[${index}].touches`, path })),
    ),
    ...suites.map((path) => ({ field: "checks.json suite", path })),
  ];
  const missing = named
    .filter(({ path }) => !hasPathAt(sourceRoot, commit, `${manifest.source}/${path}`))
    .map(({ field, path }) => `${field} ${path}`);
  if (missing.length > 0) {
    throw new SeedRefusal(`${commit}:${manifest.source} has no ${missing.join(", ")}.`);
  }
}

function requireDryRun(dryRun: boolean, command: string): void {
  if (!dryRun) {
    throw new SeedRefusal(
      `${command} writes only with --target ORIGIN; run it with --dry-run to plan, and follow docs/demo-seed.md.`,
    );
  }
}

/** The live origin and the approval for its one write, or `null` without `--target`. */
function liveOptions(
  target: string | undefined,
  assertion: string | undefined,
  dryRun: boolean,
): { origin: string; approval: Approval } | null {
  if (target === undefined) {
    if (assertion !== undefined) throw new SeedRefusal("--assertion needs --target ORIGIN.");
    return null;
  }
  // Refused before any session opens or any file is read.
  liveApiUrl(target);
  if (assertion === undefined) return { origin: target, approval: { kind: "prepare" } };
  // A dry run never writes, so it must not hold an assertion that would let it.
  if (dryRun) throw new SeedRefusal("--assertion approves a write; a dry run has none.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(assertion), "utf8"));
  } catch (error) {
    throw new SeedRefusal(`${assertion} is not a readable JSON file.`, { cause: error });
  }
  return { origin: target, approval: parseSignedApproval(parsed) };
}

/**
 * What a write that stopped after `prepare` prints: the action, the challenge to sign, and how to
 * finish. The challenge holds no secret; it is spent only with the owner's assertion.
 */
export function describeApproval(needed: ApprovalNeeded): string[] {
  const { action, challenge } = needed;
  const what = action.kind === "demo.seed" ? `${action.kind} of main ${action.head}` : action.kind;
  return [
    `stopped after prepare: ${what} needs an owner passkey assertion; nothing was written`,
    "note there is no command-line passkey signer yet (#148)",
    `challenge ${JSON.stringify(challenge)}`,
    `note sign it with the owner passkey before ${new Date(challenge.expiresAt).toISOString()}, write { "challengeId", "assertion" } to a file, and rerun this command with --assertion FILE`,
  ];
}

function header(history: ImportedHistory): string[] {
  return [`main ${history.head} (${history.commits} commits, full history)`];
}

function decisionLines(key: string, options: readonly string[]): string[] {
  return [
    `note decision ${key} (${options.join(", ")}) is opened by an agent's question, not seeded`,
  ];
}

if (import.meta.main) {
  try {
    for (const line of await run(process.argv.slice(2))) process.stdout.write(`${line}\n`);
  } catch (error) {
    if (error instanceof ApprovalNeeded) {
      for (const line of describeApproval(error)) process.stdout.write(`${line}\n`);
      process.exitCode = 3;
    } else if (error instanceof SeedRefusal) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    } else if (error instanceof BackendFailure) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
