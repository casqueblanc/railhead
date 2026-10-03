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
import { SandboxFence } from "./fence";
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

/** The outbound handler a sandbox's policy selects. */
const GIT_GATEWAY = "gitGateway";

/** One sandbox's container. Only the sandbox module creates and destroys these. */
export class RailheadSandbox extends Sandbox<Env> {
  override enableInternet = false;
  override interceptHttps = true;

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

  // The SDK operations a CI run issues on this object run inside the fence's live incarnation, so
  // its retirement waits for them and none starts, or reports, after it.

  override restoreBackup(backup: DirectoryBackup): Promise<RestoreBackupResult> {
    return this.#fence.operate(() => super.restoreBackup(backup));
  }

  override createBackup(options: BackupOptions): Promise<DirectoryBackup> {
    return this.#fence.operate(() => super.createBackup(options));
  }

  override execWithSessionToken(
    command: string,
    sessionId: string,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    return this.#fence.operate(() => super.execWithSessionToken(command, sessionId, options));
  }

  override listFiles(path: string, options?: ListFilesOptions): ReturnType<Sandbox["listFiles"]> {
    return this.#fence.operate(() => super.listFiles(path, options));
  }

  override async startProcess(
    command: string,
    options?: ProcessOptions,
    sessionId?: string,
  ): Promise<Process> {
    const started = await this.#fence.operate(() =>
      super.startProcess(command, options, sessionId),
    );
    return {
      ...started,
      waitForExit: (timeout) => this.#fence.operate(() => started.waitForExit(timeout)),
    };
  }

  // Every SDK call that reaches or starts the container passes here: one that resumes after
  // retirement, such as a restore whose archive read outlived the deadline, is refused before it
  // can restart the container the fence destroyed.
  override async containerFetch(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number,
  ): Promise<Response> {
    this.#fence.admit();
    return super.containerFetch(requestOrUrl, portOrInit, portParam);
  }
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
