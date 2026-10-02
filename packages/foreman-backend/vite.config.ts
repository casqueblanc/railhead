// Vite+ per-package settings. The task definitions are shared by every package and ship as
// `@foreman/scripts`.
import { typeCheckTask } from "@foreman/scripts/typecheck-task";
import { vitestTask } from "@foreman/scripts/vitest-task";

export default {
  run: {
    tasks: {
      build: typeCheckTask(),
      test: vitestTask("vitest run"),
    },
  },
};
