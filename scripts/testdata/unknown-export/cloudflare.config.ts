import { defineRailheadWorker } from "../../worker-config.ts";

export default defineRailheadWorker({ name: "fixture", entrypoint: "src/index.ts" });

// Misspelled on purpose: the generator reads only `default` and `wrangler`.
export const wranglr = {};
