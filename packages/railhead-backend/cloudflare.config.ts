import {
  CAPNWEB_VALIDATE_BUILD,
  OBSERVABILITY,
  bindings,
  defineRailheadWorker,
  type WranglerExtras,
} from "@railhead/scripts/worker-config";

export default defineRailheadWorker({
  name: "railhead",
  // The capnweb-validate build tree: `@validateRpc()` is rewritten there before Wrangler bundles.
  entrypoint: ".wrangler/validate/src/server.ts",

  env: {
    // The built board. Only the API paths below reach the Worker; every other request is served
    // from these assets, with unknown paths falling back to the single-page app.
    ASSETS: bindings.assets(),
  },
  assets: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: ["/api", "/api/*"],
  },
  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  assetsDirectory: "../railhead-frontend/dist",
} satisfies WranglerExtras;
