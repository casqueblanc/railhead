// Shared building blocks for every cloudflare.config.ts in this repo. Each config's default export
// is the @cloudflare/config Worker definition; its named `wrangler` export carries the Wrangler
// settings that format has no field for. scripts/generate-worker-configs.ts turns both into the
// committed, generated wrangler.jsonc beside it.
import { defineConfig, type WorkerConfig } from "@cloudflare/config";

export { bindings } from "@cloudflare/config";

/** Workers runtime compatibility date of every Worker here, and of the test pools that model them. */
export const COMPATIBILITY_DATE = "2026-09-30";

/** Observability settings shared by the deployed Workers. */
export const OBSERVABILITY = {
  enabled: true,
  headSamplingRate: 1,
  logs: { invocationLogs: false },
} satisfies NonNullable<WorkerConfig["observability"]>;

/** Wrangler's custom build step, in Wrangler's own snake_case shape. */
export interface WranglerBuild {
  command: string;
  watch_dir?: string;
}

/** The capnweb-validate prebuild: Wrangler bundles its output under `.wrangler/validate`. */
export const CAPNWEB_VALIDATE_BUILD: WranglerBuild = {
  command: "pnpm exec capnweb-validate build --out .wrangler/validate",
  watch_dir: "src",
};

/**
 * Wrangler settings with no @cloudflare/config field. The generator copies `build` verbatim into
 * the generated wrangler.jsonc.
 */
export interface WranglerExtras {
  build?: WranglerBuild;
  /** Emitted as `assets.directory`; requires an assets binding in `env`. */
  assetsDirectory?: string;
}

/** `defineConfig` for one Worker, with the repo-wide compatibility date filled in. */
export function defineForemanWorker(worker: Omit<WorkerConfig, "compatibilityDate">) {
  return defineConfig({ worker: { compatibilityDate: COMPATIBILITY_DATE, ...worker } });
}
