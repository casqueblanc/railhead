// `node scripts/demoSeed/cli.ts <seed|reset|bundle> ...`: the demo seed and reset commands.
//
//   seed --dry-run      plan the seed of demo/upload-app and name every target
//   reset --dry-run     plan the reset, which deletes demo/upload-app and nothing else
//   bundle --out FILE   write the imported main as the Git bundle the seed takes, main alone;
//                       refuses --dry-run, since seed --dry-run is the preview
//
// `--org` and `--repo` may be given, and anything but demo/upload-app is refused. Seed and reset
// only plan: no live target exists yet, and the owner's steps are in `docs/demo-seed.md`. Nothing
// here creates a Cloudflare resource or reads a secret.

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  planHistory,
  readFileAt,
  resolveCommit,
  writeHistoryBundle,
  type ImportedHistory,
  type ImportRequest,
} from "./history.ts";
import { assertDemoTarget, assertMatchesChecks, loadManifest, SeedRefusal } from "./manifest.ts";
import { MemoryTarget } from "./memoryTarget.ts";
import { describePlan, planReset, planSeed } from "./reconcile.ts";
import { STANDALONE_OVERLAY, STANDALONE_SUBJECT } from "./standalone.ts";

/** The repository root, which holds the default manifest and the demo app's history. */
const ROOT = resolve(import.meta.dirname, "..", "..");

/** Runs one command and returns the lines it prints. Throws `SeedRefusal` on a refused request. */
export async function run(argv: readonly string[]): Promise<string[]> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      manifest: { type: "string", default: join(ROOT, "fixtures", "demo", "seed.json") },
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

  const manifest = loadManifest(values.manifest);
  assertDemoTarget(values.org ?? manifest.org, values.repo ?? manifest.repo);
  // Resolved once, so the checks validated below and the history exported are the same commit's.
  const request: ImportRequest = {
    sourceRoot: values["source-root"],
    commit: resolveCommit(values["source-root"], values.revision),
    directory: manifest.source,
    overlay: STANDALONE_OVERLAY,
    overlaySubject: STANDALONE_SUBJECT,
  };
  assertMatchesChecks(manifest, readChecks(request));

  switch (command) {
    case "seed": {
      requireDryRun(values["dry-run"], "seed");
      const history = planHistory(request);
      const empty = new MemoryTarget();
      return [
        ...header(history),
        ...describePlan(await planSeed(manifest, history, empty, empty)),
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

/** The app's acceptance checks as committed at the import's commit, never the working tree's. */
function readChecks({ sourceRoot, commit, directory }: ImportRequest): unknown {
  const path = `${directory}/acceptance/checks.json`;
  // A missing file is already a refusal; a failure to read the repository is not one.
  const text = readFileAt(sourceRoot, commit, path);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SeedRefusal(`The app's acceptance checks at ${commit}:${path} are not JSON.`, {
      cause: error,
    });
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
