// The container Durable Object every sandbox runs in, and the driver the sandbox module uses to
// start, command and destroy it.
//
// The container starts with the internet off and HTTPS intercepted. Every HTTP and HTTPS request it
// makes goes to an outbound handler running in this Worker, outside the container: before a policy
// is set that handler refuses everything, and afterwards it is the Git gateway for that policy. No
// token is ever placed in the container; the gateway adds one to each request it forwards.
//
// `ContainerProxy` is the SDK's entrypoint that carries those requests to the handler; the Worker
// exports it beside this class.

import { ContainerProxy, Sandbox, getSandbox } from "@cloudflare/sandbox";
import type { SandboxDriver } from "./entry";
import { serveGitGateway } from "./gateway";
import { parseSandboxPolicy, type SandboxPolicy } from "./policy";

export { ContainerProxy };

/** The lifetime of each minted Artifacts token, in seconds: the minimum Artifacts accepts. */
const TOKEN_TTL_SECONDS = 60;

/** The SDK's idle stop: longer than `MAX_SANDBOX_LIFETIME_MS`, so it never ends a live attempt. */
const IDLE_BACKSTOP = "45m";

/** The outbound handler a sandbox's policy selects. */
const GIT_GATEWAY = "gitGateway";

/** One sandbox's container. Only the sandbox module creates and destroys these. */
export class RailheadSandbox extends Sandbox<Env> {
  override enableInternet = false;
  override interceptHttps = true;
}

// Until a policy selects the gateway, every request is refused.
RailheadSandbox.outbound = () =>
  new Response("railhead sandbox gateway refused this request: policy\n", { status: 403 });

RailheadSandbox.outboundHandlers = {
  [GIT_GATEWAY]: (request: Request, env: Env, ctx: { params?: unknown }) =>
    serveGitGateway(request, parseSandboxPolicy(ctx.params), {
      mint: async (repo, scope) => {
        using handle = await env.ARTIFACTS.get(repo);
        const token = await handle.createToken(scope, TOKEN_TTL_SECONDS);
        return token.plaintext;
      },
      fetch: (forwarded) => fetch(forwarded),
    }),
};

/** The driver over the Sandbox SDK, with each sandbox a `RailheadSandbox` named by its slot. */
export function sdkDriver(env: Env): SandboxDriver {
  const open = (name: string) =>
    // The sandbox module destroys every sandbox itself. The idle stop is only a backstop, past the
    // longest lifetime, for a sandbox whose teardown never ran.
    getSandbox(env.SANDBOX, name, { sleepAfter: IDLE_BACKSTOP, enableDefaultSession: false });
  return {
    async start(name: string, policy: SandboxPolicy) {
      const box = open(name);
      await box.setOutboundHandler(GIT_GATEWAY, policy);
      const probe = await box.exec("git --version");
      if (probe.exitCode !== 0) throw new Error("sandbox did not answer its first command");
    },
    async exec(name, command) {
      const result = await open(name).exec(command.command, {
        timeout: command.timeoutMs,
        ...(command.env === undefined ? {} : { env: command.env }),
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    async destroy(name) {
      await open(name).destroy();
    },
  };
}
