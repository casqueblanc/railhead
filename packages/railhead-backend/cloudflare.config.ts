import { defineConfig, defineContainer } from "@cloudflare/config";
import {
  CAPNWEB_VALIDATE_BUILD,
  OBSERVABILITY,
  bindings,
  defineRailheadWorker,
  type WranglerExtras,
} from "@railhead/scripts/worker-config";

// The container application every sandbox runs in. Deleting the Worker leaves it and its image
// behind; docs/sandbox-teardown.md removes both.
const sandbox = defineContainer({
  name: "railhead-sandbox",
  image: { dockerfile: "../../containers/railhead/Dockerfile" },
  instanceType: "basic",
  // The account-wide ceiling. Each repository also holds at most `MAX_ACTIVE_SANDBOXES` itself
  // (src/sandbox/admission.ts); a start refused here leaves that attempt's slot uncertain.
  maxInstances: 10,
});

const worker = defineRailheadWorker({
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
    // One sandbox per admitted attempt, named by the attempt. Only the sandbox module reaches it.
    SANDBOX: { type: "durable-object", worker: "railhead", exportName: "RailheadSandbox" },
    // Git storage. Tokens minted from it stay in the Worker; a sandbox never receives one.
    ARTIFACTS: bindings.artifacts({ namespace: "railhead" }),
  },
  exports: {
    Repo: { type: "durable-object", storage: "sqlite" },
    RailheadSandbox: { type: "durable-object", storage: "sqlite", container: sandbox },
  },
  assets: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: ["/api", "/api/*", "/agent/*", "/git/*"],
  },
  observability: OBSERVABILITY,
});

export default defineConfig({ ...worker, containers: [sandbox] });

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  assetsDirectory: "../railhead-frontend/dist",
} satisfies WranglerExtras;
