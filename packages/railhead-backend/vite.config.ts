// Vite+ per-package settings. The task definitions are shared by every package and ship as
// `@railhead/scripts`.
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
