// The container Durable Object every sandbox runs in, and the driver the sandbox module uses to
// start, command and destroy it.
//
// The container starts with the internet off and HTTPS intercepted. Every HTTP and HTTPS request it
// makes goes to an outbound handler running in this Worker, outside the container: before a policy
// is set that handler refuses everything, and afterwards it is the Git gateway for that policy until
// the sandbox's deadline. No token is ever placed in the container; the gateway adds one to each
// request it forwards. Each object serves one incarnation behind a `SandboxFence` (see `fence.ts`).
//
// `ContainerProxy` is the SDK's entrypoint that carries those requests to the handler; the Worker
// exports it beside this class.

import { ContainerProxy, Sandbox, getSandbox } from "@cloudflare/sandbox";
import type { SandboxCommand, SandboxDriver } from "./entry";
import { SandboxFence } from "./fence";
import { serveGitGateway } from "./gateway";
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
      exec: (command, options) =>
        this.execWithSessionToken(command, SESSIONLESS, {
          timeout: options.timeoutMs,
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        }),
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
  async railheadExec(
    command: SandboxCommand,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.#fence.exec(command);
  }

  /** Retires the incarnation for good and destroys its container. */
  async railheadRetire(): Promise<void> {
    await this.#fence.retire();
  }

  /** Runs when the fence asked to be woken: at the deadline, or to retry a teardown. */
  async railheadExpire(): Promise<void> {
    await this.#fence.expire();
  }
}

// Until a policy selects the gateway, every request is refused.
RailheadSandbox.outbound = () =>
  new Response("railhead sandbox gateway refused this request: policy\n", { status: 403 });

RailheadSandbox.outboundHandlers = {
  [GIT_GATEWAY]: (request: Request, env: Env, ctx: { params?: unknown }) =>
    serveGitGateway(request, parseSandboxGrant(ctx.params), {
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
