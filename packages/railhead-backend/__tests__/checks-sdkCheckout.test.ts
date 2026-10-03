import {
  CIWorkflow,
  isCiRunnerFailure,
  type CiContext,
  type CiParams,
  type CloudflareArtifacts,
} from "@cloudflare/ci";
import type { CiBindings } from "@cloudflare/ci/worker";
import type { SourceControlAdapter } from "@cloudflare/ci/worker/source-control";
import {
  Sandbox,
  type BackupOptions,
  type DirectoryBackup,
  type ExecOptions,
  type ExecResult,
  type ListFilesOptions,
  type Process,
  type ProcessOptions,
} from "@cloudflare/sandbox";
import { runInDurableObject } from "cloudflare:test";
import { env, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyRunnerFailure,
  gatewayCheckout,
  railheadCheckout,
  type RunnerFailure,
} from "../src/checks/sdkCheckout";
import { MAX_SANDBOX_LIFETIME_MS } from "../src/sandbox/admission";
import { MAX_TEARDOWN_ATTEMPTS, SandboxFence, teardownRetryDelay } from "../src/sandbox/fence";
import { parseSandboxGrant, type SandboxGrant } from "../src/sandbox/policy";
import {
  FENCED_SANDBOX_METHODS,
  LOCAL_CLIENT_MEMBERS,
  DISPOSAL_SWEEP_MS,
  RailheadSandbox,
  admitSandboxClient,
  fenceSandbox,
  wakeTime,
  type FencedSandboxCalls,
} from "../src/sandbox/sandboxObject";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const HOST = `${ACCOUNT}.artifacts.cloudflare.net`;
const NAMESPACE = "railhead";
const REPO = "demo";
const SHA = "a".repeat(40);
const BACKUP_ID = "0b6c5f0e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
/** The SDK's largest log returned whole; a larger one is read as its tail. */
const INLINE_LOG_BYTES = 300_000;

/** When the runner asks for the checkout in the gatewayCheckout tests. */
const NOW = 1_800_000_000_000;

/** The sandbox the repository admitted for the run, as `sandboxName` names one. */
const SANDBOX = `sbx-${"0".repeat(32)}`;

/** The admitted slot: its sandbox, and its deadline as admission at `NOW` sets it. */
const SLOT = { sandbox: SANDBOX, deadline: NOW + MAX_SANDBOX_LIFETIME_MS };

const SOURCE = {
  owner: NAMESPACE,
  repo: REPO,
  sha: SHA,
  providerData: { namespace: NAMESPACE, slot: SLOT },
};

/** The policy every checkout of the repository runs under, as admission records it. */
const POLICY = { host: HOST, namespace: NAMESPACE, read: [REPO], write: null };

/** The one repository the adapter and its checkouts cover. */
const REPOSITORY = { owner: NAMESPACE, repo: REPO };

describe("gatewayCheckout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the exact commit, no token, the admitted sandbox and a grant ending at its deadline", () => {
    expect(gatewayCheckout(REPOSITORY, SOURCE, ACCOUNT)).toEqual({
      kind: "git",
      remote: `https://${HOST}/git/railhead/demo.git`,
      sha: SHA,
      fence: {
        policy: { host: HOST, namespace: NAMESPACE, read: [REPO], write: null },
        expiresAt: NOW + MAX_SANDBOX_LIFETIME_MS,
        sandbox: SANDBOX,
      },
    });
  });

  it("takes the grant's end from the slot, never from when it is asked", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW + 1_000);
    const deadline = NOW + 60_000;

    const checkout = gatewayCheckout(
      REPOSITORY,
      { ...SOURCE, providerData: { namespace: NAMESPACE, slot: { sandbox: SANDBOX, deadline } } },
      ACCOUNT,
    );

    expect(checkout.fence).toEqual(expect.objectContaining({ expiresAt: deadline }));
  });

  it.each([
    ["a short SHA", { ...SOURCE, sha: "a".repeat(39) }],
    ["a long SHA", { ...SOURCE, sha: "a".repeat(41) }],
    ["an uppercase SHA", { ...SOURCE, sha: "A".repeat(40) }],
    ["a branch name", { ...SOURCE, sha: "refs/heads/main" }],
    ["another namespace", { ...SOURCE, providerData: { namespace: "other", slot: SLOT } }],
    ["missing provider data", { ...SOURCE, providerData: null }],
    ["no admitted slot", { ...SOURCE, providerData: { namespace: NAMESPACE } }],
    ["another repository in the namespace", { ...SOURCE, repo: "other" }],
    [
      "another namespace with matching provider data",
      { ...SOURCE, owner: "other", providerData: { namespace: "other", slot: SLOT } },
    ],
  ])("refuses %s before any sandbox starts", (_name, source) => {
    expect(() => gatewayCheckout(REPOSITORY, source, ACCOUNT)).toThrow();
  });

  it("refuses an invalid repository name, even as the adapter's own", () => {
    const repository = { owner: NAMESPACE, repo: "../main" };

    expect(() => gatewayCheckout(repository, { ...SOURCE, repo: "../main" }, ACCOUNT)).toThrow(
      "invalid repository",
    );
  });

  it("refuses an account ID that would make another host", () => {
    expect(() => gatewayCheckout(REPOSITORY, SOURCE, "evil.example.com/x")).toThrow(
      "invalid Cloudflare account ID",
    );
  });

  it.each([
    ["a deadline that is not a number", { sandbox: SANDBOX, deadline: "soon" }],
    ["a fractional deadline", { sandbox: SANDBOX, deadline: 1.5 }],
    ["an unsafe deadline", { sandbox: SANDBOX, deadline: Number.MAX_SAFE_INTEGER + 2 }],
    ["a zero deadline", { sandbox: SANDBOX, deadline: 0 }],
    ["a sandbox name admission never gives", { sandbox: "chk-runner", deadline: SLOT.deadline }],
    ["an uppercase sandbox name", { sandbox: SANDBOX.toUpperCase(), deadline: SLOT.deadline }],
    ["no sandbox name", { deadline: SLOT.deadline }],
  ])("refuses a slot with %s", (_name, slot) => {
    const source = { ...SOURCE, providerData: { namespace: NAMESPACE, slot } };

    expect(() => gatewayCheckout(REPOSITORY, source, ACCOUNT)).toThrow(
      "check source names no admitted sandbox slot",
    );
  });
});

/**
 * The grants a fence routed, its destroys and wake-ups, over a container whose every command
 * succeeds. The first `failingDestroys` destroys reject.
 */
class FenceRecorder {
  readonly routed: SandboxGrant[] = [];
  readonly wakes: number[] = [];
  destroys = 0;
  failingDestroys = 0;
}

// How long a test fence's `retire` waits for operations under way, in real milliseconds.
const SETTLE_MS = 50;

/**
 * Runs `body` with a real fence over the storage of a Durable Object no other test touches, on the
 * clock the gateway reads, so fake timers move both.
 */
function withFence(body: (fence: SandboxFence, recorder: FenceRecorder) => Promise<void>) {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    const recorder = new FenceRecorder();
    const fence = new SandboxFence(
      state.storage,
      {
        route: async (grant) => {
          recorder.routed.push(grant);
        },
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false }),
        destroy: async () => {
          recorder.destroys += 1;
          if (recorder.destroys <= recorder.failingDestroys) throw new Error("destroy failed");
        },
        wake: async (at) => {
          recorder.wakes.push(at);
        },
      },
      () => Date.now(),
      SETTLE_MS,
    );
    await body(fence, recorder);
  });
}

/**
 * The gitGateway handler RailheadSandbox registers, over a recording Artifacts binding and upstream
 * fetch. Nothing is stubbed between the grant and the gateway: the handler parses it. The sending
 * sandbox's object answers whether the grant is current from `fence`, or refuses with none.
 */
function registeredGateway(fence: SandboxFence | null) {
  const handler = RailheadSandbox.outboundHandlers?.["gitGateway"];
  if (handler === undefined) throw new Error("no git gateway handler");
  const minted: string[] = [];
  const forwarded: { url: string; auth: string | null }[] = [];
  const bindings = {
    ARTIFACTS: {
      get: async (repo: string) => ({
        createToken: async (scope: string, ttl: number) => {
          minted.push(`${scope}:${repo}:${ttl}`);
          return { plaintext: `minted-${scope}` };
        },
        [Symbol.dispose]: () => {},
      }),
    },
    SANDBOX: {
      idFromString: (id: string) => id,
      get: () => ({
        railheadGrantCurrent: async (expiresAt: number) => fence?.grantCurrent(expiresAt) ?? false,
      }),
    },
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    forwarded.push({ url: request.url, auth: request.headers.get("Authorization") });
    return new Response("upstream");
  });
  return {
    minted,
    forwarded,
    async serve(request: Request, params: unknown): Promise<Response> {
      const context = { containerId: "c", className: "RailheadSandbox", params };
      // The fake binding implements only what the handler calls, not the whole Env.
      const response: unknown = await Reflect.apply(handler, undefined, [
        request,
        bindings,
        context,
      ]);
      if (!(response instanceof Response)) throw new Error("the handler returned no Response");
      return response;
    },
  };
}

function fetchRefs(remote: string): Request {
  return new Request(`${remote}/info/refs?service=git-upload-pack`);
}

/** A checkout asked for at `NOW`, with the gateway's clock at `at`. */
function checkoutAt(at: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  return gatewayCheckout(REPOSITORY, SOURCE, ACCOUNT);
}

describe("the checkout's grant at the registered Git gateway", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("forwards a started sandbox's fetch with a read token minted outside it", async () => {
    const { remote, fence: grant } = checkoutAt(NOW);
    await withFence(async (fence, recorder) => {
      await fence.start(grant.policy, grant.expiresAt);
      const gateway = registeredGateway(fence);

      const response = await gateway.serve(fetchRefs(remote), grant);

      // The fence routes the grant alone; the sandbox's name never reaches the gateway.
      expect(recorder.routed).toEqual([{ policy: grant.policy, expiresAt: grant.expiresAt }]);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("upstream");
      expect(gateway.minted).toEqual(["read:demo:60"]);
      expect(gateway.forwarded).toEqual([
        { url: `${remote}/info/refs?service=git-upload-pack`, auth: "Bearer minted-read" },
      ]);
    });
  });

  it("forwards one millisecond before the grant lapses and refuses at the moment it does", async () => {
    const { remote, fence: grant } = checkoutAt(NOW + MAX_SANDBOX_LIFETIME_MS - 1);
    await withFence(async (fence) => {
      await fence.start(grant.policy, grant.expiresAt);
      const gateway = registeredGateway(fence);

      const before = await gateway.serve(fetchRefs(remote), grant);
      vi.setSystemTime(NOW + MAX_SANDBOX_LIFETIME_MS);
      const at = await gateway.serve(fetchRefs(remote), grant);

      expect(before.status).toBe(200);
      expect(at.status).toBe(403);
      expect(await at.text()).toContain("policy");
      expect(gateway.minted).toEqual(["read:demo:60"]);
      expect(gateway.forwarded).toHaveLength(1);
    });
  });

  it("refuses the grant to a sandbox whose fence never started, before minting", async () => {
    const { remote, fence: grant } = checkoutAt(NOW);
    await withFence(async (fence) => {
      const gateway = registeredGateway(fence);

      const response = await gateway.serve(fetchRefs(remote), grant);

      expect(response.status).toBe(403);
      expect(await response.text()).toContain("retired");
      expect(gateway.minted).toEqual([]);
      expect(gateway.forwarded).toEqual([]);
    });
  });

  it("refuses the grant once the sandbox is retired before its deadline", async () => {
    const { remote, fence: grant } = checkoutAt(NOW);
    await withFence(async (fence, recorder) => {
      await fence.start(grant.policy, grant.expiresAt);
      const gateway = registeredGateway(fence);

      const live = await gateway.serve(fetchRefs(remote), grant);
      await fence.retire();
      const retired = await gateway.serve(fetchRefs(remote), grant);

      expect(live.status).toBe(200);
      expect(recorder.destroys).toBe(1);
      expect(retired.status).toBe(403);
      expect(await retired.text()).toContain("retired");
      expect(gateway.minted).toEqual(["read:demo:60"]);
      expect(gateway.forwarded).toHaveLength(1);
    });
  });

  it("refuses a grant whose sandbox object cannot be asked", async () => {
    const { remote, fence: grant } = checkoutAt(NOW);
    const gateway = registeredGateway(null);

    const response = await gateway.serve(fetchRefs(remote), grant);

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("retired");
    expect(gateway.minted).toEqual([]);
  });

  it("refuses a checkout policy passed without its deadline, and no params at all", async () => {
    const { remote, fence: grant } = checkoutAt(NOW);
    const gateway = registeredGateway(null);

    const bare = await gateway.serve(fetchRefs(remote), grant.policy);
    const missing = await gateway.serve(fetchRefs(remote), undefined);

    for (const response of [bare, missing]) {
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("policy");
    }
    expect(gateway.minted).toEqual([]);
    expect(gateway.forwarded).toEqual([]);
  });

  it("refuses a push and another repository under the checkout's grant", async () => {
    const { fence: grant } = checkoutAt(NOW);
    await withFence(async (fence) => {
      await fence.start(grant.policy, grant.expiresAt);
      const gateway = registeredGateway(fence);

      const push = await gateway.serve(
        new Request(`https://${HOST}/git/railhead/demo.git/git-receive-pack`, {
          method: "POST",
          body: "0000",
        }),
        grant,
      );
      const other = await gateway.serve(fetchRefs(`https://${HOST}/git/railhead/other.git`), grant);

      expect(push.status).toBe(403);
      expect(await push.text()).toContain("read-only");
      expect(other.status).toBe(403);
      expect(await other.text()).toContain("repository");
      expect(gateway.minted).toEqual([]);
      expect(gateway.forwarded).toEqual([]);
    });
  });
});

type FencedMethod = (typeof FENCED_SANDBOX_METHODS)[number];

/** SDK calls that record each time they reach the container; with `fail`, every one rejects. */
function recordingSdk(reached: string[], fail = false): FencedSandboxCalls {
  const reach = async (name: string) => {
    reached.push(name);
    if (fail) throw new Error(`${name} failed`);
  };
  return {
    restoreBackup: async (backup) => {
      await reach("restoreBackup");
      return { success: true, dir: backup.dir, id: backup.id };
    },
    createBackup: async (options) => {
      await reach("createBackup");
      return { id: BACKUP_ID, dir: options.dir };
    },
    execWithSessionToken: async (command) => {
      await reach("execWithSessionToken");
      return execResult(command, { exitCode: 3, stdout: "out" });
    },
    listFiles: async (path) => {
      await reach("listFiles");
      return { success: true, path, files: [logFile("/tmp/a.out", 5)], count: 1, timestamp: "" };
    },
    startProcess: async (command) => {
      await reach("startProcess");
      return scriptedProcess(command, 7, () => reach("process"));
    },
    containerFetch: async () => {
      await reach("containerFetch");
      return new Response("container");
    },
  };
}

/** One call of each fenced method; the key type makes a newly fenced method need an entry. */
const CALL_EACH: Record<FencedMethod, (sdk: FencedSandboxCalls) => Promise<unknown>> = {
  restoreBackup: (sdk) => sdk.restoreBackup({ id: BACKUP_ID, dir: "/workspace" }),
  createBackup: (sdk) => sdk.createBackup({ dir: "/workspace" }),
  execWithSessionToken: (sdk) => sdk.execWithSessionToken("true", "s"),
  listFiles: (sdk) => sdk.listFiles("/tmp"),
  startProcess: (sdk) => sdk.startProcess("npm test"),
  containerFetch: (sdk) => sdk.containerFetch("http://container/"),
};

describe("fenceSandbox, the wrapping RailheadSandbox applies to its SDK calls", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs every call in the live incarnation and returns the SDK's result", async () => {
    const { fence: grant } = checkoutAt(NOW);
    await withFence(async (fence, recorder) => {
      await fence.start(grant.policy, grant.expiresAt);
      const reached: string[] = [];
      const sdk = fenceSandbox(fence, recordingSdk(reached));

      expect(await sdk.restoreBackup({ id: BACKUP_ID, dir: "/workspace" })).toEqual({
        success: true,
        dir: "/workspace",
        id: BACKUP_ID,
      });
      expect(await sdk.createBackup({ dir: "/workspace" })).toEqual({
        id: BACKUP_ID,
        dir: "/workspace",
      });
      expect(await sdk.execWithSessionToken("true", "s")).toMatchObject({
        exitCode: 3,
        stdout: "out",
      });
      expect((await sdk.listFiles("/tmp")).files.map((file) => file.absolutePath)).toEqual([
        "/tmp/a.out",
      ]);
      const process = await sdk.startProcess("npm test");
      expect(process.command).toBe("npm test");
      expect(await process.waitForExit()).toEqual({ exitCode: 7 });
      expect(await (await sdk.containerFetch("http://container/")).text()).toBe("container");

      expect(reached).toEqual([
        "restoreBackup",
        "createBackup",
        "execWithSessionToken",
        "listFiles",
        "startProcess",
        "process",
        "containerFetch",
      ]);
      expect(recorder.destroys).toBe(0);
    });
  });

  it.each(FENCED_SANDBOX_METHODS)(
    "refuses %s before the fence starts, without reaching the container",
    async (method) => {
      await withFence(async (fence) => {
        const reached: string[] = [];
        const sdk = fenceSandbox(fence, recordingSdk(reached));

        await expect(CALL_EACH[method](sdk)).rejects.toThrow("refused: not_started");
        expect(reached).toEqual([]);
      });
    },
  );

  it.each(FENCED_SANDBOX_METHODS)(
    "refuses %s once the incarnation is retired, without reaching the container",
    async (method) => {
      const { fence: grant } = checkoutAt(NOW);
      await withFence(async (fence) => {
        await fence.start(grant.policy, grant.expiresAt);
        await fence.retire();
        const reached: string[] = [];
        const sdk = fenceSandbox(fence, recordingSdk(reached));

        await expect(CALL_EACH[method](sdk)).rejects.toThrow("refused: retired");
        expect(reached).toEqual([]);
      });
    },
  );

  it("refuses a process started while live once the incarnation is retired", async () => {
    const { fence: grant } = checkoutAt(NOW);
    await withFence(async (fence) => {
      await fence.start(grant.policy, grant.expiresAt);
      const reached: string[] = [];
      const process = await fenceSandbox(fence, recordingSdk(reached)).startProcess("npm test");
      await fence.retire();

      await expect(process.waitForExit()).rejects.toThrow("refused: retired");
      await expect(process.getLogs()).rejects.toThrow("refused: retired");
      await expect(process.kill()).rejects.toThrow("refused: retired");
      await expect(process.waitForPort(8080)).rejects.toThrow("refused: retired");
      expect(reached).toEqual(["startProcess"]);
    });
  });

  it("destroys the container and ends the grant when a call fails", async () => {
    const { fence: grant } = checkoutAt(NOW);
    await withFence(async (fence, recorder) => {
      await fence.start(grant.policy, grant.expiresAt);
      const sdk = fenceSandbox(fence, recordingSdk([], true));

      await expect(sdk.restoreBackup({ id: BACKUP_ID, dir: "/workspace" })).rejects.toThrow(
        "restoreBackup failed",
      );
      expect(recorder.destroys).toBe(1);
      expect(fence.grantCurrent(grant.expiresAt)).toBe(false);
    });
  });

  it("is applied by a RailheadSandbox override of every fenced method", () => {
    const overridden = FENCED_SANDBOX_METHODS.filter((method) =>
      Object.hasOwn(RailheadSandbox.prototype, method),
    );

    expect(overridden).toEqual([...FENCED_SANDBOX_METHODS]);
  });
});

/** What reached the container through the SDK, beneath every RailheadSandbox override. */
interface RecordingContainer {
  /** Each request the SDK sent to start or reach the container, the RPC upgrade among them. */
  readonly requests: string[];
  /** Each message the SDK sent over an RPC connection the container accepted. */
  readonly messages: string[];
}

/** An R2 binding whose reads wait until the test answers, as a slow archive read does. */
function pausedBucket() {
  const r2 = deferred();
  const reading = deferred();
  let reads = 0;
  const binding = {
    get: async () => {
      reads += 1;
      reading.resolve();
      await r2.promise;
      // The backup's metadata, then its archive.
      return reads === 1
        ? { json: async () => ({ createdAt: new Date().toISOString(), ttl: 3_600 }) }
        : { body: new ReadableStream(), arrayBuffer: async () => new ArrayBuffer(0) };
    },
    put: async () => null,
    head: async () => null,
    delete: async () => undefined,
    list: async () => ({ objects: [] }),
  };
  return { binding, reading: reading.promise, answer: r2.resolve };
}

/** Lets the recording container receive what the SDK sent. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * Runs `body` with a real RailheadSandbox over the storage of a Durable Object no other test
 * touches, its fence live until a minute from now. The pool runs no containers, so the object has
 * a stopped stand-in, and the SDK's own `containerFetch`, which every RailheadSandbox override
 * calls last, is a recording container that accepts the RPC transport's WebSocket upgrade.
 */
function withRailheadSandbox(
  bucket: unknown,
  body: (
    sandbox: RailheadSandbox,
    container: RecordingContainer,
    state: DurableObjectState,
  ) => Promise<void>,
): Promise<void> {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    const stopped = { running: false, start: noop, destroy: async () => undefined };
    Object.defineProperty(state, "container", { value: stopped });
    const container: RecordingContainer = { requests: [], messages: [] };
    vi.spyOn(Sandbox.prototype, "containerFetch").mockImplementation(async (request) => {
      container.requests.push(request instanceof Request ? request.url : String(request));
      const [client, server] = Object.values(new WebSocketPair());
      if (client === undefined || server === undefined) throw new Error("no WebSocket pair");
      server.accept();
      server.addEventListener("message", (event) => {
        container.messages.push(String(event.data));
      });
      return new Response(null, { status: 101, webSocket: client });
    });
    // The bucket stand-in implements only what a restore calls.
    const sandboxEnv: Env = { ...env };
    Reflect.set(sandboxEnv, "BACKUP_BUCKET", bucket);
    // The pool types the object's props as `unknown`; the SDK's constructor declares none.
    const sandbox = new RailheadSandbox(
      state as ConstructorParameters<typeof RailheadSandbox>[0],
      sandboxEnv,
    );
    // The constructor's storage reads finish before the object serves its first call.
    await state.blockConcurrencyWhile(async () => undefined);
    // The patched runner opens each sandbox over the RPC transport.
    await sandbox.setTransport("rpc");
    // As `railheadStart` records it, which would also probe the container.
    state.storage.kv.put("railhead:fence", {
      phase: "live",
      deadline: Date.now() + 60_000,
      policy: POLICY,
    });
    await body(sandbox, container, state);
  });
}

describe("RailheadSandbox's storage after retirement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The object's fence reads the real clock, so these deadlines are a few real milliseconds away.
  it("deletes its alarm and all its storage at the first alarm past the deadline", async () => {
    await withRailheadSandbox(null, async (sandbox, _container, state) => {
      const deadline = Date.now() + 30;
      state.storage.kv.put("railhead:fence", { phase: "live", deadline, policy: POLICY });
      await sandbox.railheadRetire();
      expect(stored(state).fence).toEqual({ phase: "retired", deadline });
      expect(stored(state).tables).toContain("container_schedules");

      await pastDeadline(deadline);
      await sandbox.alarm();

      expect(stored(state)).toEqual({ tables: [], fence: undefined });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("is deleted again after a restart revives it for a late start past the deadline", async () => {
    await withRailheadSandbox(null, async (sandbox, _container, state) => {
      const deadline = Date.now() + 30;
      state.storage.kv.put("railhead:fence", { phase: "live", deadline, policy: POLICY });
      await sandbox.railheadRetire();
      await pastDeadline(deadline);
      await sandbox.alarm();
      expect(stored(state)).toEqual({ tables: [], fence: undefined });

      // The object restarts: the SDK's constructor recreates its table and alarm. A late start for
      // the incarnation runs nothing and records the retirement again.
      const revived = new RailheadSandbox(
        state as ConstructorParameters<typeof RailheadSandbox>[0],
        env,
      );
      await state.blockConcurrencyWhile(async () => undefined);
      const policy = { host: HOST, namespace: NAMESPACE, read: [REPO], write: null };
      await expect(revived.railheadStart(policy, deadline)).rejects.toThrow("refused: expired");
      expect(stored(state).fence).toEqual({ phase: "retired", deadline });

      await revived.alarm();

      expect(stored(state)).toEqual({ tables: [], fence: undefined });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("keeps its record and schedules a retry when deleting its storage fails, then finishes", async () => {
    await withRailheadSandbox(null, async (sandbox, _container, state) => {
      const deadline = Date.now() + 30;
      state.storage.kv.put("railhead:fence", { phase: "live", deadline, policy: POLICY });
      await sandbox.railheadRetire();
      await pastDeadline(deadline);
      const deleteAll = state.storage.deleteAll.bind(state.storage);
      const failing = vi
        .spyOn(state.storage, "deleteAll")
        .mockRejectedValueOnce(new Error("scripted storage failure"));
      const logged = vi.spyOn(console, "error").mockImplementation(noop);

      const before = Date.now();
      await sandbox.alarm();

      // Nothing was deleted, and the object asked to be woken again to finish.
      expect(stored(state).fence).toEqual({ phase: "retired", deadline });
      expect(state.storage.kv.get("railhead:disposal-failures")).toBe(1);
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(before + teardownRetryDelay(1));
      expect(logged).toHaveBeenCalledWith(
        JSON.stringify({ event: "sandbox.dispose_failed", failures: 1, error: "Error" }),
      );

      failing.mockImplementation(deleteAll);
      await sandbox.alarm();

      expect(stored(state)).toEqual({ tables: [], fence: undefined });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("starts a new round after a long pause once its quick retries are spent, then finishes", async () => {
    await withRailheadSandbox(null, async (sandbox, _container, state) => {
      const deadline = Date.now() + 30;
      state.storage.kv.put("railhead:fence", { phase: "live", deadline, policy: POLICY });
      await sandbox.railheadRetire();
      await pastDeadline(deadline);
      const deleteAll = state.storage.deleteAll.bind(state.storage);
      const failing = vi
        .spyOn(state.storage, "deleteAll")
        .mockRejectedValue(new Error("scripted storage failure"));
      vi.spyOn(console, "error").mockImplementation(noop);
      state.storage.kv.put("railhead:disposal-failures", MAX_TEARDOWN_ATTEMPTS - 1);
      // No wake-up of the fence's own is pending, so the alarm left is the disposal's own.
      state.storage.sql.exec("DELETE FROM container_schedules");

      const before = Date.now();
      await sandbox.alarm();

      // The round ended without stopping: the count starts over and the next try is a day away.
      expect(state.storage.kv.get("railhead:disposal-failures")).toBeUndefined();
      expect(stored(state).fence).toEqual({ phase: "retired", deadline });
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(before + DISPOSAL_SWEEP_MS);

      failing.mockImplementation(deleteAll);
      await sandbox.alarm();

      expect(stored(state)).toEqual({ tables: [], fence: undefined });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("deletes its storage past the deadline after its last destroy attempt confirms before it", async () => {
    await withRailheadSandbox(null, async (sandbox, _container, state) => {
      // Far enough that every destroy attempt confirms before it, even on a loaded machine.
      const deadline = Date.now() + 3_000;
      state.storage.kv.put("railhead:fence", { phase: "live", deadline, policy: POLICY });
      const destroy = vi.spyOn(Sandbox.prototype, "destroy");
      for (let failure = 1; failure < MAX_TEARDOWN_ATTEMPTS; failure += 1) {
        destroy.mockRejectedValueOnce(new Error("scripted destroy failure"));
        await expect(sandbox.railheadRetire()).rejects.toThrow("scripted destroy failure");
      }
      expect(stored(state).fence).toEqual({
        phase: "retiring",
        deadline,
        attempts: MAX_TEARDOWN_ATTEMPTS - 1,
      });
      // The last retry wake-up is due, and no other is left: the start's ran early.
      state.storage.sql.exec("DELETE FROM container_schedules");
      await sandbox.schedule(new Date(Date.now() - 1_000), "railheadExpire");

      await sandbox.alarm();

      expect(destroy).toHaveBeenCalledTimes(MAX_TEARDOWN_ATTEMPTS);
      expect(stored(state).fence).toEqual({ phase: "retired", deadline });
      const wake = wakeTime(deadline).getTime();
      expect(scheduledWakes(state)).toEqual([wake]);
      expect(await state.storage.getAlarm()).toBe(wake);

      await pastDeadline(wake);
      await sandbox.alarm();

      expect(stored(state)).toEqual({ tables: [], fence: undefined });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  }, 15_000);

  it("fails a release whose deadline wake-up cannot be scheduled, and the retried release schedules it", async () => {
    await withRailheadSandbox(null, async (sandbox, _container, state) => {
      // Far enough that every destroy attempt confirms before it, even on a loaded machine.
      const deadline = Date.now() + 3_000;
      state.storage.kv.put("railhead:fence", { phase: "live", deadline, policy: POLICY });
      state.storage.sql.exec("DELETE FROM container_schedules");
      const wake = wakeTime(deadline).getTime();
      const schedule = sandbox.schedule.bind(sandbox);
      let failed = false;
      vi.spyOn(sandbox, "schedule").mockImplementation(async (when, callback, payload) => {
        if (!failed && when instanceof Date && when.getTime() === wake) {
          failed = true;
          throw new Error("scripted schedule failure");
        }
        return schedule(when, callback, payload);
      });
      const destroy = vi.spyOn(Sandbox.prototype, "destroy");

      await expect(sandbox.railheadRetire()).rejects.toThrow("scripted schedule failure");

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(stored(state).fence).toEqual({ phase: "retired", deadline });
      expect(scheduledWakes(state)).not.toContain(wake);

      // The repository keeps the slot and releases the sandbox again.
      await sandbox.railheadRetire();

      expect(scheduledWakes(state)).toContain(wake);
      await pastDeadline(wake);
      await sandbox.alarm();

      expect(stored(state)).toEqual({ tables: [], fence: undefined });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  }, 15_000);

  it("keeps its record and a wake-up at an alarm before the deadline", async () => {
    await withRailheadSandbox(null, async (sandbox, _container, state) => {
      const deadline = Date.now() + 60_000;
      state.storage.kv.put("railhead:fence", { phase: "live", deadline, policy: POLICY });
      await sandbox.railheadRetire();

      await sandbox.alarm();

      expect(stored(state).fence).toEqual({ phase: "retired", deadline });
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("keeps the record of a teardown it never confirmed, though the deadline passed", async () => {
    await withRailheadSandbox(null, async (sandbox, _container, state) => {
      const deadline = Date.now() - 1_000;
      const retiring = { phase: "retiring", deadline, attempts: 9 };
      state.storage.kv.put("railhead:fence", retiring);

      await sandbox.alarm();

      expect(stored(state).fence).toEqual(retiring);
    });
  });
});

describe("RailheadSandbox reopened over a fence record from before policies were kept", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a live record without a policy every use, retires it at its alarm and deletes it", async () => {
    await withRailheadSandbox(null, async (sandbox, _container, state) => {
      const destroy = vi.spyOn(Sandbox.prototype, "destroy");
      const deadline = Date.now() + 30;
      // As the previous release recorded a started sandbox, with its deadline wake-up.
      state.storage.kv.put("railhead:fence", { phase: "live", deadline });
      await sandbox.schedule(new Date(deadline), "railheadExpire");

      await expect(sandbox.railheadJoin(POLICY, deadline)).rejects.toThrow("refused: retired");
      await expect(sandbox.railheadExec({ command: "true", timeoutMs: 1_000 })).rejects.toThrow(
        "refused: retired",
      );
      expect(await sandbox.railheadGrantCurrent(deadline)).toBe(false);
      expect(destroy).not.toHaveBeenCalled();

      await pastDeadline(deadline);
      await sandbox.alarm();

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(stored(state)).toEqual({ tables: [], fence: undefined });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("releases a live record without a policy, destroying its container", async () => {
    await withRailheadSandbox(null, async (sandbox, _container, state) => {
      const destroy = vi.spyOn(Sandbox.prototype, "destroy");
      const deadline = Date.now() + 60_000;
      state.storage.kv.put("railhead:fence", { phase: "live", deadline });

      await sandbox.railheadRetire();

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(stored(state).fence).toEqual({ phase: "retired", deadline });
      expect(await sandbox.railheadGrantCurrent(deadline)).toBe(false);
    });
  });

  it("keeps a retirement recorded with no deadline through the disposal alarm, refusing a delayed start", async () => {
    await withRailheadSandbox(null, async (sandbox, _container, state) => {
      // As the previous release recorded a sandbox released before its start arrived, with the
      // teardown retry wake-up its release scheduled, now due.
      state.storage.kv.put("railhead:fence", { phase: "retired", deadline: 0 });
      await sandbox.schedule(new Date(Date.now() - 1_000), "railheadExpire");
      const before = Date.now();

      await sandbox.alarm();

      // The record now holds the latest deadline a start admitted before the upgrade can carry, and
      // the object asked to be woken then.
      const fence = stored(state).fence;
      expect(fence).toEqual({ phase: "retired", deadline: expect.any(Number) });
      const latest = storedDeadline(fence);
      expect(latest).toBeGreaterThanOrEqual(before + MAX_SANDBOX_LIFETIME_MS);
      expect(await state.storage.getAlarm()).not.toBeNull();

      const policy = { host: HOST, namespace: NAMESPACE, read: [REPO], write: null };
      await expect(sandbox.railheadStart(policy, Date.now() + 60_000)).rejects.toThrow(
        "refused: retired",
      );
      expect(stored(state).fence).toEqual({ phase: "retired", deadline: latest });
      expect(await sandbox.railheadGrantCurrent(Date.now() + 60_000)).toBe(false);
    });
  });

  it("keeps an unconfirmed teardown recorded with no deadline retrying under a real deadline", async () => {
    await withRailheadSandbox(null, async (sandbox, _container, state) => {
      state.storage.kv.put("railhead:fence", { phase: "retiring", deadline: 0, attempts: 2 });
      const before = Date.now();

      await sandbox.railheadRetire();

      const fence = stored(state).fence;
      expect(fence).toEqual({ phase: "retired", deadline: expect.any(Number) });
      expect(storedDeadline(fence)).toBeGreaterThanOrEqual(before + MAX_SANDBOX_LIFETIME_MS);
    });
  });
});

/** The object's own tables and keys: what would keep it stored. */
function stored(state: DurableObjectState): { tables: string[]; fence: unknown } {
  const tables = state.storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'",
    )
    .toArray()
    .map((row) => row.name);
  return { tables, fence: state.storage.kv.get("railhead:fence") };
}

/** The times, in milliseconds, of the fence's wake-ups still scheduled with the SDK. */
function scheduledWakes(state: DurableObjectState): number[] {
  return state.storage.sql
    .exec<{ time: number }>(
      "SELECT time FROM container_schedules WHERE callback = 'railheadExpire' ORDER BY time",
    )
    .toArray()
    .map((row) => row.time * 1_000);
}

/** The deadline of a stored fence record. */
function storedDeadline(fence: unknown): number {
  if (typeof fence !== "object" || fence === null || !("deadline" in fence)) {
    throw new Error("no fence record");
  }
  if (typeof fence.deadline !== "number") throw new Error("the fence record has no deadline");
  return fence.deadline;
}

/** Waits, in real time, until `deadline` has passed. */
async function pastDeadline(deadline: number): Promise<void> {
  while (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("RailheadSandbox's SDK transport at retirement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { destroy: "failed, leaving its connection open", fails: true },
    { destroy: "closed its connection", fails: false },
  ])(
    "sends nothing over RPC when a restore resumes after a retirement whose destroy $destroy",
    async ({ fails }) => {
      const bucket = pausedBucket();
      await withRailheadSandbox(bucket.binding, async (sandbox, container) => {
        // An earlier call opened the RPC connection while the sandbox was live.
        await sandbox.client.connect();
        expect(container.requests).toEqual(["http://localhost:3000/rpc"]);
        const restore = sandbox
          .restoreBackup({ id: BACKUP_ID, dir: "/workspace", localBucket: true })
          .then(
            () => "restored",
            (error: unknown) => (error instanceof Error ? error.message : "unknown"),
          );
        await bucket.reading;

        // The retirement's destroy fails or succeeds; any later one succeeds.
        const destroyed = deferred();
        const destroy = sandbox.destroy.bind(sandbox);
        let destroys = 0;
        vi.spyOn(sandbox, "destroy").mockImplementation(async () => {
          destroys += 1;
          try {
            if (fails && destroys === 1) throw new Error("scripted destroy failure");
            await destroy();
          } finally {
            destroyed.resolve();
          }
        });
        const release = sandbox.railheadRetire().then(
          () => "retired",
          (error: unknown) => (error instanceof Error ? error.message : "unknown"),
        );
        await destroyed.promise;
        expect(sandbox.client.isWebSocketConnected()).toBe(fails);
        const requests = container.requests.length;
        const messages = container.messages.length;

        // The archive read returns after retirement; the restore goes on to make its session.
        bucket.answer();
        const outcome = await Promise.race([restore, settle().then(() => "still running")]);
        await settle();

        // Nothing reached the container: no session, command, file write or extraction, and no
        // upgrade that could start it again.
        expect(container.messages.slice(messages)).toEqual([]);
        expect(container.requests.slice(requests)).toEqual([]);
        expect(outcome).toBe("sandbox operation refused: retired");
        expect(await release).toBe(fails ? "scripted destroy failure" : "retired");
      });
    },
  );

  it.each(["rpc", "http"] as const)(
    "admits every %s client member that can reach the container only while live",
    async (transport) => {
      await withRailheadSandbox(null, async (sandbox) => {
        await sandbox.setTransport(transport);
        const members = clientMembers(sandbox.client);
        const reaching = members.filter((member) => !LOCAL_CLIENT_MEMBERS.has(member));
        expect(reaching).toEqual(expect.arrayContaining(["backup", "commands", "files", "utils"]));
        for (const member of members) Reflect.get(sandbox.client, member);

        await sandbox.railheadRetire();

        const refused = reaching.filter((member) => {
          try {
            Reflect.get(sandbox.client, member);
            return false;
          } catch (error) {
            return error instanceof Error && error.message === "sandbox operation refused: retired";
          }
        });
        expect(refused).toEqual(reaching);
        // Closing the connection stays possible, so a destroy can still run.
        sandbox.client.disconnect();
        expect(sandbox.client.isWebSocketConnected()).toBe(false);
      });
    },
  );
});

/** Every member a client has, on itself and its prototypes, except its constructor. */
function clientMembers(client: object): string[] {
  const members = new Set<string>();
  for (
    let level: object | null = client;
    level !== null && level !== Object.prototype;
    level = Reflect.getPrototypeOf(level)
  ) {
    for (const member of Object.getOwnPropertyNames(level)) members.add(member);
  }
  members.delete("constructor");
  return [...members].toSorted();
}

function noop(): void {}

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = noop;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The SDK's result for a command that ran with `scripted`'s outcome. */
function execResult(command: string, scripted: Scripted): ExecResult {
  return {
    success: scripted.exitCode === 0,
    exitCode: scripted.exitCode,
    stdout: scripted.stdout ?? "",
    stderr: "",
    command,
    duration: 0,
    timestamp: "",
  };
}

/** A started process that exits with `exitCode`; every call reaches the container first. */
function scriptedProcess(command: string, exitCode: number, reach: () => Promise<void>): Process {
  const unscripted = async (): Promise<never> => {
    await reach();
    throw new Error("the runner made a process call the test does not script");
  };
  return {
    id: "proc_1",
    command,
    status: "running",
    startTime: new Date(0),
    kill: unscripted,
    getStatus: unscripted,
    getLogs: unscripted,
    waitForLog: unscripted,
    waitForPort: unscripted,
    waitForExit: async () => {
      await reach();
      return { exitCode };
    },
  };
}

/** One log file as the SDK lists it. */
function logFile(absolutePath: string, size: number) {
  return {
    name: absolutePath.slice(absolutePath.lastIndexOf("/") + 1),
    absolutePath,
    relativePath: absolutePath,
    type: "file" as const,
    size,
    modifiedAt: "",
    mode: "0644",
    permissions: { readable: true, writable: true, executable: false },
  };
}

/** What one scripted sandbox command returns. */
interface Scripted {
  exitCode: number;
  stdout?: string;
}

/** Answers a check's command from the files in the workspace when it runs. */
type ScriptedCommand = (command: string, workspace: ReadonlySet<string>) => Scripted;

/**
 * A Sandbox Durable Object stub that records every call and answers from a script. It models the
 * workspace as a set of paths: a fresh checkout replaces it with the fetched commit's tree, an
 * overlay adds that tree without deleting anything, and a backup restores the paths it captured.
 * Given a fence, its SDK calls pass through `fenceSandbox`, as `RailheadSandbox`'s do, and each
 * scripted call reaches the container through a transport client that `admitSandboxClient` admits
 * on the fence, as the SDK's calls reach it through `RailheadSandbox.client`.
 */
class ScriptedSandbox {
  readonly calls: string[] = [];
  readonly envs: Record<string, string | undefined>[] = [];
  readonly backups: { localBucket: unknown }[] = [];
  readonly restored: unknown[] = [];
  readonly scripts: string[] = [];
  started: unknown = null;
  /** The size every command's stdout and stderr files report. */
  logBytes = 0;
  /** Whether reading a log's tail exits nonzero. */
  tailFails = false;
  /** Whether `railheadRetire` rejects without retiring. */
  retireFails = false;
  /** Whether `createBackup` rejects. */
  backupFails = false;
  private workspace = new Set<string>();
  private lastCommand: Scripted = { exitCode: 0 };

  constructor(
    private readonly checkout: (overlay: boolean) => Scripted,
    private readonly command: ScriptedCommand,
    private readonly trees: Readonly<Record<string, readonly string[]>>,
    private readonly saved: Map<string, ReadonlySet<string>>,
    private readonly fence: SandboxFence | null,
  ) {
    this.sdk = fence === null ? this.scripted() : fenceSandbox(fence, this.scripted());
    if (fence !== null) admitSandboxClient(this.transport, () => fence.admit());
  }

  /** The SDK's transport client, which sends each scripted call to the container. */
  private readonly transport = { client: { send: async () => undefined } };

  /** `RailheadSandbox.railheadJoin`, through `fence` when the test gives one. */
  async railheadJoin(policy: unknown, expiresAt: unknown) {
    this.calls.push("join");
    this.started = { policy, expiresAt };
    const grant = parseSandboxGrant(this.started);
    if (grant === null) throw new Error("the runner joined the sandbox without a valid grant");
    await this.fence?.join(grant.policy, grant.expiresAt);
  }

  /**
   * The SDK calls the runner makes. With a fence they pass through `fenceSandbox`, the wrapping
   * `RailheadSandbox` applies, over the scripted calls; without one they reach the script directly.
   */
  private readonly sdk: FencedSandboxCalls;

  execWithSessionToken(command: string, session: string, options?: ExecOptions) {
    return this.sdk.execWithSessionToken(command, session, options);
  }

  startProcess(command: string, options?: ProcessOptions, sessionId?: string) {
    return this.sdk.startProcess(command, options, sessionId);
  }

  createBackup(options: BackupOptions) {
    return this.sdk.createBackup(options);
  }

  restoreBackup(backup: DirectoryBackup) {
    return this.sdk.restoreBackup(backup);
  }

  listFiles(path: string, options?: ListFilesOptions) {
    return this.sdk.listFiles(path, options);
  }

  /** Reaches the container as the SDK does, through its (admitted) transport client. */
  private async reach(): Promise<void> {
    await this.transport.client.send();
  }

  private scripted(): FencedSandboxCalls {
    return {
      execWithSessionToken: async (command, session, options) => {
        await this.reach();
        return execResult(command, this.execScripted(command, session, options));
      },
      startProcess: async (command, options) => {
        await this.reach();
        this.calls.push(`command:${command}`);
        this.envs.push({ ...options?.env });
        this.lastCommand = this.command(command, this.workspace);
        return scriptedProcess(command, this.lastCommand.exitCode, () => this.reach());
      },
      createBackup: async (options) => {
        await this.reach();
        this.calls.push("backup");
        this.backups.push({ localBucket: options.localBucket });
        if (this.backupFails) throw new Error("scripted backup failure");
        const id = crypto.randomUUID();
        this.saved.set(id, new Set(this.workspace));
        return { id, dir: "/workspace", localBucket: options.localBucket ?? false };
      },
      restoreBackup: async (backup) => {
        await this.reach();
        this.calls.push("restore");
        this.restored.push(backup);
        this.workspace = new Set(this.saved.get(backup.id));
        return { success: true, dir: backup.dir, id: backup.id };
      },
      listFiles: async (path) => {
        await this.reach();
        const files =
          this.logBytes === 0
            ? []
            : ["/tmp/ci-step.out", "/tmp/ci-step.err"].map((absolutePath) =>
                logFile(absolutePath, this.logBytes),
              );
        return { success: true, path, files, count: files.length, timestamp: "" };
      },
      containerFetch: async () => new Response(null, { status: 204 }),
    };
  }

  private execScripted(command: string, _session: string, options?: ExecOptions): Scripted {
    this.envs.push({ ...options?.env });
    if (command.startsWith(`tail -c ${INLINE_LOG_BYTES} `)) {
      // Labelled by the log's size: a read above the inline limit keeps only the tail.
      this.calls.push(this.logBytes > INLINE_LOG_BYTES ? "log:tail" : "log:read");
      return { exitCode: this.tailFails ? 1 : 0, stdout: "last lines" };
    }
    if (command.startsWith("tail -c")) {
      return {
        exitCode: 0,
        stdout: command.includes(".out") ? (this.lastCommand.stdout ?? "") : "",
      };
    }
    if (command.includes("git init")) {
      const overlay = !command.startsWith("rm -rf");
      this.calls.push(overlay ? "checkout:overlay" : "checkout");
      this.scripts.push(command);
      const result = this.checkout(overlay);
      if (result.exitCode === 0) {
        if (!overlay) this.workspace.clear();
        const sha = /fetch --depth=1 origin '([0-9a-f]{40})'/.exec(command)?.[1] ?? "";
        for (const path of this.trees[sha] ?? []) this.workspace.add(path);
      }
      return result;
    }
    this.calls.push(`exec:${command}`);
    return { exitCode: 0 };
  }

  /** `RailheadSandbox.railheadRetire`, through `fence` when the test gives one. */
  async railheadRetire() {
    this.calls.push("retire");
    if (this.retireFails) throw new Error("retire failed");
    await this.fence?.retire();
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

/**
 * An R2 bucket holding one install cache pointer, written by `producedBySha`, and its backup. A
 * pointer write is recorded through `record`.
 */
class CacheBucket {
  constructor(
    private readonly producedBySha: string,
    private readonly record: (call: string) => void,
  ) {}

  async get(key: string) {
    if (key.startsWith("cache/")) {
      return {
        json: async () => ({
          backupId: BACKUP_ID,
          dir: "/workspace",
          producedBySha: this.producedBySha,
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
  async put(key: string) {
    if (key.startsWith("cache/")) this.record("pointer");
    return null;
  }
}

type Outcome = { kind: "pass" } | { kind: "rejected"; failure: RunnerFailure };

/**
 * The pipeline each test runs: an install, which a check's single runner stands for, and, when
 * `chained`, a test chained on its workspace, which an admitted sandbox refuses.
 */
class CheckRun extends CIWorkflow<CloudflareArtifacts, CiBindings> {
  static override getProvider() {
    return railheadCheckout({ owner: NAMESPACE, repo: REPO });
  }

  outcome: Outcome | null = null;
  /** The failed runner's output, as the SDK stores and shows it. */
  output: string | null = null;
  cached = false;
  /** Whether a test runner is chained on the install's workspace. */
  chained = false;
  /** The literal environment the last runner is given. */
  testEnv: Record<string, string> = {};

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
        ...(this.chained ? {} : { env: this.testEnv }),
      });
      if (this.chained) {
        await install.runner({ name: "test", command: "npm test", config, env: this.testEnv });
      }
      this.outcome = { kind: "pass" };
    } catch (rejection) {
      this.outcome = { kind: "rejected", failure: classifyRunnerFailure(rejection) };
      if (isCiRunnerFailure(rejection)) this.output = rejection.output;
    }
  }
}

/** Runs the pipeline for `sha` against one scripted sandbox and reports what it saw. */
async function run(options: {
  checkout?: (overlay: boolean) => Scripted;
  command?: Scripted | ScriptedCommand;
  sha?: string;
  cached?: boolean;
  /** The commit that wrote the install cache pointer; defaults to the run's own. */
  cachedBy?: string;
  /** Each commit's tracked files, and those of the cached backup, for workspace assertions. */
  trees?: Record<string, readonly string[]>;
  /** The fence the sandbox starts through; the run must then start only one sandbox. */
  fence?: SandboxFence;
  /**
   * Whether the sandbox module admitted the slot, starting `fence` under the checkout's policy and
   * deadline before the run; defaults to true.
   */
  admit?: boolean;
  /** The literal environment the last runner is given. */
  testEnv?: Record<string, string>;
  /** Whether a test runner is chained on the install; defaults to false. */
  chained?: boolean;
  /** Whether the run carries the slot the repository admitted for it; defaults to true. */
  admitted?: boolean;
  /** Whether the Worker has a BACKUP_BUCKET binding; defaults to true. */
  backupBucket?: boolean;
  /** The size of every command's logs; the SDK reads a log above its inline limit as its tail. */
  logBytes?: number;
  tailFails?: boolean;
  retireFails?: boolean;
  /** Whether a backup, if one were attempted, fails. */
  backupFails?: boolean;
}) {
  const sha = options.sha ?? SHA;
  const command = options.command ?? { exitCode: 0 };
  const cachedBy = options.cachedBy ?? sha;
  const trees = options.trees ?? {};
  const sandbox = new ScriptedSandbox(
    options.checkout ?? (() => ({ exitCode: 0 })),
    typeof command === "function" ? command : () => command,
    trees,
    new Map([[BACKUP_ID, new Set(trees[cachedBy])]]),
    options.fence ?? null,
  );
  sandbox.logBytes = options.logBytes ?? 0;
  sandbox.tailFails = options.tailFails ?? false;
  sandbox.retireFails = options.retireFails ?? false;
  sandbox.backupFails = options.backupFails ?? false;
  // Every method the runner calls on the sandbox object, whatever path it takes.
  const runnerCalls = new Set<string>();
  const observed = new Proxy(sandbox, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (typeof key === "string") runnerCalls.add(key);
      return value.bind(target);
    },
  });
  const artifacts = new RecordingArtifacts();
  // Every sandbox name the runner opens.
  const opened: string[] = [];
  const bindings = {
    CF_TOKEN: "cf-secret-token",
    R2_ACCESS_KEY_ID: "r2-key-id",
    R2_SECRET_ACCESS_KEY: "r2-secret",
    ARTIFACTS: artifacts,
    ...((options.backupBucket ?? true)
      ? { BACKUP_BUCKET: new CacheBucket(cachedBy, (call) => sandbox.calls.push(call)) }
      : {}),
    BACKUP_BUCKET_NAME: "backups",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    SANDBOX: {
      idFromName: (name: string) => {
        opened.push(name);
        return name;
      },
      get: () => observed,
    },
    CI_WORKFLOW: {},
  };
  // Workerd constructs a Workflow only for a real instance, so the test builds one from the
  // prototype and gives it the fake bindings the engine reads through `this.env`.
  const workflow: CheckRun = Object.create(CheckRun.prototype);
  Object.assign(workflow, {
    env: bindings,
    cached: options.cached ?? false,
    chained: options.chained ?? false,
    testEnv: options.testEnv ?? {},
    outcome: null,
    output: null,
  });
  const step = {
    do: async (_name: string, _config: unknown, body: (ctx: { attempt: number }) => unknown) =>
      body({ attempt: 1 }),
  };
  // The slot the repository admitted for the run, as admission now would set it.
  const deadline = Date.now() + MAX_SANDBOX_LIFETIME_MS;
  if (options.fence !== undefined && (options.admit ?? true)) {
    await options.fence.start(POLICY, deadline);
  }
  const providerData = {
    namespace: NAMESPACE,
    ...((options.admitted ?? true) ? { slot: { sandbox: SANDBOX, deadline } } : {}),
  };
  const event: WorkflowEvent<CiParams<CloudflareArtifacts>> = {
    payload: {
      provider: "cloudflare-artifacts",
      providerData,
      event: { type: "push" },
      owner: NAMESPACE,
      repo: REPO,
      sha,
      trigger: "push",
      ref: "refs/heads/candidate/chk_1/head",
    },
    timestamp: new Date(),
    instanceId: "chk_1",
    workflowName: "checks",
  };
  // The fakes implement only what the engine calls, not the SDK's full binding and step types.
  await Reflect.apply(CheckRun.prototype.run, workflow, [event, step]);
  return {
    outcome: workflow.outcome,
    output: workflow.output,
    sandbox,
    artifacts,
    runnerCalls,
    opened,
  };
}

const SECRETS = [
  "cf-secret-token",
  "r2-key-id",
  "r2-secret",
  "Authorization",
  "SOURCE_CONTROL_TOKEN",
];

describe("a check run through the patched SDK", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("checks out through the gateway with no credential anywhere in the sandbox", async () => {
    const { outcome, sandbox, artifacts, opened } = await run({});

    expect(outcome).toEqual({ kind: "pass" });
    // The runner opens the admitted slot's sandbox, never one of its own naming.
    expect(new Set(opened)).toEqual(new Set([SANDBOX]));
    expect(sandbox.calls).toEqual([
      "join",
      "checkout",
      "command:(npm ci) > /tmp/ci-step.out 2> /tmp/ci-step.err",
      "log:read",
      "log:read",
      "retire",
    ]);
    expect(sandbox.started).toEqual({
      policy: { host: HOST, namespace: NAMESPACE, read: [REPO], write: null },
      expiresAt: expect.any(Number),
    });
    // Credential probes: the checkout script, every command's environment and Artifacts calls.
    const seen = JSON.stringify([sandbox.scripts, sandbox.envs]);
    for (const secret of SECRETS) expect(seen).not.toContain(secret);
    expect(sandbox.scripts[0]).toContain(`fetch --depth=1 origin '${SHA}'`);
    expect(artifacts.calls).toEqual([]);
    // Nothing reads a fenced run's workspace afterwards, so it is never backed up.
    expect(sandbox.backups).toEqual([]);
  });

  it("calls no sandbox method that bypasses the fence", async () => {
    const runs = await Promise.all([
      run({}),
      run({ logBytes: INLINE_LOG_BYTES + 1 }),
      run({ chained: true }),
      run({ command: { exitCode: 1 } }),
      run({ checkout: () => ({ exitCode: 128 }) }),
    ]);
    const called = [...new Set(runs.flatMap((result) => [...result.runnerCalls]))].toSorted();
    // The sandbox module's own fenced entry points, and the SDK calls RailheadSandbox fences.
    const fenced: readonly string[] = ["railheadJoin", "railheadRetire", ...FENCED_SANDBOX_METHODS];

    expect(called.filter((method) => !fenced.includes(method))).toEqual([]);
    expect(called).toEqual([
      "execWithSessionToken",
      "listFiles",
      "railheadJoin",
      "railheadRetire",
      "startProcess",
    ]);
  });

  it("serves the checkout's grant while the check runs and retires the fence when it ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const expiresAt = NOW + MAX_SANDBOX_LIFETIME_MS;
    await withFence(async (fence, recorder) => {
      const current: boolean[] = [];
      const command: ScriptedCommand = () => {
        current.push(fence.grantCurrent(expiresAt));
        return { exitCode: 0 };
      };
      const { outcome, sandbox } = await run({ fence, command });
      const gateway = registeredGateway(fence);

      const after = await gateway.serve(
        fetchRefs(`https://${HOST}/git/railhead/demo.git`),
        sandbox.started,
      );

      expect(outcome).toEqual({ kind: "pass" });
      expect(sandbox.started).toEqual({
        policy: { host: HOST, namespace: NAMESPACE, read: [REPO], write: null },
        expiresAt,
      });
      expect(recorder.routed).toEqual([parseSandboxGrant(sandbox.started)]);
      expect(current).toEqual([true]);
      // The runner's own cleanup retired the fence: nothing in the test did.
      expect(sandbox.calls.slice(-3)).toEqual(["log:read", "log:read", "retire"]);
      expect(sandbox.calls).not.toContain("destroy");
      expect(recorder.destroys).toBe(1);
      expect(fence.grantCurrent(expiresAt)).toBe(false);
      expect(after.status).toBe(403);
      expect(await after.text()).toContain("retired");
      expect(gateway.minted).toEqual([]);
      expect(gateway.forwarded).toEqual([]);
    });
  });

  it("refuses a runner chained on the install before it reaches the retired sandbox", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const expiresAt = NOW + MAX_SANDBOX_LIFETIME_MS;
    await withFence(async (fence, recorder) => {
      const { outcome, output, sandbox } = await run({ chained: true, fence });

      // The install retired the slot's one incarnation; the chained test never asked to start it.
      expect(outcome).toEqual({
        kind: "rejected",
        failure: { conclusion: "error", runner: "test", reason: "infrastructure" },
      });
      expect(output).toBe(
        "runner(test): its parent saved no workspace (a fenced run, or no BACKUP_BUCKET binding), so a chained runner cannot inherit it",
      );
      expect(sandbox.calls).toEqual([
        "join",
        "checkout",
        "command:(npm ci) > /tmp/ci-step.out 2> /tmp/ci-step.err",
        "log:read",
        "log:read",
        "retire",
      ]);
      expect(recorder.routed).toHaveLength(1);
      expect(sandbox.restored).toEqual([]);
      expect(fence.grantCurrent(expiresAt)).toBe(false);
    });
  });

  it.each([
    ["a passing check", { exitCode: 0 }],
    ["a failing check", { exitCode: 1 }],
  ])(
    "fails %s whose sandbox was not destroyed, with the grant ended and the retry kept",
    async (_name, command) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const expiresAt = NOW + MAX_SANDBOX_LIFETIME_MS;
      await withFence(async (fence, recorder) => {
        recorder.failingDestroys = 1;
        const { outcome, sandbox } = await run({ fence, command });
        const gateway = registeredGateway(fence);

        const after = await gateway.serve(
          fetchRefs(`https://${HOST}/git/railhead/demo.git`),
          sandbox.started,
        );

        // Railhead could not confirm the sandbox is gone, so the run neither passes nor blames
        // the change.
        expect(outcome).toEqual({
          kind: "rejected",
          failure: { conclusion: "error", runner: "install", reason: "infrastructure" },
        });
        expect(sandbox.calls.at(-1)).toBe("retire");
        expect(recorder.destroys).toBe(1);
        // Retirement was recorded before the destroy, so the grant already ended.
        expect(after.status).toBe(403);
        expect(gateway.minted).toEqual([]);
        // The fence kept a retry: its wake-up destroys the container.
        expect(recorder.wakes.at(-1)).toBeGreaterThan(NOW);
        await fence.expire();
        expect(recorder.destroys).toBe(2);
        expect(fence.grantCurrent(expiresAt)).toBe(false);
      });
    },
  );

  it.each([
    ["at the inline limit", INLINE_LOG_BYTES, ["log:read", "log:read"]],
    ["above the inline limit", INLINE_LOG_BYTES + 1, ["log:tail", "log:tail"]],
  ])(
    "reads the logs of a check whose logs are %s before retiring, and publishes no cache",
    async (_name, logBytes, reads) => {
      // The runner asks for a cache, which a fenced check never uses.
      const { outcome, sandbox } = await run({ cached: true, cachedBy: "c".repeat(40), logBytes });

      expect(outcome).toEqual({ kind: "pass" });
      expect(sandbox.calls).toEqual([
        "join",
        "checkout",
        "command:(npm ci) > /tmp/ci-step.out 2> /tmp/ci-step.err",
        ...reads,
        "retire",
      ]);
    },
  );

  it("records a check whose large-log sandbox was not retired as an error and publishes no cache", async () => {
    const { outcome, sandbox } = await run({
      cached: true,
      cachedBy: "c".repeat(40),
      logBytes: INLINE_LOG_BYTES + 1,
      retireFails: true,
    });

    expect(outcome).toEqual({
      kind: "rejected",
      failure: { conclusion: "error", runner: "install", reason: "infrastructure" },
    });
    expect(sandbox.calls.slice(-3)).toEqual(["log:tail", "log:tail", "retire"]);
    expect(sandbox.calls).not.toContain("pointer");
    expect(sandbox.calls.filter((call) => call.startsWith("command:"))).toHaveLength(1);
  });

  it("records a large-log check whose destroy failed as an error, with the grant ended and no cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const expiresAt = NOW + MAX_SANDBOX_LIFETIME_MS;
    await withFence(async (fence, recorder) => {
      recorder.failingDestroys = 1;
      const { outcome, sandbox } = await run({
        cached: true,
        cachedBy: "c".repeat(40),
        logBytes: INLINE_LOG_BYTES + 1,
        fence,
      });
      const gateway = registeredGateway(fence);

      const after = await gateway.serve(
        fetchRefs(`https://${HOST}/git/railhead/demo.git`),
        sandbox.started,
      );

      expect(outcome).toEqual({
        kind: "rejected",
        failure: { conclusion: "error", runner: "install", reason: "infrastructure" },
      });
      expect(sandbox.calls.slice(-3)).toEqual(["log:tail", "log:tail", "retire"]);
      expect(sandbox.calls).not.toContain("pointer");
      expect(after.status).toBe(403);
      expect(recorder.wakes.at(-1)).toBeGreaterThan(NOW);
      await fence.expire();
      expect(recorder.destroys).toBe(2);
      expect(fence.grantCurrent(expiresAt)).toBe(false);
    });
  });

  it("records a large log that cannot be read as an error, still retiring the sandbox", async () => {
    const { outcome, sandbox } = await run({
      cached: true,
      cachedBy: "c".repeat(40),
      logBytes: INLINE_LOG_BYTES + 1,
      tailFails: true,
    });

    expect(outcome).toEqual({
      kind: "rejected",
      failure: { conclusion: "error", runner: "install", reason: "infrastructure" },
    });
    expect(sandbox.calls.slice(-2)).toEqual(["log:tail", "retire"]);
    expect(sandbox.calls).not.toContain("pointer");
  });

  it("starts nothing for a well-formed slot the repository never admitted", async () => {
    await withFence(async (fence, recorder) => {
      const { outcome, output, sandbox } = await run({ fence, admit: false });

      expect(outcome).toEqual({
        kind: "rejected",
        failure: { conclusion: "error", runner: "install", reason: "infrastructure" },
      });
      expect(output).toBe("sandbox operation refused: not_started");
      // Nothing routed or probed: the container never started, and the name is retired.
      expect(recorder.routed).toEqual([]);
      expect(sandbox.calls).toEqual(["join", "retire"]);
      expect(sandbox.scripts).toEqual([]);
      await expect(fence.start(POLICY, Date.now() + 60_000)).rejects.toThrow("refused: retired");
    });
  });

  it("refuses a runner whose checkout names another policy than the admitted one", async () => {
    await withFence(async (fence, recorder) => {
      const admitted = { ...POLICY, read: ["other"] };
      await fence.start(admitted, Date.now() + MAX_SANDBOX_LIFETIME_MS);
      const routed = recorder.routed.length;

      const { outcome, sandbox } = await run({ fence, admit: false });

      expect(outcome).toEqual({
        kind: "rejected",
        failure: { conclusion: "error", runner: "install", reason: "infrastructure" },
      });
      // The runner never ran a command, and the admitted grant was never replaced.
      expect(sandbox.scripts).toEqual([]);
      expect(recorder.routed).toHaveLength(routed);
      expect(recorder.routed.every((grant) => grant.policy.read[0] === "other")).toBe(true);
    });
  });

  it("runs no command when the sandbox's fence refuses the runner", async () => {
    await withFence(async (fence) => {
      // A retired object never starts again, as when the deadline passed before the runner began.
      await fence.retire();
      const { outcome, sandbox } = await run({ fence, admit: false });

      expect(outcome).toEqual({
        kind: "rejected",
        failure: { conclusion: "error", runner: "install", reason: "infrastructure" },
      });
      expect(sandbox.calls).toEqual(["join", "retire"]);
    });
  });

  it("records a checkout that cannot find the commit as an error and never runs the check", async () => {
    const { outcome, sandbox } = await run({ checkout: () => ({ exitCode: 128 }) });

    expect(outcome).toEqual({
      kind: "rejected",
      failure: { conclusion: "error", runner: "install", reason: "checkout" },
    });
    expect(sandbox.calls).toEqual(["join", "checkout", "retire"]);
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

  it("runs nothing and opens no sandbox for a run without an admitted slot", async () => {
    const { outcome, sandbox, artifacts, opened } = await run({ admitted: false });

    expect(outcome).toEqual({
      kind: "rejected",
      failure: { conclusion: "error", runner: "install", reason: "infrastructure" },
    });
    expect(opened).toEqual([]);
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

  it.each([
    ["the runner's name", { NODE_ENV: "install" }],
    ["the exit code", { CI: "1" }],
  ])(
    "records a failure when an env value matches %s, and still redacts it from the output",
    async (_name, testEnv) => {
      const value = Object.values(testEnv)[0] ?? "";
      const { outcome, output } = await run({
        testEnv,
        command: { exitCode: 1, stdout: `env=${value}` },
      });

      expect(outcome).toEqual({
        kind: "rejected",
        failure: { conclusion: "fail", runner: "install", exitCode: 1 },
      });
      expect(output).toBe(
        "install failed with exit code 1\n=== stdout ===\nenv=[REDACTED]\n=== stderr ===\n",
      );
    },
  );

  it("keeps a failed checkout an error when an env value redacts its message", async () => {
    const { outcome, output } = await run({
      testEnv: { STAGE: "source checkout" },
      checkout: () => ({ exitCode: 1 }),
    });

    expect(outcome).toEqual({
      kind: "rejected",
      failure: { conclusion: "error", runner: "install", reason: "infrastructure" },
    });
    expect(output).toBe("[REDACTED] exited with status 1");
  });

  it("runs the command for every check of the same commit, never passing from a cache", async () => {
    // The bucket holds a cache pointer written by this very commit, which the SDK would reuse.
    const first = await run({ cached: true });
    const second = await run({ cached: true });

    for (const { outcome, sandbox, artifacts } of [first, second]) {
      expect(outcome).toEqual({ kind: "pass" });
      expect(sandbox.calls).toContain("command:(npm ci) > /tmp/ci-step.out 2> /tmp/ci-step.err");
      expect(sandbox.calls).not.toContain("pointer");
      expect(sandbox.restored).toEqual([]);
      // No cache fingerprint was even read.
      expect(artifacts.calls).toEqual([]);
    }
  });

  it("runs a single runner without a BACKUP_BUCKET binding, with no backup or cache", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(noop);
    const { outcome, sandbox, artifacts } = await run({
      backupBucket: false,
      cached: true,
      chained: false,
    });

    expect(outcome).toEqual({ kind: "pass" });
    // No cache lookup, restore or backup; the fence still starts and retires.
    expect(sandbox.calls).toEqual([
      "join",
      "checkout",
      "command:(npm ci) > /tmp/ci-step.out 2> /tmp/ci-step.err",
      "log:read",
      "log:read",
      "retire",
    ]);
    expect(sandbox.backups).toEqual([]);
    expect(sandbox.restored).toEqual([]);
    expect(artifacts.calls).toEqual([]);
    const warnings = warn.mock.calls.map(([message]) => message);
    // A fenced check never consults the cache, with or without the binding.
    expect(warnings.filter((message) => String(message).startsWith("[cache]"))).toEqual([]);
    // Nor does it warn of a missing backup it would not make anyway.
    expect(warnings).toEqual([]);
  });

  it("records a chained runner without a BACKUP_BUCKET binding as an error before it starts", async () => {
    vi.spyOn(console, "warn").mockImplementation(noop);
    const { outcome, output, sandbox } = await run({ backupBucket: false, chained: true });

    expect(outcome).toEqual({
      kind: "rejected",
      failure: { conclusion: "error", runner: "test", reason: "infrastructure" },
    });
    expect(output).toContain("no BACKUP_BUCKET binding");
    // The install ran and retired; the chained test never started a sandbox.
    expect(sandbox.calls).toEqual([
      "join",
      "checkout",
      "command:(npm ci) > /tmp/ci-step.out 2> /tmp/ci-step.err",
      "log:read",
      "log:read",
      "retire",
    ]);
  });

  it("passes a fenced check with the R2 binding bound and never attempts its backup", async () => {
    // A backup would fail, turning the passing command into an infrastructure error.
    const { outcome, sandbox } = await run({ chained: false, backupFails: true });

    expect(outcome).toEqual({ kind: "pass" });
    expect(sandbox.calls).not.toContain("backup");
    expect(sandbox.backups).toEqual([]);
  });

  it("never reuses another commit's cached workspace, so a deleted file cannot linger", async () => {
    const before = "c".repeat(40);
    const after = "d".repeat(40);
    // `after` deletes src/legacy.ts but keeps package.json, the cache input, so both commits
    // share one cache key.
    const trees = {
      [before]: ["package.json", "src/index.ts", "src/legacy.ts"],
      [after]: ["package.json", "src/index.ts"],
    };
    const seen: string[][] = [];
    const command: ScriptedCommand = (_line, workspace) => {
      seen.push([...workspace].toSorted());
      return { exitCode: 0 };
    };

    const { outcome, sandbox } = await run({
      sha: after,
      cached: true,
      cachedBy: before,
      trees,
      command,
    });

    expect(outcome).toEqual({ kind: "pass" });
    // The install runs on a clean checkout of its own commit; nothing is restored.
    expect(sandbox.calls).toContain("command:(npm ci) > /tmp/ci-step.out 2> /tmp/ci-step.err");
    expect(sandbox.restored).toEqual([]);
    expect(seen).toEqual([["package.json", "src/index.ts"]]);
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

  it.each([
    ["another repository in the namespace", { ...SOURCE, repo: "other" }],
    [
      "another namespace with matching provider data",
      { ...SOURCE, owner: "other", providerData: { namespace: "other" } },
    ],
  ])("grants no checkout and lists no blobs for %s", async (_name, source) => {
    const artifacts = new RecordingArtifacts();
    const adapter = railheadCheckout(REPOSITORY);
    const bindings = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, ARTIFACTS: artifacts };
    const scoped: ReturnType<typeof adapter.create> = Reflect.apply(adapter.create, adapter, [
      bindings,
    ]);

    await expect(scoped.getSourceCheckout(source)).rejects.toThrow("not the adapter's repository");
    await expect(scoped.listTreeBlobs(source, ["package.json"])).rejects.toThrow(
      "not the adapter's repository",
    );
    expect(artifacts.calls).toEqual([]);
    // Its own repository still gets a checkout.
    expect(await scoped.getSourceCheckout(SOURCE)).toMatchObject({
      fence: { policy: { namespace: NAMESPACE, read: [REPO] } },
    });
  });

  it("accepts only its own repository", () => {
    const adapter = railheadCheckout({ owner: NAMESPACE, repo: REPO });
    const source = { provider: "cloudflare-artifacts", owner: NAMESPACE };

    expect(adapter.accepts({ ...source, repo: REPO })).toBe(true);
    expect(adapter.accepts({ ...source, repo: "other" })).toBe(false);
    expect(adapter.accepts({ ...source, owner: "other", repo: REPO })).toBe(false);
  });
});
