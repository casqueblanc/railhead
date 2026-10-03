// The train's startup wake through the real Repo: a Repo rebuilt over a stored wake row stores its
// alarm before it serves anything, and resets itself when every attempt fails, so the next request
// stores it instead. Storage faults are injected into the runtime's own `setAlarm`.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STARTUP_WAKE_ATTEMPTS } from "../src/modules/train/scheduler";
import { readWake, writeWake } from "../src/modules/train/store";
import { repoObjectName, type Repo } from "../src/repo/RepoObject";

const ORG = "acme";

/** A Repo no other test uses, initialized. */
async function freshRepo(): Promise<DurableObjectStub<Repo>> {
  const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const stub = env.REPO.getByName(repoObjectName(ORG, name));
  const created = await stub.initialize(ORG, name);
  expect(created.ok).toBe(true);
  return stub;
}

/**
 * Leaves the train's wake row due at `dueAt` with no stored alarm, as when the object stopped
 * before its alarm write reached storage, then evicts the object.
 */
async function strandWake(stub: DurableObjectStub<Repo>, dueAt: number): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    writeWake(state.storage.sql, { dueAt, failures: 0 });
    await state.storage.deleteAlarm();
  });
  await evictDurableObject(stub);
}

/** Makes the next `count` alarm writes of every object reject; returns how many were refused. */
async function failAlarmWrites(count: number): Promise<{ refused: () => number }> {
  // Another object lends its storage's prototype, so the Repo under test is not started early.
  const probe = env.REPO.getByName(crypto.randomUUID());
  const storage = await runInDurableObject(probe, (_instance, state) => state.storage);
  const prototype: Pick<DurableObjectStorage, "setAlarm"> = Object.getPrototypeOf(storage);
  const original = prototype.setAlarm;
  let left = count;
  let refused = 0;
  vi.spyOn(prototype, "setAlarm").mockImplementation(function (
    this: DurableObjectStorage,
    ...args: Parameters<DurableObjectStorage["setAlarm"]>
  ) {
    if (left > 0) {
      left -= 1;
      refused += 1;
      return Promise.reject(new Error("alarm write failed"));
    }
    return original.apply(this, args);
  });
  return { refused: () => refused };
}

async function storedAlarm(stub: DurableObjectStub<Repo>): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

async function storedWake(stub: DurableObjectStub<Repo>): Promise<unknown> {
  return runInDurableObject(stub, (_instance, state) => readWake(state.storage.sql));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Repo's startup wake", () => {
  it("stores a stranded wake before serving the first request", async () => {
    const stub = await freshRepo();
    const dueAt = Date.now() + 24 * 60 * 60_000;
    await strandWake(stub, dueAt);

    expect(await stub.describe()).toMatchObject({ org: ORG });
    expect(await storedAlarm(stub)).toBe(dueAt);
  });

  it("keeps serving when a write fails and a later attempt stores the wake", async () => {
    const stub = await freshRepo();
    const dueAt = Date.now() + 24 * 60 * 60_000;
    await strandWake(stub, dueAt);
    const faults = await failAlarmWrites(STARTUP_WAKE_ATTEMPTS - 1);

    // The retries run before the request is served, so it succeeds with the alarm stored.
    expect(await stub.describe()).toMatchObject({ org: ORG });
    expect(faults.refused()).toBe(STARTUP_WAKE_ATTEMPTS - 1);
    expect(await storedAlarm(stub)).toBe(dueAt);
  });

  it("resets when every write fails, and the next request stores the wake the alarm then drives", async () => {
    const stub = await freshRepo();
    // Already due, so the stored alarm drives it.
    const dueAt = Date.now() - 1;
    await strandWake(stub, dueAt);
    const faults = await failAlarmWrites(STARTUP_WAKE_ATTEMPTS);
    // The runtime reports the failed startup as it resets the object; record it rather than let
    // it fail the run as an unexpected error.
    const resets: unknown[] = [];
    const onReset = (error: unknown): void => {
      resets.push(error);
    };
    process.on("unhandledRejection", onReset);
    try {
      await expect(stub.describe()).rejects.toThrow("the train's wake could not be stored");
    } finally {
      process.off("unhandledRejection", onReset);
    }
    expect(faults.refused()).toBe(STARTUP_WAKE_ATTEMPTS);
    expect(resets).toEqual([expect.objectContaining({ durableObjectReset: true })]);

    // Storage recovers, and the first request after the reset, through a new stub as the broken
    // one stays broken, rebuilds the train, which stores the wake. Nothing calls the train before
    // the alarm drives it.
    vi.restoreAllMocks();
    const again: DurableObjectStub<Repo> = env.REPO.get(stub.id);
    expect(await again.describe()).toMatchObject({ org: ORG });
    // Only the stored alarm drives the train here: the runtime fires it as it is due, or the test
    // runs it, and the drive finds no work and clears the row.
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(again);
        expect(await storedWake(again)).toBeNull();
      },
      { timeout: 5_000 },
    );
  });

  it("stores the wake on the next start when the object is evicted inside the retry window", async () => {
    const stub = await freshRepo();
    const dueAt = Date.now() + 24 * 60 * 60_000;
    await strandWake(stub, dueAt);
    const faults = await failAlarmWrites(1);

    // The first write fails and the object is evicted before the retry fires; the request it was
    // starting for may fail with it.
    const first = stub.describe().then(
      () => "served",
      () => "failed",
    );
    await vi.waitFor(() => expect(faults.refused()).toBe(1));
    await evictDurableObject(stub);
    expect(["served", "failed"]).toContain(await first);

    const again: DurableObjectStub<Repo> = env.REPO.get(stub.id);
    expect(await again.describe()).toMatchObject({ org: ORG });
    expect(await storedAlarm(again)).toBe(dueAt);
  });

  it("resets on no write when the train owes no wake", async () => {
    const stub = await freshRepo();
    await evictDurableObject(stub);
    const faults = await failAlarmWrites(STARTUP_WAKE_ATTEMPTS);

    expect(await stub.describe()).toMatchObject({ org: ORG });
    expect(faults.refused()).toBe(0);
    expect(await storedAlarm(stub)).toBeNull();
  });
});
