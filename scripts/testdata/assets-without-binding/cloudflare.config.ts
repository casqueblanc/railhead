import { defineRailheadWorker, type WranglerExtras } from "../../worker-config.ts";

export default defineRailheadWorker({ name: "fixture", entrypoint: "src/index.ts" });

export const wrangler = { assetsDirectory: "../site/dist" } satisfies WranglerExtras;
