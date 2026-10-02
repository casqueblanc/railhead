import { bindings, defineRailheadWorker, type WranglerExtras } from "../../worker-config.ts";

export default defineRailheadWorker({
  name: "fixture",
  entrypoint: "src/index.ts",
  env: { ASSETS: bindings.assets() },
});

export const wrangler = {
  build: { command: "build-it", watch_dir: "src" },
  assetsDirectory: "../site/dist",
} satisfies WranglerExtras;
