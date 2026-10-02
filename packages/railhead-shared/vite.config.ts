// Vite+ per-package settings: `build` is this package's type check.
import { typeCheckTask } from "@railhead/scripts/typecheck-task";

export default {
  run: {
    tasks: {
      build: typeCheckTask(),
    },
  },
};
