// Vite+ per-package settings, from the task definitions every package shares.
import { typeCheckTask } from "@railhead/scripts/typecheck-task";
import { vitestTask } from "@railhead/scripts/vitest-task";

const test = vitestTask("vitest run");

export default {
  run: {
    tasks: {
      build: typeCheckTask(),
      // The selected acceptance suite depends on UPLOAD_ACCEPTANCE, so it is part of the cache key.
      test: { ...test, cache: { ...test.cache, env: ["UPLOAD_ACCEPTANCE"] } },
    },
  },
};
