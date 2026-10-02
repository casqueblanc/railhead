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
    // The built board. Only the API, agent and Git paths below reach the Worker; every other request is served
    // from these assets, with unknown paths falling back to the single-page app.
    ASSETS: bindings.assets(),
    // One `Repo` Durable Object per repository, named `org/repo`. Private: only this Worker's code
    // reaches it, through the fixed HTTP and RPC adapters in `src/gateway/`.
    REPO: { type: "durable-object", worker: "railhead", exportName: "Repo" },
  },
  exports: {
    Repo: { type: "durable-object", storage: "sqlite" },
  },
  assets: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: ["/api", "/api/*", "/agent/*", "/git/*"],
  },
  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  assetsDirectory: "../railhead-frontend/dist",
} satisfies WranglerExtras;
