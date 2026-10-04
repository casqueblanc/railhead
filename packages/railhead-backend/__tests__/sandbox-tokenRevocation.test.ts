// The registered Git gateway revokes every token it mints once that request's exchange ends, so a
// merge composition's push leaves no write token on main for main's ref to refuse (#282). Driven
// through `RailheadSandbox.outboundHandlers` over `FakeMainRepo`, which models the token listing
// and liveness #158 measured, with the Artifacts Git host stubbed on the global `fetch`.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mainRepoName } from "../src/artifacts/adapter";
import { createMainRef, MAIN_REF_LIMITS } from "../src/artifacts/mainRef";
import { FakeMainRepo } from "../src/artifacts/mainRefFake";
import { CANDIDATE_REF_PREFIX, type SandboxPolicy } from "../src/sandbox/policy";
import { RailheadSandbox } from "../src/sandbox/sandboxObject";

const REPO = "rep_aaaaaaaaaaaa";
const HOST = "acct.artifacts.cloudflare.net";
const C0 = "0".repeat(39) + "a";
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const ZERO = "0".repeat(40);
const PREFIX = `${CANDIDATE_REF_PREFIX}mrg_attempt1/`;
const encoder = new TextEncoder();

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function alwaysCurrent(): Promise<boolean> {
  return true;
}

/** One pkt-line, written by hand so the test does not reuse the gateway's parser. */
function pkt(payload: string): string {
  return (encoder.encode(payload).length + 4).toString(16).padStart(4, "0") + payload;
}

/** An upstream answer whose body the test writes, ends or fails. */
interface Held {
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
}

/**
 * Main's fake repository behind the registered gateway, as a merge composition's sandbox reaches
 * it: it may fetch main and push under its candidate prefix.
 */
async function setup() {
  const fake = new FakeMainRepo(await mainRepoName(REPO), [C0, C1]);
  fake.commit(C2, [C1]);
  const policy: SandboxPolicy = {
    host: HOST,
    namespace: "railhead",
    read: [fake.name],
    write: { repo: fake.name, refPrefix: PREFIX },
  };
  const grant = { policy, expiresAt: Date.now() + 60_000 };
  const held: Held[] = [];
  // The Artifacts Git host: refuses a token that is not live, else answers with a held body.
  let upstream = async (request: Request): Promise<Response> => {
    await request.arrayBuffer();
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
    const token = fake.tokens.find((candidate) => candidate.plaintext === bearer);
    if (token === undefined || token.revoked) return new Response("forbidden", { status: 403 });
    let capture: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        capture = controller;
      },
    });
    if (capture === undefined) throw new Error("the stream did not start");
    held.push({ controller: capture });
    return new Response(body, { status: 200 });
  };
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    upstream(new Request(input, init)),
  );
  const handler = RailheadSandbox.outboundHandlers?.["gitGateway"];
  if (handler === undefined) throw new Error("no git gateway handler");
  let current = alwaysCurrent;
  // Revocations answer only once released, when `holdRevocations` is set.
  let revocations: Promise<void> | null = null;
  const bindings = {
    ARTIFACTS: {
      get: async (name: string) => {
        const handle = await fake.get(name);
        const pending = revocations;
        if (pending === null) return handle;
        return Object.assign(handle, {
          revokeToken: async (id: string) => {
            await pending;
            return false;
          },
        });
      },
    },
    SANDBOX: {
      idFromString: (id: string) => id,
      get: () => ({ railheadGrantCurrent: () => current() }),
    },
  };
  const ref = createMainRef(
    { repoId: REPO, namespace: fake, upstream: fake.upstream, clock: fake.clock },
    { ...MAIN_REF_LIMITS, requestTimeoutMs: 1_000, callTimeoutMs: 1_000 },
  );
  return {
    fake,
    holdRevocations() {
      revocations = new Promise<void>(() => undefined);
    },
    held,
    ref,
    setUpstream(next: (request: Request) => Promise<Response>) {
      upstream = next;
    },
    setCurrent(next: () => Promise<boolean>) {
      current = next;
    },
    async serve(request: Request): Promise<Response> {
      const context = { containerId: "c", className: "RailheadSandbox", params: grant };
      // The fake bindings implement only what the handler calls, not the whole Env.
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

function composePush(name: string): Request {
  const body = `${pkt(`${ZERO} ${C2} ${PREFIX}head\u0000report-status\n`)}0000PACK`;
  return new Request(`https://${HOST}/git/railhead/${name}.git/git-receive-pack`, {
    method: "POST",
    body,
  });
}

function fetchMain(name: string): Request {
  return new Request(`https://${HOST}/git/railhead/${name}.git/info/refs?service=git-upload-pack`);
}

/** The one upstream answer the test is holding. */
function only(held: readonly Held[]): Held {
  const [first, ...rest] = held;
  if (first === undefined || rest.length > 0) throw new Error(`${held.length} answers held`);
  return first;
}

/** The events logged, parsed. */
function logged(): unknown[] {
  return warn.mock.calls.map(([line]) => JSON.parse(String(line)));
}

describe("the registered Git gateway's tokens", () => {
  it("revokes a compose push's write token when its answer ends, so main's next update lands", async () => {
    const { fake, held, ref, serve } = await setup();

    const response = await serve(composePush(fake.name));
    // The answer is still open: the token stays live for the exchange.
    expect(fake.liveWriteTokens()).toHaveLength(1);
    only(held).controller.enqueue(encoder.encode("report"));
    only(held).controller.close();

    expect(await response.text()).toBe("report");
    expect(fake.tokens.map((token) => [token.scope, token.revoked])).toEqual([["write", true]]);
    expect(fake.liveWriteTokens()).toEqual([]);
    expect(await ref.update(C1, C2)).toEqual({ ok: true, value: { kind: "updated" } });
    expect(fake.main).toBe(C2);
    expect(logged()).toEqual([]);
  });

  it("refuses main's update during a compose push, then lands it on retry once the push ends", async () => {
    const { fake, held, ref, serve } = await setup();

    const response = await serve(composePush(fake.name));
    const during = await ref.update(C1, C2);
    only(held).controller.close();
    await response.arrayBuffer();
    const retry = await ref.update(C1, C2);

    expect(during).toMatchObject({ ok: false, code: "unavailable" });
    expect(logged()).toEqual([{ event: "main_ref_foreign_writer", tokens: 1, partial: false }]);
    expect(retry).toEqual({ ok: true, value: { kind: "updated" } });
    expect(fake.main).toBe(C2);
  });

  it("revokes the token when the upstream request fails", async () => {
    const { fake, serve, setUpstream } = await setup();
    setUpstream(async () => {
      throw new TypeError("network connection lost");
    });

    await expect(serve(composePush(fake.name))).rejects.toThrow("network connection lost");

    expect(fake.tokens.map((token) => [token.scope, token.revoked])).toEqual([["write", true]]);
  });

  it("revokes the token when the answer fails partway or the sandbox abandons it", async () => {
    const { fake, held, serve } = await setup();

    const failed = await serve(composePush(fake.name));
    const abandoned = await serve(composePush(fake.name));
    const [failing, cancelled] = held;
    if (failing === undefined || cancelled === undefined) throw new Error("nothing forwarded");
    failing.controller.enqueue(encoder.encode("partial"));
    const reading = failed.text();
    failing.controller.error(new Error("aborted at the deadline"));
    await expect(reading).rejects.toThrow("aborted at the deadline");
    await abandoned.body?.cancel();

    expect(fake.tokens.map((token) => [token.scope, token.revoked])).toEqual([
      ["write", true],
      ["write", true],
    ]);
  });

  it("revokes fetch tokens, so more fetches of main than one listing page leave it complete", async () => {
    const { fake, held, ref, serve } = await setup();

    for (let fetches = 0; fetches < 31; fetches += 1) {
      const response = await serve(fetchMain(fake.name));
      held.at(-1)?.controller.close();
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }

    expect(fake.tokens).toHaveLength(31);
    expect(fake.tokens.every((token) => token.scope === "read" && token.revoked)).toBe(true);
    expect(await ref.update(C1, C2)).toEqual({ ok: true, value: { kind: "updated" } });
  });

  it("revokes a token minted for a request refused before it was forwarded", async () => {
    const { fake, held, serve, setCurrent } = await setup();
    // Confirmed before minting, then retired before forwarding.
    let asked = 0;
    setCurrent(async () => (asked += 1) === 1);

    const response = await serve(composePush(fake.name));

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("retired");
    expect(held).toEqual([]);
    expect(fake.tokens.map((token) => [token.scope, token.revoked])).toEqual([["write", true]]);
  });

  it("mints nothing for a push to main, so there is nothing to revoke", async () => {
    const { fake, held, serve } = await setup();
    const body = `${pkt(`${C1} ${C2} refs/heads/main\u0000report-status\n`)}0000PACK`;
    const push = new Request(`https://${HOST}/git/railhead/${fake.name}.git/git-receive-pack`, {
      method: "POST",
      body,
    });

    const response = await serve(push);

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("ref");
    expect(held).toEqual([]);
    expect(fake.tokens).toEqual([]);
  });

  it("delivers the answer whole when revocation fails, and logs the token id but not its secret", async () => {
    const { fake, held, serve } = await setup();
    fake.failNext("revokeToken");

    const response = await serve(composePush(fake.name));
    only(held).controller.enqueue(encoder.encode("report"));
    only(held).controller.close();

    expect(await response.text()).toBe("report");
    const [token] = fake.tokens;
    if (token === undefined) throw new Error("nothing minted");
    expect(token.revoked).toBe(false);
    expect(logged()).toEqual([{ event: "sandbox.token_revoke_failed", id: token.id }]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token.plaintext);
    // Left to expire with its own one-minute lifetime.
    expect(token.expiresAtMs - token.createdAtMs).toBe(60_000);
  });

  it("ends the answer once a revocation that never answers has had its time", async () => {
    const { fake, held, serve, holdRevocations } = await setup();
    holdRevocations();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const response = await serve(composePush(fake.name));
    only(held).controller.enqueue(encoder.encode("report"));
    only(held).controller.close();
    const reading = response.text();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await reading).toBe("report");
    expect(logged()).toEqual([{ event: "sandbox.token_revoke_failed", id: "tok_1" }]);
    expect(fake.liveWriteTokens().map((token) => token.id)).toEqual(["tok_1"]);
  });
});
