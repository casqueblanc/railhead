import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  type ClaimId,
  type CommitSha,
  type DecisionRef,
  type MainOutcome,
} from "@railhead/shared/events";
import { fail, ok, type PortResult } from "../src/contracts/result";
import type {
  AuthorizationPort,
  CheckAttempt,
  MainRefPort,
  MainUpdate,
  MainWriterPort,
  MergeIntentRecord,
} from "../src/contracts/train";
import { unavailableAuthorization } from "../src/contracts/unavailable";
import {
  createMainWriter,
  MAX_QUEUED_PUBLICATIONS,
  MAX_WRITE_ATTEMPTS,
  type MainWriterDeps,
} from "../src/modules/mainWriter/mainWriter";
import { EventLog } from "../src/repo/eventLog";
import type { RepoStorage } from "../src/repo/storage";
import { createAuthorization, TRAIN_ACTOR } from "../src/train/authorize";

const REPO = "rep_demo01";
const NOW = 1_790_000_000_000;
const ATTEMPT = "chk_attempt01";
const INTENT = "int_intent01";
const MAIN = "a".repeat(40);
const CANDIDATE = "c".repeat(40);
const OTHER = "e".repeat(40);
const CLAIM_A: ClaimId = "clm_claim001";
const CLAIM_B: ClaimId = "clm_claim002";
const DEC_FORMAT: DecisionRef = { decisionId: "dec_format01", version: 1 };

/** How the fake ref answers one conditional update. */
type Step =
  /** Applies the update if main is at the expected commit, and says what happened. */
  | "honest"
  /** Applies the update, then loses the response. */
  | "lose"
  /** Applies nothing and reports an uncertain outcome. */
  | "drop"
  /** Applies nothing, and another writer moves main to `OTHER` meanwhile. */
  | "race"
  /** Applies the update, then the object dies before hearing back. */
  | "crash-after"
  /** The object dies before the update reaches Git. */
  | "crash-before"
  /** The ref refuses without effect. */
  | "refuse";

/** A Git ref with compare-and-swap semantics. It never moves main from anything but `expected`. */
class FakeMain implements MainRefPort {
  updates: { expected: CommitSha; next: CommitSha }[] = [];
  reads = 0;
  readFails = false;

  constructor(
    public main: CommitSha = MAIN,
    public steps: Step[] = [],
  ) {}

  async read(): Promise<PortResult<CommitSha>> {
    this.reads += 1;
    return this.readFails ? fail("unavailable", "Git is not answering.") : ok(this.main);
  }

  async update(expected: CommitSha, next: CommitSha): Promise<PortResult<MainUpdate>> {
    this.updates.push({ expected, next });
    const step = this.steps.shift() ?? "honest";
    const applies = this.main === expected;
    switch (step) {
      case "honest":
        if (!applies) return ok({ kind: "rejected", actual: this.main });
        this.main = next;
        return ok({ kind: "updated" });
      case "lose":
        if (applies) this.main = next;
        return ok({ kind: "uncertain" });
      case "drop":
        return ok({ kind: "uncertain" });
      case "race":
        this.main = OTHER;
        return ok({ kind: "uncertain" });
      case "crash-after":
        if (applies) this.main = next;
        throw new Error("the object was reset");
      case "crash-before":
        throw new Error("the object was reset");
      case "refuse":
        return fail("unavailable", "Git refused the connection.");
      default:
        return unreachable(step);
    }
  }
}

/** Current claim and decision state, which a test changes to model a concurrent write. */
class World {
  generations = new Map<ClaimId, number>([
    [CLAIM_A, 1],
    [CLAIM_B, 3],
  ]);
  versions = new Map<ClaimId, DecisionRef[] | null>([
    [CLAIM_A, [DEC_FORMAT]],
    [CLAIM_B, []],
  ]);
}

function attempt(): CheckAttempt {
  return {
    attemptId: ATTEMPT,
    expectedMain: MAIN,
    candidate: CANDIDATE,
    pins: [
      { claimId: CLAIM_A, generation: 1, commit: "1".repeat(40) },
      { claimId: CLAIM_B, generation: 3, commit: "2".repeat(40) },
    ],
    definition: { name: "upload", source: MAIN, digest: "d".repeat(64), acceptance: null },
    decisions: [DEC_FORMAT],
    createdAt: NOW - 60_000,
  };
}

interface Harness {
  storage: RepoStorage;
  log: EventLog;
  authorization: AuthorizationPort;
  writer: MainWriterPort;
}

function harness(storage: RepoStorage, world: World, ref: MainRefPort): Harness {
  const log = EventLog.open(storage, REPO, () => NOW);
  const authorization = createAuthorization(
    { storage, log, clock: () => NOW },
    {
      attemptOutcome: (attemptId) =>
        attemptId === ATTEMPT
          ? {
              attempt: attempt(),
              report: {
                attemptId: ATTEMPT,
                candidate: CANDIDATE,
                result: "pass",
                logDigest: null,
                finishedAt: NOW - 1_000,
              },
            }
          : null,
      currentGeneration: (claimId) => world.generations.get(claimId) ?? null,
      currentVersions: (claimId) => world.versions.get(claimId) ?? null,
    },
    () => INTENT,
  );
  const deps: MainWriterDeps = {
    authorization,
    currentGeneration: (claimId) => world.generations.get(claimId) ?? null,
    currentVersions: (claimId) => world.versions.get(claimId) ?? null,
  };
  const writer = createMainWriter({ log }, () => deps, ref);
  return { storage, log, authorization, writer };
}

function freshStub(): DurableObjectStub {
  return env.REPO.getByName(crypto.randomUUID());
}

/** Runs `body` against a Repo whose intent is already authorized. */
function withIntent<R>(
  ref: MainRefPort,
  body: (h: Harness) => Promise<R>,
  world: World = new World(),
  stub: DurableObjectStub = freshStub(),
): Promise<R> {
  return runInDurableObject(stub, async (_instance, state) => {
    const h = harness(state.storage, world, ref);
    const authorized = await h.authorization.authorize(ATTEMPT);
    expect(authorized).toMatchObject({ ok: true, value: { intentId: INTENT } });
    return body(h);
  });
}

function pendingRecord(attempts = 0, main: CommitSha | null = null): MergeIntentRecord {
  return {
    intentId: INTENT,
    expectedMain: MAIN,
    candidate: CANDIDATE,
    pins: attempt().pins,
    decisions: [DEC_FORMAT],
    checkAttemptId: ATTEMPT,
    status: "authorized",
    attempts,
    main,
    authorizedAt: NOW,
    updatedAt: NOW,
  };
}

function settled(outcome: MainOutcome, attempts: number, main: CommitSha): MergeIntentRecord {
  return { ...pendingRecord(attempts, main), status: outcome };
}

/** The `train.main` events after authorization's `train.intent`. */
function mainEvents(log: EventLog): unknown[] {
  return log.replay(1, 10).events;
}

function mainEvent(seq: number, outcome: MainOutcome, main: CommitSha): unknown {
  return {
    v: EVENT_SCHEMA_VERSION,
    seq,
    at: NOW,
    repo: REPO,
    actor: TRAIN_ACTOR,
    type: "train.main",
    data: { intentId: INTENT, outcome, main },
  };
}

/** Every update the fake saw was conditional on the authorized expected commit. */
function expectOnlyConditional(ref: FakeMain): void {
  for (const update of ref.updates) expect(update).toEqual({ expected: MAIN, next: CANDIDATE });
}

describe("publish", () => {
  it("moves main from the expected commit and records the outcome with its event", async () => {
    const ref = new FakeMain();
    await withIntent(ref, async (h) => {
      const result = await h.writer.publish(INTENT);

      expect(result).toEqual({ ok: true, value: settled("updated", 1, CANDIDATE) });
      expect(ref.main).toBe(CANDIDATE);
      expect(ref.updates).toHaveLength(1);
      expectOnlyConditional(ref);
      expect(await h.authorization.intent(INTENT)).toEqual(result);
      expect(mainEvents(h.log)).toEqual([mainEvent(2, "updated", CANDIDATE)]);
    });
  });

  it("returns the settled record to a repeat without writing again", async () => {
    const ref = new FakeMain();
    await withIntent(ref, async (h) => {
      const first = await h.writer.publish(INTENT);
      const second = await h.writer.publish(INTENT);

      expect(second).toEqual(first);
      expect(ref.updates).toHaveLength(1);
      expect(ref.reads).toBe(0);
      expect(h.log.head()).toBe(2);
    });
  });

  it("runs concurrent publications of one intent one at a time, writing once", async () => {
    const ref = new FakeMain();
    await withIntent(ref, async (h) => {
      const results = await Promise.all([h.writer.publish(INTENT), h.writer.publish(INTENT)]);

      expect(results).toEqual([
        { ok: true, value: settled("updated", 1, CANDIDATE) },
        { ok: true, value: settled("updated", 1, CANDIDATE) },
      ]);
      expect(ref.updates).toHaveLength(1);
      expect(h.log.head()).toBe(2);
    });
  });

  it("reads main without moving it", async () => {
    const ref = new FakeMain(OTHER);
    await withIntent(ref, async (h) => {
      expect(await h.writer.head()).toEqual({ ok: true, value: OTHER });
      expect(ref.updates).toHaveLength(0);
    });
  });
});

describe("publish refuses invalid input", () => {
  it("refuses an id that is not an intent identifier", async () => {
    const ref = new FakeMain();
    await withIntent(ref, async (h) => {
      for (const id of ["chk_attempt01", "int_", ""]) {
        expect(await h.writer.publish(id)).toMatchObject({ ok: false, code: "invalid_request" });
      }
      expect(ref.updates).toHaveLength(0);
      expect(h.log.head()).toBe(1);
    });
  });

  it("refuses an unknown intent without touching main", async () => {
    const ref = new FakeMain();
    await withIntent(ref, async (h) => {
      expect(await h.writer.publish("int_unknown01")).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(ref.updates).toHaveLength(0);
      expect(ref.reads).toBe(0);
    });
  });

  it("refuses while the authorization module is missing", async () => {
    const ref = new FakeMain();
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const log = EventLog.open(state.storage, REPO, () => NOW);
      const writer = createMainWriter(
        { log },
        () => ({
          authorization: unavailableAuthorization,
          currentGeneration: () => null,
          currentVersions: () => null,
        }),
        ref,
      );
      expect(await writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
      expect(ref.updates).toHaveLength(0);
      expect(log.head()).toBe(0);
    });
  });
});

describe("publish writes only against the expected commit", () => {
  it("records a rejection when main is no longer at the expected commit", async () => {
    const ref = new FakeMain(OTHER);
    await withIntent(ref, async (h) => {
      const result = await h.writer.publish(INTENT);

      expect(result).toEqual({ ok: true, value: settled("rejected", 1, OTHER) });
      expect(ref.main).toBe(OTHER);
      expectOnlyConditional(ref);
      expect(mainEvents(h.log)).toEqual([mainEvent(2, "rejected", OTHER)]);
    });
  });

  it("settles a lost success response by reading main back, without writing again", async () => {
    const ref = new FakeMain(MAIN, ["lose"]);
    await withIntent(ref, async (h) => {
      const result = await h.writer.publish(INTENT);

      expect(result).toEqual({ ok: true, value: settled("reconciled", 1, CANDIDATE) });
      expect(ref.updates).toHaveLength(1);
      expect(ref.reads).toBe(1);
      expect(mainEvents(h.log)).toEqual([mainEvent(2, "reconciled", CANDIDATE)]);
    });
  });

  it("writes again, conditionally, when the uncertain write never applied", async () => {
    const ref = new FakeMain(MAIN, ["drop"]);
    await withIntent(ref, async (h) => {
      const result = await h.writer.publish(INTENT);

      expect(result).toEqual({ ok: true, value: settled("updated", 2, CANDIDATE) });
      expect(ref.updates).toHaveLength(2);
      expectOnlyConditional(ref);
      expect(mainEvents(h.log)).toEqual([mainEvent(2, "updated", CANDIDATE)]);
    });
  });

  it("settles without writing when main moved elsewhere during an uncertain write", async () => {
    const ref = new FakeMain(MAIN, ["race"]);
    await withIntent(ref, async (h) => {
      const result = await h.writer.publish(INTENT);

      expect(result).toEqual({ ok: true, value: settled("reconciled", 1, OTHER) });
      expect(ref.main).toBe(OTHER);
      expect(ref.updates).toHaveLength(1);
      expect(mainEvents(h.log)).toEqual([mainEvent(2, "reconciled", OTHER)]);
    });
  });

  it(`stops after ${MAX_WRITE_ATTEMPTS} unconfirmed attempts and then only reads main`, async () => {
    const ref = new FakeMain(
      MAIN,
      Array.from({ length: MAX_WRITE_ATTEMPTS }, () => "drop"),
    );
    await withIntent(ref, async (h) => {
      expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
      expect(ref.updates).toHaveLength(MAX_WRITE_ATTEMPTS);
      expect(h.authorization.record(INTENT)).toEqual(pendingRecord(MAX_WRITE_ATTEMPTS));
      expect(h.log.head()).toBe(1);

      // A later publication still reconciles, but never writes once the attempts are used up.
      expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
      expect(ref.updates).toHaveLength(MAX_WRITE_ATTEMPTS);
      ref.main = CANDIDATE;
      expect(await h.writer.publish(INTENT)).toEqual({
        ok: true,
        value: settled("reconciled", MAX_WRITE_ATTEMPTS, CANDIDATE),
      });
      expect(ref.updates).toHaveLength(MAX_WRITE_ATTEMPTS);
    });
  });
});

describe("publish reconciles across recreation", () => {
  it("finds a write that landed before the object died, and never writes it twice", async () => {
    const stub = freshStub();
    const ref = new FakeMain(MAIN, ["crash-after"]);
    await withIntent(
      ref,
      async (h) => {
        await expect(h.writer.publish(INTENT)).rejects.toThrow("the object was reset");
        expect(h.authorization.record(INTENT)).toEqual(pendingRecord(1));
      },
      new World(),
      stub,
    );
    await evictDurableObject(stub);

    const after = new FakeMain(ref.main);
    await runInDurableObject(stub, async (_instance, state) => {
      const h = harness(state.storage, new World(), after);
      const result = await h.writer.publish(INTENT);

      expect(result).toEqual({ ok: true, value: settled("reconciled", 1, CANDIDATE) });
      expect(after.updates).toHaveLength(0);
      expect(mainEvents(h.log)).toEqual([mainEvent(2, "reconciled", CANDIDATE)]);
    });
  });

  it("resumes an intent whose write never reached Git with a conditional write", async () => {
    const stub = freshStub();
    const ref = new FakeMain(MAIN, ["crash-before"]);
    await withIntent(
      ref,
      (h) => expect(h.writer.publish(INTENT)).rejects.toThrow("the object was reset"),
      new World(),
      stub,
    );
    await evictDurableObject(stub);

    const after = new FakeMain(ref.main);
    await runInDurableObject(stub, async (_instance, state) => {
      const h = harness(state.storage, new World(), after);
      const result = await h.writer.publish(INTENT);

      expect(result).toEqual({ ok: true, value: settled("updated", 2, CANDIDATE) });
      expect(after.reads).toBe(1);
      expectOnlyConditional(after);
      expect(after.updates).toHaveLength(1);
    });
  });

  it("records a late landing as reconciled when a resumed write finds main at the candidate", async () => {
    // The first attempt's response was lost while main still read as expected; the resumed
    // conditional write is then rejected by the candidate itself.
    const ref = new FakeMain(MAIN, ["drop"]);
    await withIntent(ref, async (h) => {
      const original = ref.update.bind(ref);
      let calls = 0;
      ref.update = async (expected, next) => {
        calls += 1;
        if (calls === 2) ref.main = CANDIDATE;
        return original(expected, next);
      };
      const result = await h.writer.publish(INTENT);

      expect(result).toEqual({ ok: true, value: settled("reconciled", 2, CANDIDATE) });
      expectOnlyConditional(ref);
    });
  });
});

describe("publish fences claims and decisions", () => {
  it("refuses when a claim changed owner since authorization, writing nothing", async () => {
    const world = new World();
    const ref = new FakeMain();
    await withIntent(
      ref,
      async (h) => {
        world.generations.set(CLAIM_B, 4);
        expect(await h.writer.publish(INTENT)).toMatchObject({
          ok: false,
          code: "stale_generation",
        });
        expect(ref.updates).toHaveLength(0);
        expect(h.authorization.record(INTENT)).toEqual(pendingRecord());
        expect(h.log.head()).toBe(1);
      },
      world,
    );
  });

  it("refuses when a decision has a new version or a new one became required", async () => {
    const world = new World();
    const ref = new FakeMain();
    await withIntent(
      ref,
      async (h) => {
        world.versions.set(CLAIM_A, [{ ...DEC_FORMAT, version: 2 }]);
        expect(await h.writer.publish(INTENT)).toMatchObject({
          ok: false,
          code: "decision_superseded",
        });
        world.versions.set(CLAIM_A, [DEC_FORMAT]);
        world.versions.set(CLAIM_B, [{ decisionId: "dec_limit001", version: 1 }]);
        expect(await h.writer.publish(INTENT)).toMatchObject({
          ok: false,
          code: "decision_superseded",
        });
        world.versions.set(CLAIM_B, null);
        expect(await h.writer.publish(INTENT)).toMatchObject({
          ok: false,
          code: "decision_superseded",
        });
        expect(ref.updates).toHaveLength(0);
        expect(h.authorization.record(INTENT)).toEqual(pendingRecord());
      },
      world,
    );
  });

  it("settles a write that landed even if the fence moved afterwards", async () => {
    const world = new World();
    const ref = new FakeMain(MAIN, ["crash-after"]);
    await withIntent(
      ref,
      async (h) => {
        await expect(h.writer.publish(INTENT)).rejects.toThrow("the object was reset");
        world.generations.set(CLAIM_A, 2);
        expect(await h.writer.publish(INTENT)).toEqual({
          ok: true,
          value: settled("reconciled", 1, CANDIDATE),
        });
      },
      world,
    );
  });
});

describe("publish fails closed", () => {
  it("leaves the intent to be reconciled when the ref refuses", async () => {
    const ref = new FakeMain(MAIN, ["refuse"]);
    await withIntent(ref, async (h) => {
      expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
      expect(h.authorization.record(INTENT)).toEqual(pendingRecord(1));
      expect(h.log.head()).toBe(1);

      // The next publication reads main first, then writes conditionally.
      expect(await h.writer.publish(INTENT)).toEqual({
        ok: true,
        value: settled("updated", 2, CANDIDATE),
      });
      expect(ref.reads).toBe(1);
      expectOnlyConditional(ref);
    });
  });

  it("does not write while main cannot be read back", async () => {
    const ref = new FakeMain(MAIN, ["drop"]);
    await withIntent(ref, async (h) => {
      ref.readFails = true;
      expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
      expect(ref.updates).toHaveLength(1);
      expect(h.authorization.record(INTENT)).toEqual(pendingRecord(1));
      expect(h.log.head()).toBe(1);
    });
  });

  it("writes nothing when a fence reader throws", async () => {
    const world = new World();
    const ref = new FakeMain();
    await withIntent(
      ref,
      async (h) => {
        world.versions = new Proxy(world.versions, {
          get() {
            throw new Error("decisions storage failed");
          },
        });
        await expect(h.writer.publish(INTENT)).rejects.toThrow("decisions storage failed");
        expect(ref.updates).toHaveLength(0);
        expect(h.authorization.record(INTENT)).toEqual(pendingRecord());
      },
      world,
    );
  });

  it(`refuses a publication beyond ${MAX_QUEUED_PUBLICATIONS} waiting as busy`, async () => {
    let open: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const release = (): void => open?.();
    const ref = new FakeMain();
    const original = ref.update.bind(ref);
    ref.update = async (expected, next) => {
      await gate;
      return original(expected, next);
    };
    await withIntent(ref, async (h) => {
      const waiting = Array.from({ length: MAX_QUEUED_PUBLICATIONS }, () =>
        h.writer.publish(INTENT),
      );
      expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "busy" });
      release();
      for (const result of await Promise.all(waiting)) {
        expect(result).toEqual({ ok: true, value: settled("updated", 1, CANDIDATE) });
      }
      expect(ref.updates).toHaveLength(1);
    });
  });
});

function unreachable(value: never): never {
  throw new Error(`unhandled step: ${String(value)}`);
}
