import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { mainRepoName } from "../src/artifacts/adapter";
import { FakeArtifacts, FakeArtifactsError } from "../src/artifacts/fake";
import { ok } from "../src/contracts/result";
import { DEMO_OBJECT_NAME, demoRepoId } from "../src/modules/demoSeed/entry";
import type { SeedArtifacts, SeedArtifactsRepo } from "../src/modules/demoSeed/target";

// Its own file, so the demo repository's object starts here with no seed target cached.

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);

/** Artifacts with main already at its head, counting creates so a refused seed shows it made none. */
class MainOnly implements SeedArtifacts {
  readonly fake = new FakeArtifacts();
  creates = 0;

  async create(): Promise<unknown> {
    this.creates += 1;
    throw new FakeArtifactsError("INTERNAL_ERROR");
  }

  async get(name: string): Promise<SeedArtifactsRepo> {
    const handle = await this.fake.get(name);
    return {
      ...handle,
      info: async () => {
        throw new FakeArtifactsError("INTERNAL_ERROR");
      },
    };
  }

  async delete(name: string): Promise<boolean> {
    return this.fake.repos.delete(name);
  }
}

describe("demo reset whose wipe fails", () => {
  it("keeps the Repo initialized, so the next seed is refused before touching Artifacts", async () => {
    const stub = env.REPO.getByName(DEMO_OBJECT_NAME);
    const artifacts = new MainOnly();
    const main = await mainRepoName(demoRepoId(env));
    artifacts.fake.seed(main, [HEAD]);
    await runInDurableObject(stub, async (instance) => {
      Reflect.set(instance, "env", { ...env, ARTIFACTS: artifacts });
      expect(await instance.demoSeedState()).toEqual(ok(null));
    });
    expect(await stub.seedDemo(HEAD, new Uint8Array(0))).toMatchObject({ ok: true });
    const before = await stub.readEvents(0, 10, null);
    if (!before.ok) throw new Error(before.code);

    // Called in the object, so the rejection reaches the test rather than crossing RPC.
    await runInDurableObject(stub, async (instance, state) => {
      Reflect.set(state.storage, "deleteAll", async () => {
        throw new Error("storage unavailable");
      });
      await expect(instance.resetDemo()).rejects.toThrow("storage unavailable");
    });
    expect(artifacts.fake.repos.has(main)).toBe(false);

    // Storage still holds the Repo, and so does the running object: its log stays readable under
    // the same history, and a seed finds main missing behind an initialized Repo.
    expect(await stub.readEvents(0, 10, before.value.history)).toMatchObject({ ok: true });
    expect(await stub.seedDemo(OTHER_HEAD, new Uint8Array(0))).toMatchObject({
      ok: false,
      code: "action_stale",
    });
    expect(artifacts.creates).toBe(0);
    expect(artifacts.fake.repos.has(main)).toBe(false);
  });
});
