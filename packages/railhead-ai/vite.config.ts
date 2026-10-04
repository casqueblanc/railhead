// Vite+ per-package settings: `build` is this package's type check.
import { typeCheckTask } from "@railhead/scripts/typecheck-task";
import { vitestTask } from "@railhead/scripts/vitest-task";

export default {
  run: {
    tasks: {
      build: typeCheckTask(),
      test: vitestTask("vitest run"),
    },
  },
};
