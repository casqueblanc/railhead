// What turns demo/upload-app into a repository that installs and runs its checks on its own.
//
// In this monorepo the app takes its versions from the pnpm catalog, its TypeScript settings from
// the root tsconfig.json, its workerd assertion from `@railhead/scripts` and its Vite+ tasks from
// the shared task definitions. None of those exist in the demo repository, so the import ends with
// one more commit that replaces them with the files below, read from the same source commit as the
// app. `standalone.test.ts` fails when these files drift from what the monorepo runs.

import type { OverlayEntry } from "./history.ts";

/** The directory holding the standalone files that have no other source in the monorepo. */
export const STANDALONE_FIXTURES = "fixtures/demo/standalone";

/** The subject of the commit that makes the imported app stand alone. */
export const STANDALONE_SUBJECT = "chore: make the app a standalone repository";

/** The files the last imported commit adds, replaces or removes, relative to the app's root. */
export const STANDALONE_OVERLAY: readonly OverlayEntry[] = [
  // Exact versions instead of `catalog:`, and no `@railhead/scripts` dependency.
  { path: "package.json", from: `${STANDALONE_FIXTURES}/package.json` },
  { path: "pnpm-lock.yaml", from: `${STANDALONE_FIXTURES}/pnpm-lock.yaml` },
  { path: "pnpm-workspace.yaml", from: `${STANDALONE_FIXTURES}/pnpm-workspace.yaml` },
  // The root compiler options inlined, rather than extending ../../tsconfig.json.
  { path: "tsconfig.json", from: `${STANDALONE_FIXTURES}/tsconfig.json` },
  // The same config, with the workerd assertion as a local file.
  { path: "vitest.config.ts", from: `${STANDALONE_FIXTURES}/vitest.config.ts` },
  { path: "assert-workerd.ts", from: "scripts/assert-workerd.ts" },
  { path: ".node-version", from: ".node-version" },
  // Only Vite+ reads it, and it imports the monorepo's shared task definitions.
  { path: "vite.config.ts", from: null },
];
