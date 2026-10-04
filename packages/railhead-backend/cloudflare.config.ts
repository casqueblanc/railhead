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
    // The namespace above, for the Git remotes a check sandbox fetches from.
    ARTIFACTS_NAMESPACE: { type: "text", value: "railhead" },
    // The account the Artifacts Git host belongs to, `<id>.artifacts.cloudflare.net`. Set by the
    // operator at deploy; without it no check runs.
    CLOUDFLARE_ACCOUNT_ID: bindings.secret(),
    // One Workflow instance per check attempt, named by the attempt. Only the checks module starts
    // one (src/checks/port.ts).
    CHECKS: {
      type: "workflow",
      name: "railhead-checks",
      worker: "railhead",
      exportName: "CheckWorkflow",
    },
    // Workspace backups of check runs, written through the binding from outside the container. The
    // operator creates the bucket; both names must match it.
    BACKUP_BUCKET: bindings.r2({ name: "railhead-check-backups" }),
    BACKUP_BUCKET_NAME: { type: "text", value: "railhead-check-backups" },
    // The instance owner's one Durable Object: the enrolled passkey and its bootstrap. Private, like
    // `REPO`; each Repo's owner module reads the credential through it.
    OWNER: { type: "durable-object", worker: "railhead", exportName: "Owner" },
    // The passkey relying party: the exact host of this instance's fixed origin. The development
    // instance's; the submission instance sets `railhead.dev` at deploy.
    RELYING_PARTY_HOST: { type: "text", value: "railhead.mashin.workers.dev" },
    // The one-time token that opens enrollment of the first owner passkey, set by the operator.
    OWNER_BOOTSTRAP_TOKEN: bindings.secret(),
    // The instance's session signing secret, set by the operator at deploy: at least 32 random
    // characters. Each repository derives its challenge and token keys from it; without it agents
    // cannot log in. Replacing it ends every session.
    SESSION_SIGNING_SECRET: bindings.secret(),
    // Workers AI, for Clef's conflict classification. Only the conflicts module calls it, through
    // `@railhead/ai`. It has no local simulation: every call reaches the remote service.
    AI: bindings.ai(),
  },
  exports: {
    Repo: { type: "durable-object", storage: "sqlite" },
    RailheadSandbox: { type: "durable-object", storage: "sqlite", container: sandbox },
    Owner: { type: "durable-object", storage: "sqlite" },
    CheckWorkflow: { type: "workflow", name: "railhead-checks" },
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
