import { runInDurableObject } from "cloudflare:test";
import { env, RpcTarget } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SubscriptionEnd } from "@railhead/shared/board-api";
import type { Actor, RailheadEvent } from "@railhead/shared/events";
import { mainRepoName } from "../src/artifacts/adapter";
import { FakeArtifacts, FakeArtifactsError } from "../src/artifacts/fake";
import { ok } from "../src/contracts/result";
import { DEMO_OBJECT_NAME, demoRepoId } from "../src/modules/demoSeed/entry";
import type { SeedArtifacts, SeedArtifactsRepo } from "../src/modules/demoSeed/target";
import type { StreamListener } from "../src/modules/stream/entry";
import { EventLog } from "../src/repo/eventLog";
import type { Repo } from "../src/repo/RepoObject";

// Its own file, so the demo repository's object starts here with no seed target cached.

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const HUMAN: Actor = { kind: "human", id: "usr_lemarier" };

/** Artifacts with main already at its head, so a seed only reads it and never pushes. */
class MainOnly implements SeedArtifacts {
  readonly fake = new FakeArtifacts();

  async create(): Promise<unknown> {
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

class Recorder extends RpcTarget implements StreamListener {
  readonly seqs: number[] = [];
  readonly ends: SubscriptionEnd[] = [];
  // How many of the Repo's references to this listener were released.
  released = 0;

  async events(events: RailheadEvent[]): Promise<void> {
    this.seqs.push(...events.map((event) => event.seq));
  }

  async ended(reason: SubscriptionEnd): Promise<void> {
    this.ends.push(reason);
  }

  [Symbol.dispose](): void {
    this.released += 1;
  }
}

function dispose(target: object): void {
  const fn: unknown = Reflect.get(target, Symbol.dispose);
  if (typeof fn !== "function") throw new TypeError("Expected a disposable value.");
  fn.call(target);
}

async function appendIn(stub: DurableObjectStub<Repo>, count: number): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    EventLog.open(state.storage, demoRepoId(env)).transaction((tx) => {
      for (let n = 1; n <= count; n += 1) {
        tx.append(HUMAN, {
          type: "issue.filed",
          data: {
            issueId: `iss_issue${String(n).padStart(4, "0")}`,
            title: `Issue ${n}`,
            body: "",
          },
        });
      }
    });
  });
}

/** Resolves once `condition` holds, or fails after `ms`. */
async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("demo reset", () => {
  it("ends live subscriptions, and refuses an old cursor once the new log passes it", async () => {
    const stub = env.REPO.getByName(DEMO_OBJECT_NAME);
    const artifacts = new MainOnly();
    const main = await mainRepoName(demoRepoId(env));
    artifacts.fake.seed(main, [HEAD]);
    // The pool has no Artifacts binding; the object reads one from its env when the seed target is
    // first built, so lend it the fake before that.
    await runInDurableObject(stub, async (instance) => {
      Reflect.set(instance, "env", { ...env, ARTIFACTS: artifacts });
      expect(await instance.demoSeedState()).toEqual(ok(null));
    });
    expect(await stub.seedDemo(HEAD, new Uint8Array(0))).toMatchObject({ ok: true });
    await appendIn(stub, 3);
    const before = await stub.readEvents(0, 10, null);
    if (!before.ok) throw new Error(before.code);
    const oldHistory = before.value.history;

    const old = new Recorder();
    const subscription = await stub.subscribe(0, old, oldHistory);
    if (!subscription.ok) throw new Error(subscription.code);
    await until(() => old.seqs.length === 3);
    expect(old.released).toBe(0);

    expect(await stub.resetDemo()).toEqual(ok({ kind: "demo.reset", deleted: true }));
    await until(() => old.ends.length > 0);
    expect(old.ends).toEqual(["revoked"]);
    // The Repo lets go of the listener it held, so nothing keeps the old subscriber's stub alive.
    await until(() => old.released === 1);
    expect(await stub.subscribe(0, new Recorder(), null)).toMatchObject({
      ok: false,
      code: "not_found",
    });

    artifacts.fake.seed(main, [OTHER_HEAD]);
    expect(await stub.seedDemo(OTHER_HEAD, new Uint8Array(0))).toMatchObject({ ok: true });
    // The new log grows past the old cursor, so only the history tells the two logs apart.
    await appendIn(stub, 5);
    const stale = new Recorder();
    expect(await stub.subscribe(3, stale, oldHistory)).toMatchObject({
      ok: false,
      code: "cursor_ahead",
    });
    expect(await stub.readEvents(3, 10, oldHistory)).toMatchObject({
      ok: false,
      code: "cursor_ahead",
    });
    expect(await stub.readEvents(0, 10, oldHistory)).toMatchObject({
      ok: false,
      code: "cursor_ahead",
    });

    // A board that reads the new log afresh gets the new history and resumes under it.
    const page = await stub.readEvents(0, 3, null);
    if (!page.ok) throw new Error(page.code);
    expect(page.value.history).not.toBe(oldHistory);
    expect(page.value).toMatchObject({ cursor: 3, head: 5 });
    const fresh = new Recorder();
    const renewed = await stub.subscribe(3, fresh, page.value.history);
    if (!renewed.ok) throw new Error(renewed.code);
    await until(() => fresh.seqs.length === 2);
    expect(fresh.seqs).toEqual([4, 5]);
    expect(stale.seqs).toEqual([]);
    expect(old.seqs).toEqual([1, 2, 3]);
    expect(old.ends).toEqual(["revoked"]);

    // The ended subscription's slot and listener go once its handle is released.
    dispose(subscription.value);
    await renewed.value.cancel();
    dispose(renewed.value);
  });
});
