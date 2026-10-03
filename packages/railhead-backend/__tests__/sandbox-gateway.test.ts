import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { serveGitGateway, type GatewayDeps } from "../src/sandbox/gateway";
import {
  CANDIDATE_REF_PREFIX,
  parseSandboxGrant,
  parseSandboxPolicy,
  type SandboxGrant,
  type SandboxPolicy,
} from "../src/sandbox/policy";
import { RailheadSandbox } from "../src/sandbox/sandboxObject";

const encoder = new TextEncoder();
const HOST = "acct.artifacts.cloudflare.net";
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const ZERO = "0".repeat(40);
const PACK = "PACK\u0000\u0000\u0000\u0002opaque pack bytes";

const POLICY: SandboxPolicy = {
  host: HOST,
  namespace: "railhead",
  read: ["main-repo", "fork-a"],
  write: { repo: "main-repo", refPrefix: `${CANDIDATE_REF_PREFIX}chk_attempt1/` },
};

function noop(): void {}

/** One pkt-line, written by hand so the tests do not reuse the subject's parser. */
function pkt(payload: string): string {
  return (encoder.encode(payload).length + 4).toString(16).padStart(4, "0") + payload;
}

function push(...commands: string[]): string {
  const [first = "", ...rest] = commands;
  return (
    pkt(`${first}\u0000report-status side-band-64k\n`) +
    rest.map((line) => pkt(`${line}\n`)).join("") +
    "0000" +
    PACK
  );
}

/** A grant for `policy` that outlives every test. */
function live(policy: SandboxPolicy): SandboxGrant {
  return { policy, expiresAt: Date.now() + 3_600_000 };
}

function url(repo: string, op: string, host = HOST): string {
  return `https://${host}/git/railhead/${repo}.git/${op}`;
}

function fetchRefs(repo = "main-repo"): Request {
  return new Request(`${url(repo, "info/refs")}?service=git-upload-pack`);
}

/** Gateway dependencies that record what was minted and forwarded. */
function recorder(): GatewayDeps & {
  minted: [string, string][];
  forwarded: { url: string; auth: string | null; body: string }[];
  redirects: string[];
} {
  const minted: [string, string][] = [];
  const forwarded: { url: string; auth: string | null; body: string }[] = [];
  const redirects: string[] = [];
  return {
    minted,
    forwarded,
    redirects,
    mint: async (repo, scope) => {
      minted.push([repo, scope]);
      return `tok-${scope}-${repo}`;
    },
    now: Date.now,
    fetch: async (request) => {
      redirects.push(request.redirect);
      forwarded.push({
        url: request.url,
        auth: request.headers.get("Authorization"),
        body: await request.text(),
      });
      return new Response("upstream", { status: 200 });
    },
  };
}

async function refusal(response: Response): Promise<string> {
  expect(response.status).toBe(403);
  return (await response.text()).trim().split(": ").at(-1) ?? "";
}

describe("serveGitGateway", () => {
  it("forwards a fetch from a readable repository with a read token the sandbox never sent", async () => {
    const deps = recorder();
    const request = new Request(`${url("fork-a", "info/refs")}?service=git-upload-pack`, {
      headers: { Authorization: "Bearer sandbox-supplied" },
    });

    const response = await serveGitGateway(request, live(POLICY), deps);

    expect(response.status).toBe(200);
    expect(deps.minted).toEqual([["fork-a", "read"]]);
    expect(deps.forwarded).toEqual([
      {
        url: `${url("fork-a", "info/refs")}?service=git-upload-pack`,
        auth: "Bearer tok-read-fork-a",
        body: "",
      },
    ]);
    // A redirect is returned to the sandbox instead of carrying the token to another URL.
    expect(deps.redirects).toEqual(["manual"]);
  });

  it("forwards a candidate push with its pack bytes intact", async () => {
    const deps = recorder();
    const body = push(`${ZERO} ${NEW} ${CANDIDATE_REF_PREFIX}chk_attempt1/head`);
    const request = new Request(url("main-repo", "git-receive-pack"), { method: "POST", body });

    const response = await serveGitGateway(request, live(POLICY), deps);

    expect(response.status).toBe(200);
    expect(deps.minted).toEqual([["main-repo", "write"]]);
    expect(deps.forwarded[0]?.body).toBe(body);
    expect(deps.forwarded[0]?.auth).toBe("Bearer tok-write-main-repo");
  });

  it("forwards a push whose head arrives split across many chunks", async () => {
    const deps = recorder();
    const body = encoder.encode(push(`${OLD} ${NEW} ${CANDIDATE_REF_PREFIX}chk_attempt1/head`));
    let at = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= body.length) return controller.close();
        controller.enqueue(body.slice(at, at + 7));
        at += 7;
      },
    });
    const request = new Request(url("main-repo", "git-receive-pack"), {
      method: "POST",
      body: stream,
    });

    const response = await serveGitGateway(request, live(POLICY), deps);

    expect(response.status).toBe(200);
    expect(encoder.encode(deps.forwarded[0]?.body)).toEqual(body);
  });

  it.each([
    ["main", `${OLD} ${NEW} refs/heads/main`],
    ["another attempt's candidate", `${OLD} ${NEW} ${CANDIDATE_REF_PREFIX}chk_other01/head`],
    ["the bare prefix", `${OLD} ${NEW} ${CANDIDATE_REF_PREFIX}chk_attempt1/`],
    ["a dot-dot escape", `${OLD} ${NEW} ${CANDIDATE_REF_PREFIX}chk_attempt1/../../main`],
    ["a candidate deletion", `${OLD} ${ZERO} ${CANDIDATE_REF_PREFIX}chk_attempt1/head`],
    ["a tag", `${ZERO} ${NEW} refs/tags/v1`],
  ])("refuses a push to %s and forwards nothing", async (_name, command) => {
    const deps = recorder();
    const request = new Request(url("main-repo", "git-receive-pack"), {
      method: "POST",
      body: push(command),
    });

    expect(await refusal(await serveGitGateway(request, live(POLICY), deps))).toBe("ref");
    expect(deps.minted).toEqual([]);
    expect(deps.forwarded).toEqual([]);
  });

  it("refuses a push that mixes a candidate ref with main", async () => {
    const deps = recorder();
    const request = new Request(url("main-repo", "git-receive-pack"), {
      method: "POST",
      body: push(
        `${ZERO} ${NEW} ${CANDIDATE_REF_PREFIX}chk_attempt1/head`,
        `${OLD} ${NEW} refs/heads/main`,
      ),
    });

    expect(await refusal(await serveGitGateway(request, live(POLICY), deps))).toBe("ref");
    expect(deps.forwarded).toEqual([]);
  });

  it.each([
    ["a truncated head", pkt(`${ZERO} ${NEW} ${CANDIDATE_REF_PREFIX}chk_attempt1/x\u0000caps\n`)],
    ["a malformed length", "zzzz"],
    ["an empty command list", "0000"],
    [
      "push options",
      pkt(`${ZERO} ${NEW} ${CANDIDATE_REF_PREFIX}chk_attempt1/x\u0000push-options\n`) +
        "0000" +
        pkt("ci.skip\n") +
        "0000",
    ],
  ])("refuses %s as an unreadable push", async (_name, body) => {
    const deps = recorder();
    const request = new Request(url("main-repo", "git-receive-pack"), { method: "POST", body });

    expect(await refusal(await serveGitGateway(request, live(POLICY), deps))).toBe("push");
    expect(deps.forwarded).toEqual([]);
  });

  it.each([
    ["another host", `https://github.com/git/git.git/info/refs?service=git-upload-pack`, "host"],
    [
      "a lookalike host",
      `${url("fork-a", "info/refs", `${HOST}.evil.test`)}?service=git-upload-pack`,
      "host",
    ],
    [
      "another port",
      `https://${HOST}:8443/git/railhead/fork-a.git/info/refs?service=git-upload-pack`,
      "host",
    ],
    [
      "plain HTTP",
      `http://${HOST}/git/railhead/fork-a.git/info/refs?service=git-upload-pack`,
      "scheme",
    ],
    [
      "another namespace",
      `https://${HOST}/git/other/fork-a.git/info/refs?service=git-upload-pack`,
      "namespace",
    ],
    [
      "a repository outside the policy",
      `${url("fork-b", "info/refs")}?service=git-upload-pack`,
      "repository",
    ],
    ["a non-Git path", `https://${HOST}/v1/repos/fork-a`, "path"],
    ["an unknown service", `${url("fork-a", "info/refs")}?service=git-upload-archive`, "service"],
    [
      "a push discovery on a read-only repository",
      `${url("fork-a", "info/refs")}?service=git-receive-pack`,
      "read-only",
    ],
  ])("refuses %s without minting a token", async (_name, target, reason) => {
    const deps = recorder();

    expect(await refusal(await serveGitGateway(new Request(target), live(POLICY), deps))).toBe(
      reason,
    );
    expect(deps.minted).toEqual([]);
    expect(deps.forwarded).toEqual([]);
  });

  it("refuses a push to a read-only repository and a POST discovery", async () => {
    const deps = recorder();
    const readOnly = new Request(url("fork-a", "git-receive-pack"), {
      method: "POST",
      body: push(`${ZERO} ${NEW} ${CANDIDATE_REF_PREFIX}chk_attempt1/head`),
    });
    const wrongMethod = new Request(`${url("fork-a", "info/refs")}?service=git-upload-pack`, {
      method: "POST",
    });

    expect(await refusal(await serveGitGateway(readOnly, live(POLICY), deps))).toBe("read-only");
    expect(await refusal(await serveGitGateway(wrongMethod, live(POLICY), deps))).toBe("method");
    expect(deps.minted).toEqual([]);
  });

  it("refuses every push under a read-only policy and everything without a policy", async () => {
    const deps = recorder();
    const readOnly = { ...POLICY, write: null };
    const pushRequest = () =>
      new Request(url("main-repo", "git-receive-pack"), {
        method: "POST",
        body: push(`${ZERO} ${NEW} ${CANDIDATE_REF_PREFIX}chk_attempt1/head`),
      });
    const fetchRequest = new Request(`${url("main-repo", "info/refs")}?service=git-upload-pack`);

    expect(await refusal(await serveGitGateway(pushRequest(), live(readOnly), deps))).toBe(
      "read-only",
    );
    expect(await refusal(await serveGitGateway(fetchRequest, null, deps))).toBe("policy");
    expect(deps.forwarded).toEqual([]);
  });
});

describe("parseSandboxPolicy", () => {
  it("accepts a policy and a read-only one", () => {
    expect(parseSandboxPolicy(POLICY)).toEqual(POLICY);
    expect(parseSandboxPolicy({ ...POLICY, write: null })).toEqual({ ...POLICY, write: null });
  });

  it.each([
    ["main", "refs/heads/main"],
    ["the candidate root", CANDIDATE_REF_PREFIX],
    ["a prefix without a trailing slash", `${CANDIDATE_REF_PREFIX}chk_attempt1`],
    ["two segments", `${CANDIDATE_REF_PREFIX}a/b/`],
    ["a dot-dot segment", `${CANDIDATE_REF_PREFIX}../`],
    ["another branch namespace", "refs/heads/feature/"],
  ])("refuses a write prefix of %s", (_name, refPrefix) => {
    expect(parseSandboxPolicy({ ...POLICY, write: { repo: "main-repo", refPrefix } })).toBeNull();
  });

  it.each([
    ["no object", null],
    ["a host with a path", { ...POLICY, host: "acct.example/x" }],
    ["a single-label host", { ...POLICY, host: "localhost" }],
    ["a repository with a slash", { ...POLICY, read: ["a/b"] }],
    ["a duplicate repository", { ...POLICY, read: ["fork-a", "fork-a"] }],
    ["too many repositories", { ...POLICY, read: Array.from({ length: 17 }, (_, i) => `r${i}`) }],
    ["a missing write field", { host: HOST, namespace: "railhead", read: [] }],
  ])("refuses %s", (_name, value) => {
    expect(parseSandboxPolicy(value)).toBeNull();
  });

  it("accepts the largest repository list", () => {
    const read = Array.from({ length: 16 }, (_, i) => `r${i}`);
    expect(parseSandboxPolicy({ ...POLICY, read })?.read).toEqual(read);
  });
});

describe("RailheadSandbox outbound handlers", () => {
  const context = { containerId: "c", className: "RailheadSandbox" };

  it("refuses every request before a policy is set", async () => {
    const handler = RailheadSandbox.outbound;
    if (handler === undefined) throw new Error("no default outbound handler");

    const response = await handler(new Request("https://example.com/"), env, context);

    expect(await refusal(response)).toBe("policy");
  });

  const grant = { policy: POLICY, expiresAt: Date.now() + 60_000 };

  it("refuses another host, an invalid policy and a main push before reaching Artifacts", async () => {
    const gateway = RailheadSandbox.outboundHandlers?.["gitGateway"];
    if (gateway === undefined) throw new Error("no git gateway handler");
    const mainPush = new Request(url("main-repo", "git-receive-pack"), {
      method: "POST",
      body: push(`${OLD} ${NEW} refs/heads/main`),
    });

    // `remoteBindings: false` leaves ARTIFACTS unusable here, so a forwarded request would throw.
    expect(
      await refusal(
        await gateway(new Request("https://example.com/"), env, { ...context, params: grant }),
      ),
    ).toBe("host");
    expect(
      await refusal(
        await gateway(new Request("https://example.com/"), env, {
          ...context,
          params: { ...grant, policy: { host: 1 } },
        }),
      ),
    ).toBe("policy");
    expect(await refusal(await gateway(mainPush, env, { ...context, params: grant }))).toBe("ref");
  });

  it("refuses everything once the grant has lapsed, even a request the policy allows", async () => {
    const gateway = RailheadSandbox.outboundHandlers?.["gitGateway"];
    if (gateway === undefined) throw new Error("no git gateway handler");
    // A live grant is applied: a repository outside it is refused for that reason, not the grant.
    expect(
      await refusal(await gateway(fetchRefs("elsewhere"), env, { ...context, params: grant })),
    ).toBe("repository");
    for (const expiresAt of [Date.now() - 1, Date.now() - 60_000]) {
      const lapsed = { policy: POLICY, expiresAt };
      expect(await refusal(await gateway(fetchRefs(), env, { ...context, params: lapsed }))).toBe(
        "policy",
      );
    }
    // A bare policy, without a deadline, grants nothing.
    expect(await refusal(await gateway(fetchRefs(), env, { ...context, params: POLICY }))).toBe(
      "policy",
    );
  });
});

describe("serveGitGateway at the grant's deadline", () => {
  const EXPIRES = 5_000_000;

  /** Recording dependencies whose clock the test sets. */
  function clocked(): ReturnType<typeof recorder> & { at: (ms: number) => void } {
    let now = EXPIRES - 1_000;
    return { ...recorder(), now: () => now, at: (ms) => (now = ms) };
  }

  it("forwards a request that arrives just before the deadline", async () => {
    const deps = clocked();
    deps.at(EXPIRES - 1);

    const response = await serveGitGateway(
      fetchRefs(),
      { policy: POLICY, expiresAt: EXPIRES },
      deps,
    );

    expect(response.status).toBe(200);
    expect(deps.forwarded).toHaveLength(1);
  });

  it("forwards nothing when the token mint finishes after the deadline", async () => {
    const deps = clocked();
    const mint = deps.mint;
    deps.mint = async (repo, scope) => {
      const token = await mint(repo, scope);
      deps.at(EXPIRES);
      return token;
    };

    const response = await serveGitGateway(
      fetchRefs(),
      { policy: POLICY, expiresAt: EXPIRES },
      deps,
    );

    expect(await refusal(response)).toBe("policy");
    expect(deps.minted).toEqual([["main-repo", "read"]]);
    expect(deps.forwarded).toEqual([]);
  });

  it("mints and forwards nothing when a push's commands finish arriving after the deadline", async () => {
    const deps = clocked();
    const bytes = encoder.encode(push(`${ZERO} ${NEW} ${CANDIDATE_REF_PREFIX}chk_attempt1/head`));
    let send = noop;
    const sent = new Promise<void>((done) => (send = done));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await sent;
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const request = new Request(url("main-repo", "git-receive-pack"), { method: "POST", body });

    const pending = serveGitGateway(request, { policy: POLICY, expiresAt: EXPIRES }, deps);
    // The sandbox sends its commands only once the deadline has passed.
    deps.at(EXPIRES);
    send();
    const response = await pending;

    expect(await refusal(response)).toBe("policy");
    expect(deps.minted).toEqual([]);
    expect(deps.forwarded).toEqual([]);
  });

  it("stops waiting on a push whose commands never arrive once the deadline passes", async () => {
    const deps = recorder();
    // The sandbox opens a push and never sends its commands.
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(noop) });
    const request = new Request(url("main-repo", "git-receive-pack"), { method: "POST", body });

    const response = await serveGitGateway(
      request,
      { policy: POLICY, expiresAt: Date.now() + 50 },
      deps,
    );

    expect(await refusal(response)).toBe("policy");
    expect(deps.minted).toEqual([]);
    expect(deps.forwarded).toEqual([]);
  });

  it("aborts the upstream request at the deadline", async () => {
    const signals: AbortSignal[] = [];
    const deps: GatewayDeps = {
      ...recorder(),
      fetch: async (forwarded) => {
        signals.push(forwarded.signal);
        return new Response("upstream");
      },
    };

    await serveGitGateway(fetchRefs(), { policy: POLICY, expiresAt: Date.now() + 50 }, deps);
    const [signal] = signals;
    if (signal === undefined) throw new Error("nothing was forwarded");
    expect(signal.aborted).toBe(false);
    await new Promise<void>((done) => signal.addEventListener("abort", () => done()));

    expect(signal.aborted).toBe(true);
  });
});

describe("parseSandboxGrant", () => {
  it("returns a grant whatever its deadline, which the gateway checks at each use", () => {
    expect(parseSandboxGrant({ policy: POLICY, expiresAt: 5_000 })).toEqual({
      policy: POLICY,
      expiresAt: 5_000,
    });
  });

  it.each([
    ["no deadline", { policy: POLICY }],
    ["a fractional deadline", { policy: POLICY, expiresAt: 5_000.5 }],
    ["a string deadline", { policy: POLICY, expiresAt: "9999999999999" }],
    ["an invalid policy", { policy: { ...POLICY, host: "" }, expiresAt: 5_000 }],
    ["null", null],
  ])("refuses a grant with %s", (_name, value) => {
    expect(parseSandboxGrant(value)).toBeNull();
  });
});
