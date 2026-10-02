import {
  CIWorkflow,
  type CiContext,
  type CiParams,
  type CloudflareArtifacts,
} from "@cloudflare/ci";
import type { CiBindings } from "@cloudflare/ci/worker";
import type { SourceControlAdapter } from "@cloudflare/ci/worker/source-control";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_OUTBOUND_HANDLER,
  classifyRunnerFailure,
  gatewayCheckout,
  railheadCheckout,
  type RunnerFailure,
} from "../src/checks/sdkCheckout";
import { serveGitGateway, type GatewayDeps } from "../src/sandbox/gateway";
import { RailheadSandbox } from "../src/sandbox/sandboxObject";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const HOST = `${ACCOUNT}.artifacts.cloudflare.net`;
const NAMESPACE = "railhead";
const REPO = "demo";
const SHA = "a".repeat(40);
const BACKUP_ID = "0b6c5f0e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

const SOURCE = {
  owner: NAMESPACE,
  repo: REPO,
  sha: SHA,
  providerData: { namespace: NAMESPACE },
};

describe("gatewayCheckout", () => {
  it("names the exact commit, no token, and a read-only gateway policy for one repository", () => {
    expect(gatewayCheckout(SOURCE, ACCOUNT)).toEqual({
      kind: "git",
      remote: `https://${HOST}/git/railhead/demo.git`,
      sha: SHA,
      outbound: {
        handler: "gitGateway",
        params: { host: HOST, namespace: NAMESPACE, read: [REPO], write: null },
      },
    });
  });

  it("selects a handler RailheadSandbox actually registers", () => {
    expect(Object.keys(RailheadSandbox.outboundHandlers ?? {})).toContain(
      CHECKOUT_OUTBOUND_HANDLER,
    );
  });

  it.each([
    ["a short SHA", { ...SOURCE, sha: "a".repeat(39) }],
    ["a long SHA", { ...SOURCE, sha: "a".repeat(41) }],
    ["an uppercase SHA", { ...SOURCE, sha: "A".repeat(40) }],
    ["a branch name", { ...SOURCE, sha: "refs/heads/main" }],
    ["another namespace", { ...SOURCE, providerData: { namespace: "other" } }],
    ["missing provider data", { ...SOURCE, providerData: null }],
    ["an invalid repository name", { ...SOURCE, repo: "../main" }],
  ])("refuses %s before any sandbox starts", (_name, source) => {
    expect(() => gatewayCheckout(source, ACCOUNT)).toThrow();
  });

  it("refuses an account ID that would make another host", () => {
    expect(() => gatewayCheckout(SOURCE, "evil.example.com/x")).toThrow(
      "invalid Cloudflare account ID",
    );
  });
});

/** Gateway dependencies that record each minted token and forwarded Authorization header. */
function recorder(): GatewayDeps & { minted: string[]; auth: (string | null)[] } {
  const minted: string[] = [];
  const auth: (string | null)[] = [];
  return {
    minted,
    auth,
    mint: async (repo, scope) => {
      minted.push(`${scope}:${repo}`);
      return `minted-${scope}`;
    },
    fetch: async (request) => {
      auth.push(request.headers.get("Authorization"));
      return new Response("ok");
    },
  };
}

describe("the checkout's policy at the Git gateway", () => {
  it("lets the checkout fetch with a read token minted outside the sandbox", async () => {
    const { remote, outbound } = gatewayCheckout(SOURCE, ACCOUNT);
    const deps = recorder();

    const response = await serveGitGateway(
      new Request(`${remote}/info/refs?service=git-upload-pack`),
      outbound.params,
      deps,
    );

    expect(response.status).toBe(200);
    expect(deps.minted).toEqual(["read:demo"]);
    expect(deps.auth).toEqual(["Bearer minted-read"]);
  });

  it("refuses a push and another repository under the checkout's policy", async () => {
    const { outbound } = gatewayCheckout(SOURCE, ACCOUNT);
    const deps = recorder();

    const push = await serveGitGateway(
      new Request(`https://${HOST}/git/railhead/demo.git/git-receive-pack`, {
        method: "POST",
        body: "0000",
      }),
      outbound.params,
      deps,
    );
    const other = await serveGitGateway(
      new Request(`https://${HOST}/git/railhead/other.git/info/refs?service=git-upload-pack`),
      outbound.params,
      deps,
    );

    expect(push.status).toBe(403);
    expect(await push.text()).toContain("read-only");
    expect(other.status).toBe(403);
    expect(await other.text()).toContain("repository");
    expect(deps.minted).toEqual([]);
  });
});

/** What one scripted sandbox command returns. */
interface Scripted {
  exitCode: number;
  stdout?: string;
}

/** A Sandbox Durable Object stub that records every call and answers from a script. */
class ScriptedSandbox {
  readonly calls: string[] = [];
  readonly envs: Record<string, string>[] = [];
  readonly backups: { localBucket: unknown }[] = [];
  readonly restored: unknown[] = [];
  readonly scripts: string[] = [];
  policy: unknown = null;

  constructor(
    private readonly checkout: (overlay: boolean) => Scripted,
    private readonly command: Scripted,
  ) {}

  async setOutboundHandler(handler: string, params: unknown) {
    this.calls.push(`outbound:${handler}`);
    this.policy = params;
  }

  async execWithSessionToken(command: string, _session: string, options?: { env?: object }) {
    this.envs.push({ ...options?.env });
    if (command.startsWith("tail -c")) {
      return { exitCode: 0, stdout: command.includes(".out") ? (this.command.stdout ?? "") : "" };
    }
    if (command.includes("git init")) {
      const overlay = !command.startsWith("rm -rf");
      this.calls.push(overlay ? "checkout:overlay" : "checkout");
      this.scripts.push(command);
      return { stdout: "", stderr: "", ...this.checkout(overlay) };
    }
    this.calls.push(`exec:${command}`);
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async startProcess(command: string, options?: { env?: Record<string, string> }) {
    this.calls.push(`command:${command}`);
    this.envs.push({ ...options?.env });
    const { exitCode } = this.command;
    return { waitForExit: async () => ({ exitCode }) };
  }

  async createBackup(options: { localBucket?: unknown }) {
    this.calls.push("backup");
    this.backups.push({ localBucket: options.localBucket });
    return { id: BACKUP_ID, dir: "/workspace", localBucket: options.localBucket };
  }

  async restoreBackup(backup: unknown) {
    this.calls.push("restore");
    this.restored.push(backup);
    return { success: true };
  }

  async listFiles() {
    return { files: [] };
  }

  async readFile() {
    return { content: "" };
  }

  async destroy() {
    this.calls.push("destroy");
  }
}

/** Records every Artifacts call the run makes; a token request fails the test. */
class RecordingArtifacts {
  readonly calls: string[] = [];
  async get(name: string) {
    this.calls.push(`get:${name}`);
    return {
      createToken: async () => {
        this.calls.push("createToken");
        throw new Error("a check must never mint a token for its runner");
      },
      readCommit: async () => ({ treeHash: "t".repeat(40) }),
      readTree: async () => [
        { name: "package.json", mode: "100644", hash: "b".repeat(40), type: "blob" },
      ],
    };
  }
}

/** An R2 bucket holding one install cache pointer and its backup metadata. */
class CacheBucket {
  async get(key: string) {
    if (key.startsWith("cache/")) {
      return {
        json: async () => ({
          backupId: BACKUP_ID,
          dir: "/workspace",
          producedBySha: SHA,
          createdAt: "2026-10-02T00:00:00.000Z",
        }),
      };
    }
    if (key.endsWith("meta.json")) {
      return {
        json: async () => ({ createdAt: new Date().toISOString(), ttl: 86_400 }),
        text: async () => JSON.stringify({ createdAt: new Date().toISOString(), ttl: 86_400 }),
      };
    }
    return null;
  }
  async head() {
    return { size: 1 };
  }
  async put() {
    return null;
  }
}

type Outcome = { kind: "pass" } | { kind: "rejected"; failure: RunnerFailure };

/** The pipeline each test runs: an install, then a test chained on its workspace. */
class CheckRun extends CIWorkflow<CloudflareArtifacts, CiBindings> {
  static override getProvider() {
    return railheadCheckout({ owner: NAMESPACE, repo: REPO });
  }

  outcome: Outcome | null = null;
  cached = false;

  protected override async pipeline(
    _event: WorkflowEvent<unknown>,
    _step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    const config = { retries: { limit: 0, delay: 1 }, timeout: 60_000 };
    try {
      const install = await ci.runner({
        name: "install",
        command: "npm ci",
        config,
        ...(this.cached ? { cache: { inputs: ["package.json"] } } : {}),
      });
      await install.runner({ name: "test", command: "npm test", config });
      this.outcome = { kind: "pass" };
    } catch (rejection) {
      this.outcome = { kind: "rejected", failure: classifyRunnerFailure(rejection) };
    }
  }
}

/** Runs the pipeline for `sha` against one scripted sandbox and reports what it saw. */
async function run(options: {
  checkout?: (overlay: boolean) => Scripted;
  command?: Scripted;
  sha?: string;
  cached?: boolean;
}) {
  const sandbox = new ScriptedSandbox(
    options.checkout ?? (() => ({ exitCode: 0 })),
    options.command ?? { exitCode: 0 },
  );
  const artifacts = new RecordingArtifacts();
  const bindings = {
    CF_TOKEN: "cf-secret-token",
    R2_ACCESS_KEY_ID: "r2-key-id",
    R2_SECRET_ACCESS_KEY: "r2-secret",
    ARTIFACTS: artifacts,
    BACKUP_BUCKET: new CacheBucket(),
    BACKUP_BUCKET_NAME: "backups",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    SANDBOX: { idFromName: (name: string) => name, get: () => sandbox },
    CI_WORKFLOW: {},
  };
  // Workerd constructs a Workflow only for a real instance, so the test builds one from the
  // prototype and gives it the fake bindings the engine reads through `this.env`.
  const workflow: CheckRun = Object.create(CheckRun.prototype);
  Object.assign(workflow, { env: bindings, cached: options.cached ?? false, outcome: null });
  const step = {
    do: async (_name: string, _config: unknown, body: (ctx: { attempt: number }) => unknown) =>
      body({ attempt: 1 }),
  };
  const event: WorkflowEvent<CiParams<CloudflareArtifacts>> = {
    payload: {
      provider: "cloudflare-artifacts",
      providerData: { namespace: NAMESPACE },
      event: { type: "push" },
      owner: NAMESPACE,
      repo: REPO,
      sha: options.sha ?? SHA,
      trigger: "push",
      ref: "refs/heads/candidate/chk_1/head",
    },
    timestamp: new Date(),
    instanceId: "chk_1",
    workflowName: "checks",
  };
  // The fakes implement only what the engine calls, not the SDK's full binding and step types.
  await Reflect.apply(CheckRun.prototype.run, workflow, [event, step]);
  return { outcome: workflow.outcome, sandbox, artifacts };
}

const SECRETS = [
  "cf-secret-token",
  "r2-key-id",
  "r2-secret",
  "Authorization",
  "SOURCE_CONTROL_TOKEN",
];

describe("a check run through the patched SDK", () => {
  it("checks out through the gateway with no credential anywhere in the sandbox", async () => {
    const { outcome, sandbox, artifacts } = await run({});

    expect(outcome).toEqual({ kind: "pass" });
    expect(sandbox.calls).toEqual([
      "outbound:gitGateway",
      "checkout",
      "command:(npm ci) > /tmp/ci-step.out 2> /tmp/ci-step.err",
      "backup",
      "destroy",
      "outbound:gitGateway",
      "restore",
      "checkout:overlay",
      "command:(npm test) > /tmp/ci-step.out 2> /tmp/ci-step.err",
      "backup",
      "destroy",
    ]);
    expect(sandbox.policy).toEqual(gatewayCheckout(SOURCE, ACCOUNT).outbound.params);
    // Credential probes: the checkout script, every command's environment and Artifacts calls.
    const seen = JSON.stringify([sandbox.scripts, sandbox.envs]);
    for (const secret of SECRETS) expect(seen).not.toContain(secret);
    expect(sandbox.scripts[0]).toContain(`fetch --depth=1 origin '${SHA}'`);
    expect(artifacts.calls).toEqual([]);
    // Backups stay on the R2 binding: the container has no route to presigned URLs.
    expect(sandbox.backups).toEqual([{ localBucket: true }, { localBucket: true }]);
  });

  it("records a checkout that cannot find the commit as an error and never runs the check", async () => {
    const { outcome, sandbox } = await run({ checkout: () => ({ exitCode: 128 }) });

    expect(outcome).toEqual({
      kind: "rejected",
      failure: { conclusion: "error", runner: "install", reason: "checkout" },
    });
    expect(sandbox.calls).toEqual(["outbound:gitGateway", "checkout", "destroy"]);
  });

  it("records a failed overlay checkout on a chained runner as an error before its command", async () => {
    const { outcome, sandbox } = await run({
      checkout: (overlay) => ({ exitCode: overlay ? 1 : 0 }),
    });

    expect(outcome).toEqual({
      kind: "rejected",
      failure: { conclusion: "error", runner: "test", reason: "checkout" },
    });
    expect(sandbox.calls.filter((call) => call.startsWith("command:"))).toEqual([
      "command:(npm ci) > /tmp/ci-step.out 2> /tmp/ci-step.err",
    ]);
  });

  it("refuses a SHA that is not a full commit before any sandbox starts", async () => {
    const { outcome, sandbox, artifacts } = await run({ sha: "a".repeat(39) });

    expect(outcome).toEqual({
      kind: "rejected",
      failure: { conclusion: "error", runner: "install", reason: "infrastructure" },
    });
    expect(sandbox.calls).toEqual([]);
    expect(artifacts.calls).toEqual([]);
  });

  it("records the check's own nonzero exit as a failure with its exit code", async () => {
    const { outcome } = await run({ command: { exitCode: 1, stdout: "1 test failed" } });

    expect(outcome).toEqual({
      kind: "rejected",
      failure: { conclusion: "fail", runner: "install", exitCode: 1 },
    });
  });

  it("keeps a failure a failure when the command prints a checkout error or a long log", async () => {
    const stdout = `source checkout exited with status 128\ntest failed with exit code 0\n${"x".repeat(30_000)}`;

    const { outcome } = await run({ command: { exitCode: 2, stdout } });

    expect(outcome).toEqual({
      kind: "rejected",
      failure: { conclusion: "fail", runner: "install", exitCode: 2 },
    });
  });

  it("restores a cached workspace through the R2 binding", async () => {
    const { outcome, sandbox, artifacts } = await run({ cached: true });

    expect(outcome).toEqual({ kind: "pass" });
    // The cache hit skips the install; the test restores its workspace from the binding.
    expect(sandbox.restored).toEqual([{ id: BACKUP_ID, dir: "/workspace", localBucket: true }]);
    expect(artifacts.calls).toEqual(["get:demo"]);
  });
});

describe("classifyRunnerFailure", () => {
  it("treats anything that is not a runner failure as an infrastructure error", () => {
    expect(
      classifyRunnerFailure(new Error("demo failed with exit code 1\n=== stdout ===\n")),
    ).toEqual({ conclusion: "error", runner: null, reason: "infrastructure" });
    expect(classifyRunnerFailure("boom")).toEqual({
      conclusion: "error",
      runner: null,
      reason: "infrastructure",
    });
  });
});

/** The adapter's provider over the two bindings it reads. */
function provider(): ReturnType<SourceControlAdapter<CloudflareArtifacts>["create"]> {
  const adapter = railheadCheckout({ owner: NAMESPACE, repo: REPO });
  const bindings = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, ARTIFACTS: new RecordingArtifacts() };
  return Reflect.apply(adapter.create, adapter, [bindings]);
}

describe("the railheadCheckout adapter", () => {
  it("never hands a runner repository credentials", async () => {
    await expect(provider().getStepCredentialEnv(SOURCE)).rejects.toThrow("never hand");
    await expect(provider().getPushCredentials(SOURCE)).rejects.toThrow("never hand");
  });

  it("starts no run from an Artifacts push event", async () => {
    const body = JSON.stringify({
      type: "cf.artifacts.repo.pushed",
      source: { namespace: NAMESPACE, repoName: REPO },
      payload: { ref: "refs/heads/main", before: "0".repeat(40), after: SHA, commits: [] },
    });

    expect(await provider().receiveEvent({ body, headers: new Headers() })).toBeNull();
  });

  it("accepts only its own repository", () => {
    const adapter = railheadCheckout({ owner: NAMESPACE, repo: REPO });
    const source = { provider: "cloudflare-artifacts", owner: NAMESPACE };

    expect(adapter.accepts({ ...source, repo: REPO })).toBe(true);
    expect(adapter.accepts({ ...source, repo: "other" })).toBe(false);
    expect(adapter.accepts({ ...source, owner: "other", repo: REPO })).toBe(false);
  });
});
