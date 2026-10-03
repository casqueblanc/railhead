// The container Durable Object every sandbox runs in, and the driver the sandbox module uses to
// start, command and destroy it.
//
// The container starts with the internet off and HTTPS intercepted. Every HTTP and HTTPS request it
// makes goes to an outbound handler running in this Worker, outside the container: before a policy
// is set that handler refuses everything, and afterwards it is the Git gateway for that policy until
// the sandbox's deadline or its retirement, whichever comes first: before it mints a token and again
// before it forwards, the gateway asks this object whether the incarnation is still live. No token is
// ever placed in the container; the gateway adds one to each request it forwards. Each object serves
// one incarnation behind a `SandboxFence` (see `fence.ts`), which also enforces each command's
// timeout. Command output is read as a stream and bounded here, before it crosses RPC (see
// `output.ts`).
//
// `ContainerProxy` is the SDK's entrypoint that carries those requests to the handler; the Worker
// exports it beside this class.

import {
  ContainerProxy,
  Sandbox,
  getSandbox,
  type BackupOptions,
  type DirectoryBackup,
  type ExecOptions,
  type ExecResult,
  type ListFilesOptions,
  type Process,
  type ProcessOptions,
  type RestoreBackupResult,
} from "@cloudflare/sandbox";
import { MAX_OUTPUT_BYTES, type SandboxCommand, type SandboxDriver } from "./entry";
import { MAX_TEARDOWN_ATTEMPTS, SandboxFence, teardownRetryDelay } from "./fence";
import { serveGitGateway } from "./gateway";
import { readBoundedExec, type BoundedOutput } from "./output";
import { parseSandboxGrant, type SandboxPolicy } from "./policy";

export { ContainerProxy };

/** The lifetime of each minted Artifacts token, in seconds: the minimum Artifacts accepts. */
const TOKEN_TTL_SECONDS = 60;

/** The SDK's idle stop: longer than `MAX_SANDBOX_LIFETIME_MS`, so it never ends a live attempt. */
const IDLE_BACKSTOP = "45m";

/**
 * The SDK's session token for a command that shares no shell state with the others: what
 * `getSandbox(..., { enableDefaultSession: false })` sends for each `exec` in SDK 0.12.1.
 */
const SESSIONLESS = "__DISABLE_SESSION__";

/** The pause before a new round of deletion retries, once a round has failed. */
export const DISPOSAL_SWEEP_MS = 24 * 60 * 60_000;

/** How many storage deletions in a row failed, kept until one succeeds. */
const DISPOSAL_FAILURES = "railhead:disposal-failures";

/** The outbound handler a sandbox's policy selects. */
const GIT_GATEWAY = "gitGateway";

/** One sandbox's container. Only the sandbox module creates and destroys these. */
export class RailheadSandbox extends Sandbox<Env> {
  override enableInternet = false;
  override interceptHttps = true;

  constructor(...args: ConstructorParameters<typeof Sandbox<Env>>) {
    super(...args);
    admitSandboxClient(this, () => this.#fence.admit());
  }

  readonly #fence = new SandboxFence(
    this.ctx.storage,
    {
      route: (grant) => this.setOutboundHandler(GIT_GATEWAY, grant),
      exec: async (command, options) => {
        // The SDK checks `signal` only before the command starts; the reader stops on it after.
        const stream = await this.execStreamWithSessionToken(command, SESSIONLESS, {
          timeout: options.timeoutMs,
          signal: options.signal,
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        });
        return readBoundedExec(stream, MAX_OUTPUT_BYTES, options.signal);
      },
      destroy: () => this.destroy(),
      wake: async (at) => {
        await this.schedule(wakeTime(at), "railheadExpire");
      },
    },
    Date.now,
  );

  /** Starts this sandbox's one incarnation under `policy` until `deadline`. */
  async railheadStart(policy: SandboxPolicy, deadline: number): Promise<void> {
    await this.#fence.start(policy, deadline);
  }

  /**
   * Admits the patched CI runner to the incarnation the sandbox module's admission started, under
   * the same policy and deadline. It never starts one: a sandbox that was not admitted refuses.
   */
  async railheadJoin(policy: SandboxPolicy, deadline: number): Promise<void> {
    await this.#fence.join(policy, deadline);
  }

  /** Runs one command in the incarnation, cut to its remaining lifetime. */
  async railheadExec(command: SandboxCommand): Promise<BoundedOutput> {
    return this.#fence.exec(command);
  }

  /** Whether the incarnation whose grant lapses at `expiresAt` may still use it. */
  async railheadGrantCurrent(expiresAt: number): Promise<boolean> {
    return this.#fence.grantCurrent(expiresAt);
  }

  /** Retires the incarnation for good and destroys its container. */
  async railheadRetire(): Promise<void> {
    await this.#fence.retire();
  }

  /** Runs when the fence asked to be woken: at the deadline, or to retry a teardown. */
  async railheadExpire(): Promise<void> {
    await this.#fence.expire();
  }

  /**
   * Runs the SDK's alarm, which calls `railheadExpire` when it is due. Afterwards, once the fence is
   * `disposable`, deletes all the object's storage, so a sandbox leaves no object behind. The
   * deletion follows the SDK's alarm rather than running inside it, which still writes its schedule
   * table after each callback. `deleteAll` removes the alarm with the data in one step on SQLite
   * storage, so no partial state is left for a later alarm to finish. A deletion that fails leaves
   * the record in place and schedules another alarm, backing off like a teardown, up to
   * `MAX_TEARDOWN_ATTEMPTS` in a row; after that it tries again every `DISPOSAL_SWEEP_MS`, starting
   * a new round each time, so a lasting storage fault delays the deletion but never ends it. An
   * object revived after its deletion, such as by a late
   * release or start, records its retirement again and is deleted again past that deadline.
   */
  override async alarm(alarmProps?: AlarmInvocationInfo): Promise<void> {
    await super.alarm(alarmProps);
    if (!this.#fence.disposable()) return;
    try {
      await this.ctx.storage.deleteAll();
    } catch (error) {
      const failures = disposalFailures(this.ctx.storage.kv.get(DISPOSAL_FAILURES)) + 1;
      if (failures < MAX_TEARDOWN_ATTEMPTS) {
        this.ctx.storage.kv.put(DISPOSAL_FAILURES, failures);
        await this.ctx.storage.setAlarm(Date.now() + teardownRetryDelay(failures));
      } else {
        // The quick retries are spent: start a new round after a long pause rather than stop.
        this.ctx.storage.kv.delete(DISPOSAL_FAILURES);
        await this.ctx.storage.setAlarm(Date.now() + DISPOSAL_SWEEP_MS);
      }
      console.error(
        JSON.stringify({
          event: "sandbox.dispose_failed",
          failures,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  }

  // The SDK calls a CI run issues on this object, each run through `fenceSandbox`.
  readonly #sdk = fenceSandbox(this.#fence, {
    restoreBackup: (backup) => super.restoreBackup(backup),
    createBackup: (options) => super.createBackup(options),
    execWithSessionToken: (command, sessionId, options) =>
      super.execWithSessionToken(command, sessionId, options),
    listFiles: (path, options) => super.listFiles(path, options),
    startProcess: (command, options, sessionId) => super.startProcess(command, options, sessionId),
    containerFetch: (requestOrUrl, portOrInit, portParam) =>
      super.containerFetch(requestOrUrl, portOrInit, portParam),
  });

  override restoreBackup(backup: DirectoryBackup): Promise<RestoreBackupResult> {
    return this.#sdk.restoreBackup(backup);
  }

  override createBackup(options: BackupOptions): Promise<DirectoryBackup> {
    return this.#sdk.createBackup(options);
  }

  override execWithSessionToken(
    command: string,
    sessionId: string,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    return this.#sdk.execWithSessionToken(command, sessionId, options);
  }

  override listFiles(path: string, options?: ListFilesOptions): ReturnType<Sandbox["listFiles"]> {
    return this.#sdk.listFiles(path, options);
  }

  override startProcess(
    command: string,
    options?: ProcessOptions,
    sessionId?: string,
  ): Promise<Process> {
    return this.#sdk.startProcess(command, options, sessionId);
  }

  override containerFetch(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number,
  ): Promise<Response> {
    return this.#sdk.containerFetch(requestOrUrl, portOrInit, portParam);
  }
}

/**
 * The Sandbox SDK methods through which the patched CI runner reaches a sandbox's container, either
 * by calling them or, for `containerFetch`, through the SDK's HTTP transport and the WebSocket
 * upgrade of its RPC transport. `RailheadSandbox` overrides each one to run through `fenceSandbox`.
 */
export const FENCED_SANDBOX_METHODS = [
  "restoreBackup",
  "createBackup",
  "execWithSessionToken",
  "listFiles",
  "startProcess",
  "containerFetch",
] as const satisfies readonly (keyof Sandbox)[];

/** The SDK calls `fenceSandbox` wraps. */
export type FencedSandboxCalls = Pick<Sandbox, (typeof FENCED_SANDBOX_METHODS)[number]>;

/**
 * Wraps `base`'s SDK calls so each runs inside `fence`'s live incarnation: retirement waits for it,
 * and none starts, or reports, after it. A started process's own calls, such as its exit wait, run
 * the same way. `containerFetch`, which starts the container and opens every connection to it, is
 * refused outside the live incarnation; calls on a connection already open are refused by
 * `admitSandboxClient`.
 */
export function fenceSandbox(
  fence: Pick<SandboxFence, "operate" | "admit">,
  base: FencedSandboxCalls,
): FencedSandboxCalls {
  const fenceProcess = (process: Process): Process => ({
    ...process,
    kill: (signal) => fence.operate(() => process.kill(signal)),
    getStatus: () => fence.operate(() => process.getStatus()),
    getLogs: () => fence.operate(() => process.getLogs()),
    waitForLog: (pattern, timeout) => fence.operate(() => process.waitForLog(pattern, timeout)),
    waitForPort: (port, options) => fence.operate(() => process.waitForPort(port, options)),
    waitForExit: (timeout) => fence.operate(() => process.waitForExit(timeout)),
  });
  return {
    restoreBackup: (backup) => fence.operate(() => base.restoreBackup(backup)),
    createBackup: (options) => fence.operate(() => base.createBackup(options)),
    execWithSessionToken: (command, sessionId, options) =>
      fence.operate(() => base.execWithSessionToken(command, sessionId, options)),
    listFiles: (path, options) => fence.operate(() => base.listFiles(path, options)),
    startProcess: async (command, options, sessionId) =>
      fenceProcess(await fence.operate(() => base.startProcess(command, options, sessionId))),
    containerFetch: async (requestOrUrl, portOrInit, portParam) => {
      fence.admit();
      return base.containerFetch(requestOrUrl, portOrInit, portParam);
    },
  };
}

/**
 * Members of the SDK's transport client that only manage its connection inside this object and
 * never reach the container. `admitSandboxClient` lets these through after retirement, so a destroy
 * can still close the connection.
 */
export const LOCAL_CLIENT_MEMBERS: ReadonlySet<PropertyKey> = new Set([
  "disconnect",
  "setRetryTimeoutMs",
  "getTransportMode",
  "isWebSocketConnected",
]);

/**
 * Makes every read of `sandbox.client`, the SDK's transport client, pass `admit` first, for each
 * client the SDK installs, including after a transport change. Each SDK call reads a member of that
 * client, such as `client.utils`, just before it sends: over the RPC transport a call on an open
 * WebSocket never passes through `containerFetch`, so a call that resumes after retirement, such
 * as a restore whose archive read outlived the deadline, is refused here before it can reach a
 * container whose destroy failed or has not yet finished. Only `LOCAL_CLIENT_MEMBERS` pass
 * without admission.
 */
export function admitSandboxClient<C extends object>(
  sandbox: { client: C },
  admit: () => void,
): void {
  let client = admitClient(sandbox.client, admit);
  Object.defineProperty(sandbox, "client", {
    get: () => client,
    set: (next: C) => {
      client = admitClient(next, admit);
    },
    configurable: true,
    enumerable: true,
  });
}

function admitClient<C extends object>(client: C, admit: () => void): C {
  return new Proxy(client, {
    get(target, member) {
      if (!LOCAL_CLIENT_MEMBERS.has(member)) {
        admit();
        // Not bound: an RPC stub is callable, and reading its `bind` would be a remote call.
        return Reflect.get(target, member, target);
      }
      const value: unknown = Reflect.get(target, member, target);
      // Bound to the client itself, so a disconnect after retirement is not refused partway.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Until a policy selects the gateway, every request is refused.
RailheadSandbox.outbound = () =>
  new Response("railhead sandbox gateway refused this request: policy\n", { status: 403 });

RailheadSandbox.outboundHandlers = {
  [GIT_GATEWAY]: (request: Request, env: Env, ctx: { containerId: string; params?: unknown }) =>
    serveGitGateway(request, parseSandboxGrant(ctx.params), {
      // The object whose container sent the request: its fence says whether the grant still holds.
      current: (expiresAt) =>
        env.SANDBOX.get(env.SANDBOX.idFromString(ctx.containerId)).railheadGrantCurrent(expiresAt),
      mint: async (repo, scope) => {
        using handle = await env.ARTIFACTS.get(repo);
        const token = await handle.createToken(scope, TOKEN_TTL_SECONDS);
        return token.plaintext;
      },
      fetch: (forwarded) => fetch(forwarded),
      now: Date.now,
    }),
};

/** The stored count of failed storage deletions, `0` when none is stored. */
function disposalFailures(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * When to schedule a wake-up meant for `at`. The SDK stores a scheduled time in whole seconds,
 * rounding down, so `at` is rounded up to the next second to keep the wake-up from running early.
 */
export function wakeTime(at: number): Date {
  return new Date(Math.ceil(at / 1_000) * 1_000);
}

/**
 * Opens the named sandbox. The SDK refuses a name it cannot use, such as one over 63 characters,
 * before any request is sent.
 */
export function openSandbox(env: Env, name: string): RailheadSandbox {
  // The sandbox module destroys every sandbox itself, and each one retires at its deadline. The
  // idle stop is only a backstop, past the longest lifetime, for a sandbox whose teardown never ran.
  return getSandbox(env.SANDBOX, name, { sleepAfter: IDLE_BACKSTOP, enableDefaultSession: false });
}

/** The driver over the Sandbox SDK, with each sandbox a `RailheadSandbox` named by its slot. */
export function sdkDriver(env: Env): SandboxDriver {
  return {
    async start(name, policy, deadline) {
      await openSandbox(env, name).railheadStart(policy, deadline);
    },
    async exec(name, command) {
      return openSandbox(env, name).railheadExec(command);
    },
    async destroy(name) {
      await openSandbox(env, name).railheadRetire();
    },
  };
}
