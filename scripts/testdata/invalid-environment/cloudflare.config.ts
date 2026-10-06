import { defineRailheadWorker } from "../../worker-config.ts";

export default defineRailheadWorker({ name: "fixture", entrypoint: "src/index.ts" });

// Not a Worker definition: the generator must refuse it rather than emit an empty environment.
export const qualification = { worker: { name: 42 } };
