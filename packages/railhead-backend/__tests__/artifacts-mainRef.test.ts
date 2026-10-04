import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mainRepoName } from "../src/artifacts/adapter";
import { createMainRef, MAIN_REF_LIMITS, type MainRefLimits } from "../src/artifacts/mainRef";
import { FakeMainRepo } from "../src/artifacts/mainRefFake";
import type { MainRefPort } from "../src/contracts/train";

const REPO = "rep_aaaaaaaaaaaa";
const C0 = "0".repeat(39) + "a";
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
const SIDE = "5".repeat(40);
const MISSING = "6".repeat(40);

const FAST: MainRefLimits = { ...MAIN_REF_LIMITS, requestTimeoutMs: 100, callTimeoutMs: 100 };

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

/** A fake main at C1 on the history C0, C1, with C2 and C3 above it and an unrelated SIDE. */
async function setup(
  limits: MainRefLimits = FAST,
): Promise<{ fake: FakeMainRepo; ref: MainRefPort }> {
  const fake = new FakeMainRepo(await mainRepoName(REPO), [C0, C1]);
  fake.commit(C2, [C1]);
  fake.commit(C3, [C2]);
  fake.commit(SIDE, []);
  const ref = createMainRef(
    { repoId: REPO, namespace: fake, upstream: fake.upstream, clock: fake.clock },
    limits,
  );
  return { fake, ref };
}

/** The events the ref reported, by name. */
function reported(): string[] {
  return warn.mock.calls.map(([line]) => {
    const parsed: unknown = JSON.parse(String(line));
    return typeof parsed === "object" && parsed !== null && "event" in parsed
      ? String(parsed.event)
      : "";
  });
}

/** Every token the ref minted, which is every write token the test did not mint itself. */
function expectNoLiveTokenOfTheRef(fake: FakeMainRepo, foreign: readonly string[] = []): void {
  expect(fake.liveWriteTokens().map((token) => token.id)).toEqual(foreign);
  expect(fake.openHandles).toBe(0);
}

describe("main ref update", () => {
  it("moves main with one buffered receive-pack request and revokes its one-minute token", async () => {
    const { fake, ref } = await setup();

    expect(await ref.update(C1, C3)).toEqual({ ok: true, value: { kind: "updated" } });

    expect(fake.main).toBe(C3);
    expect(await ref.read()).toEqual({ ok: true, value: C3 });
    const [body] = fake.bodies;
    expect(fake.bodies).toHaveLength(1);
    expect(new TextDecoder().decode(body?.subarray(0, 116))).toBe(
      `0074${C1} ${C3} refs/heads/main\0report-status\n`,
    );
    const [token] = fake.tokens;
    expect(token?.scope).toBe("write");
    expect(token !== undefined && token.expiresAtMs - token.createdAtMs).toBe(60_000);
    expect(token?.revoked).toBe(true);
    expect(fake.steps.indexOf("revokeToken")).toBeGreaterThan(fake.steps.indexOf("applied"));
    expectNoLiveTokenOfTheRef(fake);
  });

  it("refuses malformed commits before any call", async () => {
    const { fake, ref } = await setup();

    expect(await ref.update("not-a-sha", C2)).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await ref.update(C1, "A".repeat(40))).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    expect(fake.steps).toEqual([]);
  });

  it("refuses a rewind, an unrelated commit and a missing commit before minting or sending", async () => {
    const { fake, ref } = await setup();
    fake.forcePush(C3);

    for (const next of [C1, SIDE, MISSING]) {
      expect(await ref.update(C3, next)).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(fake.main).toBe(C3);
    expect(fake.steps).not.toContain("createToken");
    expect(fake.steps).not.toContain("receive-pack");
    expectNoLiveTokenOfTheRef(fake);
  });

  it("searches only maxAncestry commits of the new commit's first-parent history", async () => {
    const { fake, ref } = await setup({ ...FAST, maxAncestry: 2 });

    // C1 is the third commit back from C3, so it is out of reach.
    expect(await ref.update(C1, C3)).toMatchObject({ ok: false, code: "invalid_request" });
    expect(fake.main).toBe(C1);
    // One step is within reach.
    expect(await ref.update(C1, C2)).toEqual({ ok: true, value: { kind: "updated" } });
    expect(fake.main).toBe(C2);
  });

  it("refuses and reports while another write token on main is live", async () => {
    const { fake, ref } = await setup();
    const foreign = fake.mintFor("write", 3_600);

    expect(await ref.update(C1, C2)).toMatchObject({ ok: false, code: "unavailable" });

    expect(fake.main).toBe(C1);
    expect(fake.steps).not.toContain("createToken");
    expect(reported()).toEqual(["main_ref_foreign_writer"]);
    expectNoLiveTokenOfTheRef(fake, [foreign.id]);

    // Read tokens are no writer, and the foreign one is gone once revoked.
    foreign.revoked = true;
    fake.mintFor("read", 3_600);
    expect(await ref.update(C1, C2)).toEqual({ ok: true, value: { kind: "updated" } });
  });

  it("refuses while the token listing cannot show every live token", async () => {
    const { fake, ref } = await setup();
    for (let index = 0; index < 31; index += 1) fake.mintFor("read", 3_600);

    expect(await ref.update(C1, C2)).toMatchObject({ ok: false, code: "unavailable" });
    expect(fake.main).toBe(C1);
    expect(fake.steps).not.toContain("createToken");
  });

  it("returns main as rejected after another writer moved it, revoking before the read-back", async () => {
    const { fake, ref } = await setup();
    // Another writer's forced push, with a token no longer live.
    fake.forcePush(C2);

    expect(await ref.update(C1, C2)).toEqual({ ok: true, value: { kind: "rejected", actual: C2 } });
    fake.forcePush(SIDE);
    expect(await ref.update(C2, C3)).toEqual({
      ok: true,
      value: { kind: "rejected", actual: SIDE },
    });

    expect(fake.main).toBe(SIDE);
    expect(reported()).toEqual(["main_ref_moved", "main_ref_moved"]);
    const pushed = fake.steps.lastIndexOf("receive-pack");
    const revoked = fake.steps.indexOf("revokeToken", pushed);
    expect(revoked).toBeGreaterThan(pushed);
    expect(fake.steps.indexOf("log", revoked)).toBeGreaterThan(revoked);
    expectNoLiveTokenOfTheRef(fake);
  });

  it("aborts at the deadline and revokes the token before main is read back", async () => {
    const { fake, ref } = await setup();
    fake.failNextPush("apply-then-hang");

    const update = ref.update(C1, C2);
    // A read issued while the update runs waits for its token to be revoked.
    const read = ref.read();
    expect(await update).toEqual({ ok: true, value: { kind: "uncertain" } });
    expect(await read).toEqual({ ok: true, value: C2 });

    const revoked = fake.steps.indexOf("revokeToken");
    expect(revoked).toBeGreaterThan(fake.steps.indexOf("receive-pack"));
    expect(fake.steps.indexOf("log", revoked)).toBeGreaterThan(revoked);
    expect(reported()).toEqual(["main_ref_uncertain"]);
    expectNoLiveTokenOfTheRef(fake);
  });

  it("never applies a body that completes after the deadline's revocation", async () => {
    const { fake, ref } = await setup();
    fake.failNextPush("complete-late");
    const held = fake.holdBody();

    const update = ref.update(C1, C2);
    await held.reached;
    expect(await update).toEqual({ ok: true, value: { kind: "uncertain" } });
    expectNoLiveTokenOfTheRef(fake);

    held.release();
    await fake.settled();
    expect(fake.main).toBe(C1);
    expect(fake.steps).not.toContain("applied");
    expect(await ref.read()).toEqual({ ok: true, value: C1 });
  });

  it("refuses a second update while one is in flight", async () => {
    const { fake, ref } = await setup();
    fake.failNextPush("complete-late");
    const held = fake.holdBody();

    const first = ref.update(C1, C2);
    await held.reached;
    expect(await ref.update(C1, C2)).toMatchObject({ ok: false, code: "busy" });
    held.release();
    await first;
    await fake.settled();
    expect(fake.bodies).toHaveLength(1);
  });

  it("reports a refused token as a failure that moved nothing", async () => {
    const { fake, ref } = await setup();
    fake.failNextPush("complete-late");
    const held = fake.holdBody();
    const update = ref.update(C1, C2);
    await held.reached;
    // The token expires while the body is held, so Artifacts refuses it at completion.
    fake.advance(61_000);
    held.release();

    expect(await update).toMatchObject({ ok: false, code: "unavailable" });
    expect(fake.main).toBe(C1);
  });

  it("fails without a read-back answer when Artifacts declines main for another reason", async () => {
    const { fake, ref } = await setup();
    fake.failNextPush("decline");

    expect(await ref.update(C1, C2)).toMatchObject({ ok: false, code: "internal" });
    expect(fake.main).toBe(C1);
    expectNoLiveTokenOfTheRef(fake);
  });

  it("returns uncertain when the answer is not a report", async () => {
    const { fake, ref } = await setup();
    fake.failNextPush("server-error");

    expect(await ref.update(C1, C2)).toEqual({ ok: true, value: { kind: "uncertain" } });
    expectNoLiveTokenOfTheRef(fake);
  });

  it("refuses without minting when a binding call fails, and moves nothing", async () => {
    const { fake, ref } = await setup();
    for (const call of ["get", "log", "listTokens", "info", "createToken"] as const) {
      fake.failNext(call);
      expect(await ref.update(C1, C2)).toMatchObject({ ok: false, code: "unavailable" });
    }
    expect(fake.main).toBe(C1);
    expect(fake.steps).not.toContain("receive-pack");
    expectNoLiveTokenOfTheRef(fake);
  });

  it("keeps a token it could not revoke as its own and revokes it before the next update", async () => {
    const { fake, ref } = await setup();
    fake.failNext("revokeToken");

    expect(await ref.update(C1, C2)).toEqual({ ok: true, value: { kind: "updated" } });
    expect(reported()).toEqual(["main_ref_revoke_failed"]);
    expect(fake.liveWriteTokens()).toHaveLength(1);

    // The leftover token is this ref's, not another writer's.
    expect(await ref.update(C2, C3)).toEqual({ ok: true, value: { kind: "updated" } });
    expect(fake.main).toBe(C3);
    expectNoLiveTokenOfTheRef(fake);
  });
});

describe("main ref read", () => {
  it("reads main's commit", async () => {
    const { ref } = await setup();
    expect(await ref.read()).toEqual({ ok: true, value: C1 });
  });

  it("fails when main's repository cannot be read", async () => {
    const { fake, ref } = await setup();
    fake.failNext("log");
    expect(await ref.read()).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("opens only this repository's main", async () => {
    const fake = new FakeMainRepo(await mainRepoName("rep_bbbbbbbbbbbb"), [C0]);
    const ref = createMainRef(
      { repoId: REPO, namespace: fake, upstream: fake.upstream, clock: fake.clock },
      FAST,
    );
    expect(await ref.read()).toMatchObject({ ok: false, code: "unavailable" });
    expect(await ref.update(C0, C1)).toMatchObject({ ok: false, code: "unavailable" });
    expect(fake.tokens).toEqual([]);
  });
});
