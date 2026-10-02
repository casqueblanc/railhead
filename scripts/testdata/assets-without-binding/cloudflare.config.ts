import { defineForemanWorker, type WranglerExtras } from "../../worker-config.ts";

export default defineForemanWorker({ name: "fixture", entrypoint: "src/index.ts" });

export const wrangler = { assetsDirectory: "../site/dist" } satisfies WranglerExtras;
