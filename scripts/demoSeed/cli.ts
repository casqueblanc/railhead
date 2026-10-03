// `node scripts/demoSeed/cli.ts <seed|reset|bundle> ...`: the demo seed and reset commands.
//
//   seed --dry-run      plan the seed of demo/upload-app, name every target and print each issue's
//                       exact title and body for the owner to file
//   reset --dry-run     plan the reset, which deletes demo/upload-app and nothing else
//   bundle --out FILE   write the imported main as the Git bundle the seed takes, main alone;
//                       refuses --dry-run, since seed --dry-run is the preview
//
// The manifest, the checks and the history are all read from `--revision`; `--manifest FILE` is
// an explicit override read from disk. `--org` and `--repo` may be given, and anything but
// demo/upload-app is refused. Seed and reset
// only plan: no live target exists yet, and the owner's steps are in `docs/demo-seed.md`. Nothing
// here creates a Cloudflare resource or reads a secret.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
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
} from "./manifest.ts";
import { MemoryTarget } from "./memoryTarget.ts";
import { describeIssues, describePlan, planReset, planSeed } from "./reconcile.ts";
import { STANDALONE_OVERLAY, STANDALONE_SUBJECT } from "./standalone.ts";

/** The repository root, which holds the default manifest and the demo app's history. */
const ROOT = resolve(import.meta.dirname, "..", "..");

/** The manifest's path in the source repository, read at the selected commit. */
const MANIFEST_PATH = "fixtures/demo/seed.json";

/** Runs one command and returns the lines it prints. Throws `SeedRefusal` on a refused request. */
export async function run(argv: readonly string[]): Promise<string[]> {
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
    },
  });
  const [command, ...extra] = positionals;
  if (extra.length > 0) throw new SeedRefusal(`Unexpected arguments: ${extra.join(" ")}.`);
  // Refused before any other work: a preview must never leave a bundle behind.
  if (command === "bundle" && values["dry-run"]) {
    throw new SeedRefusal("bundle has no dry run; use seed --dry-run to plan the import.");
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
  assertMatchesChecks(
    manifest,
    readJsonAt(
      sourceRoot,
      commit,
      `${manifest.source}/acceptance/checks.json`,
      "acceptance checks",
    ),
  );

  switch (command) {
    case "seed": {
      requireDryRun(values["dry-run"], "seed");
      const history = planHistory(request);
      const empty = new MemoryTarget();
      const plan = await planSeed(manifest, history, empty, empty);
      return [
        ...header(history),
        ...describePlan(plan),
        ...describeIssues(plan),
        ...decisionLines(
          manifest.decision.key,
          manifest.decision.options.map((o) => o.key),
        ),
        "note planned against an empty instance: no live target exists yet",
      ];
    }
    case "reset": {
      requireDryRun(values["dry-run"], "reset");
      return [...describePlan(planReset(manifest)), "note no live target exists yet"];
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

function requireDryRun(dryRun: boolean, command: string): void {
  if (!dryRun) {
    throw new SeedRefusal(
      `${command} has no live target yet; run it with --dry-run and follow docs/demo-seed.md.`,
    );
  }
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
    if (!(error instanceof SeedRefusal)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
