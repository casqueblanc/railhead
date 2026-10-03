// `node scripts/demoSeed/cli.ts <seed|reset|bundle> ...`: the demo seed and reset commands.
//
//   seed --dry-run      plan the seed of demo/upload-app and name every target
//   reset --dry-run     plan the reset, which deletes demo/upload-app and nothing else
//   bundle --out FILE   write the imported main as a Git bundle for the owner to push
//
// `--org` and `--repo` may be given, and anything but demo/upload-app is refused. Seed and reset
// only plan: no live target exists yet, and the owner's steps are in `docs/demo-seed.md`. Nothing
// here creates a Cloudflare resource or reads a secret.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { planHistory, writeHistoryBundle, type ImportedHistory } from "./history.ts";
import { assertDemoTarget, assertMatchesChecks, loadManifest, SeedRefusal } from "./manifest.ts";
import { MemoryTarget } from "./memoryTarget.ts";
import { describePlan, planReset, planSeed } from "./reconcile.ts";

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

  const manifest = loadManifest(values.manifest);
  assertDemoTarget(values.org ?? manifest.org, values.repo ?? manifest.repo);
  const sourceRoot = values["source-root"];
  assertMatchesChecks(manifest, readChecks(join(sourceRoot, manifest.source)));

  switch (command) {
    case "seed": {
      requireDryRun(values["dry-run"], "seed");
      const history = planHistory(sourceRoot, values.revision, manifest.source);
      return [
        ...header(history),
        ...describePlan(await planSeed(manifest, history, new MemoryTarget())),
        ...decisionLines(
          manifest.decision.key,
          manifest.decision.options.map((o) => o.key),
        ),
      ];
    }
    case "reset": {
      requireDryRun(values["dry-run"], "reset");
      // Planned against an instance holding the demo repository, so the deletion is listed.
      const target = new MemoryTarget();
      await target.createRepo({ org: manifest.org, repo: manifest.repo });
      return describePlan(await planReset(manifest, target));
    }
    case "bundle": {
      if (values.out === undefined) throw new SeedRefusal("bundle needs --out FILE.");
      const history = writeHistoryBundle(
        sourceRoot,
        values.revision,
        manifest.source,
        resolve(values.out),
      );
      return [...header(history), `wrote ${resolve(values.out)}`];
    }
    default:
      throw new SeedRefusal("Usage: cli.ts <seed|reset> --dry-run | bundle --out FILE");
  }
}

function readChecks(appRoot: string): unknown {
  const path = join(appRoot, "acceptance", "checks.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SeedRefusal(`Cannot read the app's acceptance checks at ${path}.`, { cause: error });
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
