#!/usr/bin/env node

// Generates each Worker's committed wrangler.jsonc from the cloudflare.config.ts beside it.
//
// Wrangler's own support for cloudflare.config.ts covers only dev/build/deploy/versions and rejects
// `--config`, which rules out `wrangler types` and the Workers test pool. So the TypeScript file is
// the source of truth and wrangler.jsonc a generated artifact every existing consumer keeps
// reading; `pnpm configs:check` (CI's lint job) keeps the two in step.
//
// Usage: node scripts/generate-worker-configs.ts [--check]

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convertToWranglerConfig, resolveAndParseConfig } from "@cloudflare/config";
import type { WranglerExtras } from "./worker-config.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const SOURCE_NAME = "cloudflare.config.ts";
const GENERATED_NAME = "wrangler.jsonc";
const HEADER =
  "// Generated from cloudflare.config.ts by scripts/generate-worker-configs.ts -- do not edit.\n" +
  "// Change cloudflare.config.ts and run `pnpm configs:generate`.\n";

/** Named exports a cloudflare.config.ts may have; anything else is a typo the generator rejects. */
const READ_EXPORTS = ["default", "wrangler"];

/**
 * Every package directory holding a Worker config. A directory with only a wrangler.jsonc is kept
 * so that a hand-written one fails.
 */
export function workerConfigDirs(): string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_DIR, entry.name))
    .filter((dir) => existsSync(join(dir, SOURCE_NAME)) || existsSync(join(dir, GENERATED_NAME)))
    .toSorted();
}

/** The wrangler.jsonc text generated from `dir`'s cloudflare.config.ts. */
export async function renderWorkerConfig(dir: string): Promise<string> {
  const rel = relative(ROOT, dir) || ".";
  const sourcePath = join(dir, SOURCE_NAME);
  if (!existsSync(sourcePath)) {
    throw new Error(
      `${rel}/wrangler.jsonc has no cloudflare.config.ts beside it; worker configs ` +
        "are authored in TypeScript (see scripts/worker-config.ts)",
    );
  }

  // Dynamic: the config path is only known at runtime. Node strips the types.
  const mod: Record<string, unknown> = await import(pathToFileURL(sourcePath).href);
  const unknown = Object.keys(mod).find((key) => !READ_EXPORTS.includes(key));
  if (unknown) {
    throw new Error(
      `${rel}/cloudflare.config.ts exports ${unknown}; only default and wrangler are read`,
    );
  }

  const parsed = await resolveAndParseConfig(mod.default, { isPreview: false, mode: undefined });
  if (!parsed.success) {
    throw new Error(
      `${rel}/cloudflare.config.ts is invalid:\n` +
        parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"),
    );
  }
  const config = convertToWranglerConfig(parsed.data);

  // Typed by the config's own `satisfies WranglerExtras`, which `pnpm types:scripts` checks.
  const extras = (mod.wrangler ?? {}) as WranglerExtras;
  if (extras.assetsDirectory !== undefined) {
    if (!config.assets || config.assets.directory !== undefined) {
      throw new Error(
        `${rel}: wrangler.assetsDirectory needs an assets binding in env that ` +
          "sets no directory of its own",
      );
    }
    config.assets = { ...config.assets, directory: extras.assetsDirectory };
  }

  // An undefined `build` drops out of the JSON.
  return HEADER + JSON.stringify({ ...config, build: extras.build }, null, 2) + "\n";
}

/**
 * Regenerates every Worker's wrangler.jsonc, writing only files whose content changed. With
 * `check`, writes nothing. Returns the repo-relative paths that differed.
 */
export async function generateWorkerConfigs({ check }: { check: boolean }): Promise<string[]> {
  const dirs = workerConfigDirs();
  const rendered = await Promise.all(dirs.map(renderWorkerConfig));
  return dirs.flatMap((dir, i) => {
    const text = rendered[i];
    if (text === undefined) return [];
    const path = join(dir, GENERATED_NAME);
    if (existsSync(path) && readFileSync(path, "utf8") === text) return [];
    const rel = relative(ROOT, path);
    if (!check) {
      writeFileSync(path, text);
      console.log(`gen ${rel}`);
    }
    return [rel];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  const stale = await generateWorkerConfigs({ check });
  if (check && stale.length > 0) {
    console.error(
      `worker configs out of date (run \`pnpm configs:generate\`):\n  ${stale.join("\n  ")}`,
    );
    process.exitCode = 1;
  }
}
