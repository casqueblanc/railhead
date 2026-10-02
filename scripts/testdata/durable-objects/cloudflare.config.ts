import { defineRailheadWorker } from "../../worker-config.ts";

export default defineRailheadWorker({
  name: "fixture",
  entrypoint: "src/index.ts",
  env: {
    OWN: { type: "durable-object", worker: "fixture", exportName: "Own" },
    OTHER: { type: "durable-object", worker: "other-worker", exportName: "Theirs" },
  },
  exports: { Own: { type: "durable-object", storage: "sqlite" } },
});
