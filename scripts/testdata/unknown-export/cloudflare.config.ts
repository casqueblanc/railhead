import { defineForemanWorker } from "../../worker-config.ts";

export default defineForemanWorker({ name: "fixture", entrypoint: "src/index.ts" });

// Misspelled on purpose: the generator reads only `default` and `wrangler`.
export const wranglr = {};
