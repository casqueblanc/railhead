// The qualification probe's routes, run in workerd against `FakeMainRepo`, which models the main-ref
// behaviour measured on #158. This checks that each case drives the production adapter and reports
// what the harness judges; it says nothing about live Artifacts, which only an operator's run of
// `scripts/qualify-slice.mjs binding` against a deployed probe can show.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mainRepoName } from "../src/artifacts/adapter";
import { FakeMainRepo } from "../src/artifacts/mainRefFake";
import probe, { type ProbeEnv } from "../qualify/probe";

const SECRET = "probe-test-secret-0123456789abcdef0123";
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const N1 = "3".repeat(40);
const N2 = "4".repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
});

/** A probe whose namespace holds one fake main, created through the probe's `create` route. */
function world() {
  const state: { main: FakeMainRepo | null } = { main: null };
  const fakeMain = (): FakeMainRepo => {
    if (state.main === null) throw new Error("no repository was created");
    return state.main;
  };
  const env: ProbeEnv = {
    PROBE_SECRET: SECRET,
    ARTIFACTS: {
      create: async (name) => {
        const created = new FakeMainRepo(name, [C1, C2], Date.now());
        created.commit(N1, [C2]);
        created.commit(N2, [N1]);
        state.main = created;
        return { name, remote: created.remote, token: created.mintFor("write", 3_600).plaintext };
      },
      get: (name) => fakeMain().get(name),
      delete: async () => true,
    },
    EVICTION: {
      getByName: () => {
        throw new Error("the eviction case needs a deployed probe");
      },
    },
  };
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    fakeMain().upstream(new Request(input, init)),
  );
  return { env, fakeMain };
}

async function call(
  env: ProbeEnv,
  name: string,
  body: unknown,
  secret = SECRET,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await probe.fetch(
    new Request(`https://probe.invalid/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: response.status, body: await response.json() };
}

/** Creates the fake main and revokes its creation token, as the harness does. */
async function createRepo(env: ProbeEnv): Promise<string> {
  const made = await call(env, "create", {});
  const repoId = String(made.body.repoId);
  await call(env, "revoke", { repoId, token: made.body.token });
  return repoId;
}

describe("the qualification probe", () => {
  it("runs the adapter's update and reports main and the live write tokens after it", async () => {
    const { env, fakeMain } = world();
    const repoId = await createRepo(env);
    expect(fakeMain().name).toBe(await mainRepoName(repoId));

    const forward = await call(env, "update", { repoId, expected: C2, next: N1 });
    expect(forward).toEqual({
      status: 200,
      body: { result: { ok: true, value: { kind: "updated" } }, main: N1, liveWriteTokens: 0 },
    });
    const stale = await call(env, "update", { repoId, expected: C2, next: N1 });
    expect(stale.body).toMatchObject({
      result: { ok: true, value: { kind: "rejected", actual: N1 } },
      main: N1,
    });
    const rewind = await call(env, "update", { repoId, expected: N1, next: C2 });
    expect(rewind.body).toMatchObject({ result: { ok: false, code: "invalid_request" }, main: N1 });
    expect(fakeMain().openHandles).toBe(0);
  });

  it("reports a lost response as uncertain, with main moved once and a repeat refused", async () => {
    const { env, fakeMain } = world();
    const repoId = await createRepo(env);

    const lost = await call(env, "lost-response", { repoId, expected: C2, next: N1 });
    expect(lost.body).toEqual({
      result: { ok: true, value: { kind: "uncertain" } },
      main: N1,
      liveWriteTokens: 0,
      repeat: { status: 200, line: "ng refs/heads/main stale ref" },
    });
    expect(fakeMain().steps.filter((step) => step === "applied")).toHaveLength(1);
  });

  it("lets exactly one of several raw updates from one commit land", async () => {
    const { env, fakeMain } = world();
    const repoId = await createRepo(env);
    const nexts = ["5", "6", "7"].map((digit) => digit.repeat(40));
    for (const next of nexts) fakeMain().commit(next, [C2]);

    const raced = await call(env, "race", { repoId, expected: C2, nexts });
    const updates: unknown = raced.body.updates;
    const lines = Array.isArray(updates)
      ? updates.map((update: unknown) => String(Reflect.get(Object(update), "line")))
      : [];
    expect(lines.filter((line) => line === "ok refs/heads/main")).toHaveLength(1);
    expect(lines.filter((line) => line === "ng refs/heads/main stale ref")).toHaveLength(2);
    expect(nexts).toContain(raced.body.main);
    expect(fakeMain().liveWriteTokens()).toEqual([]);
  });

  it("completes a held body only after its token was revoked, and main stays", async () => {
    const { env, fakeMain } = world();
    const repoId = await createRepo(env);

    const fenced = await call(env, "fence", { repoId, expected: C2, next: N1 });
    expect(fenced.body).toEqual({ revoked: true, answered: { status: 403, line: null }, main: C2 });
    expect(fakeMain().main).toBe(C2);
  });

  it("reports the hashes log answers for a ref, as the fake resolves it", async () => {
    const { env, fakeMain } = world();
    const repoId = await createRepo(env);
    fakeMain().forcePush(N1);

    const log = async (ref: string) => (await call(env, "log", { repoId, ref })).body;
    expect(await log("main")).toEqual({ hashes: [N1] });
    expect(await log(C1)).toEqual({ hashes: [C1] });
    expect(await log("refs/heads/main")).toEqual({ hashes: [] });
    expect(await log("qualify/missing")).toEqual({ hashes: [] });
    expect(fakeMain().openHandles).toBe(0);
  });

  it("refuses another secret, a GET and malformed cases before touching Artifacts", async () => {
    const { env, fakeMain } = world();
    const repoId = await createRepo(env);
    const steps = fakeMain().steps.length;

    expect(
      (await call(env, "main", { repoId }, "wrong-secret-0123456789abcdef0123456789")).status,
    ).toBe(403);
    const get = await probe.fetch(new Request("https://probe.invalid/main"), env);
    expect(get.status).toBe(405);
    expect((await call(env, "update", { repoId: "rep_x", expected: C2, next: N1 })).status).toBe(
      400,
    );
    expect((await call(env, "update", { repoId, expected: "main", next: N1 })).status).toBe(400);
    // A race needs two to eight commits.
    expect((await call(env, "race", { repoId, expected: C2, nexts: [N1] })).status).toBe(400);
    expect(
      (await call(env, "race", { repoId, expected: C2, nexts: Array(9).fill(N1) })).status,
    ).toBe(400);
    expect((await call(env, "log", { repoId })).status).toBe(400);
    expect((await call(env, "log", { repoId, ref: "-main" })).status).toBe(400);
    expect((await call(env, "log", { repoId, ref: "x".repeat(256) })).status).toBe(400);
    expect((await call(env, "unknown", {})).status).toBe(404);
    expect(fakeMain().steps).toHaveLength(steps);
  });

  it("refuses every request while its secret is shorter than 32 characters", async () => {
    const { env } = world();
    env.PROBE_SECRET = "short";
    expect((await call(env, "create", {}, "short")).status).toBe(403);
  });

  it("answers a binding failure with its code only", async () => {
    const { env, fakeMain } = world();
    const repoId = await createRepo(env);
    fakeMain().failNext("log");

    const failed = await call(env, "main", { repoId });
    expect(failed).toEqual({ status: 500, body: { error: "INTERNAL_ERROR" } });
  });
});
