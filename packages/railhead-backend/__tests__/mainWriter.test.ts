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
import type { ReadyPin } from "../src/contracts/claims";
import { fail, ok, type PortResult } from "../src/contracts/result";
import type {
  AuthorizationPort,
  CheckAttempt,
  CheckReport,
  MainRefPort,
  MainUpdate,
  MainWriterPort,
  MergeIntentRecord,
} from "../src/contracts/train";
import { unavailableAuthorization } from "../src/contracts/unavailable";
import {
  createMainWriter,
  MAIN_REF_TIMEOUT_MS,
  MAIN_UPDATE_EXPIRY_MS,
  MAIN_UPDATE_LIFETIME_MS,
  MAX_QUEUED_PUBLICATIONS,
  MAX_WRITE_ATTEMPTS,
  type MainWriterDeps,
} from "../src/modules/mainWriter/mainWriter";
import { EventLog } from "../src/repo/eventLog";
import type { RepoStorage } from "../src/repo/storage";
import {
  createAuthorization,
  TRAIN_ACTOR,
  type AuthorizationReaders,
} from "../src/train/authorize";

const REPO = "rep_demo01";
const NOW = 1_790_000_000_000;
const ATTEMPT = "chk_attempt01";
const INTENT = "int_intent01";
const MAIN = "a".repeat(40);
const CANDIDATE = "c".repeat(40);
const OTHER = "e".repeat(40);
const ATTEMPT_B = "chk_attempt02";
const INTENT_B = "int_intent02";
const CANDIDATE_B = "b".repeat(40);
/** Short enough for a test to wait out, long enough for an answering fake to beat. */
const TIMEOUT_MS = 50;
const CLAIM_A: ClaimId = "clm_claim001";
const CLAIM_B: ClaimId = "clm_claim002";
const CLAIM_C: ClaimId = "clm_claim003";
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
  /** Runs once while the next read is in flight: after it observes main, before it answers. */
  duringRead: (() => void) | null = null;

  constructor(
    public main: CommitSha = MAIN,
    public steps: Step[] = [],
  ) {}

  async read(): Promise<PortResult<CommitSha>> {
    this.reads += 1;
    const seen = this.main;
    const during = this.duringRead;
    this.duringRead = null;
    during?.();
    return this.readFails ? fail("unavailable", "Git is not answering.") : ok(seen);
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

/** Current claim and decision state and time, which a test changes to model a concurrent write. */
class World {
  now = NOW;
  /** The decision the first intent's check proves, as an acceptance check. */
  acceptance: DecisionRef | null = null;
  /** Whether the first intent's check attempt can still be read. */
  attemptKnown = true;
  generations = new Map<ClaimId, number>([
    [CLAIM_A, 1],
    [CLAIM_B, 3],
    [CLAIM_C, 1],
  ]);
  versions = new Map<ClaimId, DecisionRef[] | null>([
    [CLAIM_A, [DEC_FORMAT]],
    [CLAIM_B, []],
    [CLAIM_C, []],
  ]);
  /** Each ready claim's pinned commit; a claim missing here is not ready. */
  ready = new Map<ClaimId, CommitSha>([
    [CLAIM_A, "1".repeat(40)],
    [CLAIM_B, "2".repeat(40)],
    [CLAIM_C, "3".repeat(40)],
  ]);

  /** The claim's ready pin, recorded under the versions current now. */
  readyPin(claimId: ClaimId): ReadyPin | null {
    const commit = this.ready.get(claimId);
    const generation = this.generations.get(claimId);
    const decisions = this.versions.get(claimId) ?? null;
    if (commit === undefined || generation === undefined || decisions === null) return null;
    return { pin: { claimId, generation, commit }, episode: 1, decisions };
  }
}

/** The second intent's attempt: claim C alone, composed on `expectedMain`. */
function attemptB(expectedMain: CommitSha): CheckAttempt {
  return {
    attemptId: ATTEMPT_B,
    expectedMain,
    candidate: CANDIDATE_B,
    pins: [{ claimId: CLAIM_C, generation: 1, commit: "3".repeat(40) }],
    definition: { name: "upload", source: expectedMain, digest: "d".repeat(64), acceptance: null },
    decisions: [],
    createdAt: NOW - 60_000,
  };
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

/** The attempt with a passing report recorded against it. */
function passed(checked: CheckAttempt): { attempt: CheckAttempt; report: CheckReport } {
  return {
    attempt: checked,
    report: {
      attemptId: checked.attemptId,
      candidate: checked.candidate,
      result: "pass",
      logDigest: null,
      finishedAt: NOW - 1_000,
    },
  };
}

/** The harness's options: where the second intent's attempt was composed, and the ref deadline. */
interface Options {
  secondExpected?: CommitSha;
  timeoutMs?: number;
}

function harness(
  storage: RepoStorage,
  world: World,
  ref: MainRefPort,
  options: Options = {},
): Harness {
  const clock = (): number => world.now;
  const log = EventLog.open(storage, REPO, clock);
  const readers: AuthorizationReaders = {
    attemptOutcome: (attemptId) => {
      if (attemptId === ATTEMPT && world.attemptKnown) {
        const first = attempt();
        const acceptance =
          world.acceptance === null ? null : { decision: world.acceptance, option: "yes" };
        return passed({ ...first, definition: { ...first.definition, acceptance } });
      }
      if (attemptId === ATTEMPT_B && options.secondExpected !== undefined) {
        return passed(attemptB(options.secondExpected));
      }
      return null;
    },
    currentGeneration: (claimId) => world.generations.get(claimId) ?? null,
    currentVersions: (claimId) => world.versions.get(claimId) ?? null,
    readyPin: (claimId) => world.readyPin(claimId),
  };
  const authorization: AuthorizationPort = createAuthorization(
    { storage, log, clock },
    readers,
    () => (authorization.record(INTENT) === null ? INTENT : INTENT_B),
  );
  const deps: MainWriterDeps = { authorization, ...readers };
  const writer = createMainWriter({ log, clock }, () => deps, ref, options.timeoutMs);
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
  options: Options = {},
): Promise<R> {
  return runInDurableObject(stub, async (_instance, state) => {
    const h = harness(state.storage, world, ref, options);
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

function mainEvent(
  seq: number,
  outcome: MainOutcome,
  main: CommitSha,
  intentId: string = INTENT,
  at: number = NOW,
): unknown {
  return {
    v: EVENT_SCHEMA_VERSION,
    seq,
    at,
    repo: REPO,
    actor: TRAIN_ACTOR,
    type: "train.main",
    data: { intentId, outcome, main },
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
        { log, clock: () => NOW },
        () => ({
          authorization: unavailableAuthorization,
          attemptOutcome: () => null,
          currentGeneration: () => null,
          currentVersions: () => null,
          readyPin: () => null,
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

  it(`stops one publication after ${MAX_WRITE_ATTEMPTS} unconfirmed attempts`, async () => {
    const ref = new FakeMain(
      MAIN,
      Array.from({ length: MAX_WRITE_ATTEMPTS }, () => "drop"),
    );
    await withIntent(ref, async (h) => {
      expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
      expect(ref.updates).toHaveLength(MAX_WRITE_ATTEMPTS);
      expect(h.authorization.record(INTENT)).toEqual(pendingRecord(MAX_WRITE_ATTEMPTS));
      expect(h.log.head()).toBe(1);

      // Git answers again: the next publication reads main back, then writes conditionally.
      const reads = ref.reads;
      expect(await h.writer.publish(INTENT)).toEqual({
        ok: true,
        value: settled("updated", MAX_WRITE_ATTEMPTS + 1, CANDIDATE),
      });
      expect(ref.reads).toBe(reads + 1);
      expect(ref.updates).toHaveLength(MAX_WRITE_ATTEMPTS + 1);
      expectOnlyConditional(ref);
      expect(mainEvents(h.log)).toEqual([mainEvent(2, "updated", CANDIDATE)]);
    });
  });

  it("settles a late landing found after a publication used its attempts", async () => {
    const ref = new FakeMain(
      MAIN,
      Array.from({ length: MAX_WRITE_ATTEMPTS }, () => "drop"),
    );
    await withIntent(ref, async (h) => {
      expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
      // One of those writes applies after its uncertain answer.
      ref.main = CANDIDATE;
      expect(await h.writer.publish(INTENT)).toEqual({
        ok: true,
        value: settled("reconciled", MAX_WRITE_ATTEMPTS, CANDIDATE),
      });
      expect(ref.updates).toHaveLength(MAX_WRITE_ATTEMPTS);
      expect(mainEvents(h.log)).toEqual([mainEvent(2, "reconciled", CANDIDATE)]);
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

  it("refuses when a claim is no longer ready with its pinned commit", async () => {
    const world = new World();
    const ref = new FakeMain();
    await withIntent(
      ref,
      async (h) => {
        world.ready.set(CLAIM_B, "9".repeat(40));
        expect(await h.writer.publish(INTENT)).toMatchObject({
          ok: false,
          code: "decision_superseded",
        });
        world.ready.delete(CLAIM_B);
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

  it("refuses when the decision its acceptance check proves is no longer required", async () => {
    const world = new World();
    world.acceptance = DEC_FORMAT;
    const ref = new FakeMain();
    await withIntent(
      ref,
      async (h) => {
        // Claim A no longer requires the decision; the authorized set still covers what remains.
        world.versions.set(CLAIM_A, []);
        expect(await h.writer.publish(INTENT)).toMatchObject({
          ok: false,
          code: "decision_superseded",
        });
        expect(ref.updates).toHaveLength(0);
        expect(h.authorization.record(INTENT)).toEqual(pendingRecord());
        expect(h.log.head()).toBe(1);
      },
      world,
    );
  });

  it("refuses when the check attempt the intent rests on cannot be read", async () => {
    const world = new World();
    const ref = new FakeMain();
    await withIntent(
      ref,
      async (h) => {
        world.attemptKnown = false;
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "check_mismatch" });
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

describe("publish holds a moved fence while the intent's own write may still land", () => {
  it("returns unavailable, writes nothing, and settles the write when it lands late", async () => {
    const world = new World();
    const ref = new FakeMain(MAIN, ["refuse"]);
    await withIntent(
      ref,
      async (h) => {
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        world.generations.set(CLAIM_B, 4);

        expect(await h.writer.publish(INTENT)).toEqual(
          fail("unavailable", "An earlier write of this intent may still land; try again."),
        );
        expect(ref.updates).toHaveLength(1);
        expect(h.authorization.record(INTENT)).toEqual(pendingRecord(1));
        expect(h.log.head()).toBe(1);

        // The first update reaches Git after all.
        ref.main = CANDIDATE;
        expect(await h.writer.publish(INTENT)).toEqual({
          ok: true,
          value: settled("reconciled", 1, CANDIDATE),
        });
        expect(ref.updates).toHaveLength(1);
        expect(mainEvents(h.log)).toEqual([mainEvent(2, "reconciled", CANDIDATE)]);
      },
      world,
    );
  });

  it("settles the intent as not landed once main moves past its expected commit", async () => {
    const world = new World();
    const ref = new FakeMain(MAIN, ["refuse"]);
    await withIntent(
      ref,
      async (h) => {
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        world.versions.set(CLAIM_A, [{ ...DEC_FORMAT, version: 2 }]);
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });

        ref.main = OTHER;
        expect(await h.writer.publish(INTENT)).toEqual({
          ok: true,
          value: settled("reconciled", 1, OTHER),
        });
        expect(ref.updates).toHaveLength(1);
        expect(mainEvents(h.log)).toEqual([mainEvent(2, "reconciled", OTHER)]);
      },
      world,
    );
  });

  it("does not refuse definitively when the fence moves during an uncertain write", async () => {
    const world = new World();
    const ref = new FakeMain(MAIN, ["drop"]);
    await withIntent(
      ref,
      async (h) => {
        const update = ref.update.bind(ref);
        ref.update = async (expected, next) => {
          world.generations.set(CLAIM_A, 2);
          return update(expected, next);
        };
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        expect(ref.updates).toHaveLength(1);
        expect(h.authorization.record(INTENT)).toEqual(pendingRecord(1));
      },
      world,
    );
  });
});

describe("publish ends the wait for an unsettled write after the update lifetime", () => {
  it("settles the intent as not landed once its last attempt is that old", async () => {
    const world = new World();
    const ref = new FakeMain(MAIN, ["refuse"]);
    await withIntent(
      ref,
      async (h) => {
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        world.generations.set(CLAIM_B, 4);

        // One millisecond short of the lifetime, the write may still land.
        world.now = NOW + MAIN_UPDATE_EXPIRY_MS - 1;
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        expect(h.authorization.record(INTENT)).toEqual(pendingRecord(1));

        world.now = NOW + MAIN_UPDATE_EXPIRY_MS;
        expect(await h.writer.publish(INTENT)).toEqual({
          ok: true,
          value: { ...settled("reconciled", 1, MAIN), updatedAt: world.now },
        });
        expect(ref.updates).toHaveLength(1);
        expect(mainEvents(h.log)).toEqual([mainEvent(2, "reconciled", MAIN, INTENT, world.now)]);
        // Settled for good: a repeat neither reads nor writes.
        const reads = ref.reads;
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: true, value: { main: MAIN } });
        expect(ref.reads).toBe(reads);
      },
      world,
    );
  });

  it("writes again instead when the fence still holds after the lifetime", async () => {
    const world = new World();
    const ref = new FakeMain(MAIN, ["refuse"]);
    await withIntent(
      ref,
      async (h) => {
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        world.now = NOW + MAIN_UPDATE_EXPIRY_MS;
        expect(await h.writer.publish(INTENT)).toMatchObject({
          ok: true,
          value: { status: "updated", attempts: 2, main: CANDIDATE },
        });
        expectOnlyConditional(ref);
        expect(outcomes(h.log)).toEqual([
          { intentId: INTENT, outcome: "updated", main: CANDIDATE },
        ]);
      },
      world,
    );
  });

  it("releases a write from another commit once the earlier write is that old", async () => {
    const world = new World();
    const ref = new FakeMain(MAIN, ["drop"]);
    await withIntent(
      ref,
      async (h) => {
        ref.readFails = true;
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        ref.readFails = false;
        await authorizeB(h);
        expect(await h.writer.publish(INTENT_B)).toMatchObject({ ok: false, code: "unavailable" });

        // A never landed, so B, composed on A's candidate, is rejected rather than held.
        world.now = NOW + MAIN_UPDATE_EXPIRY_MS;
        expect(await h.writer.publish(INTENT_B)).toMatchObject({
          ok: true,
          value: { intentId: INTENT_B, status: "rejected", main: MAIN },
        });
        expect(ref.updates).toEqual([
          { expected: MAIN, next: CANDIDATE },
          { expected: CANDIDATE, next: CANDIDATE_B },
        ]);
        expect(outcomes(h.log)).toEqual([
          { intentId: INTENT, outcome: "reconciled", main: MAIN },
          { intentId: INTENT_B, outcome: "rejected", main: MAIN },
        ]);
      },
      world,
      freshStub(),
      { secondExpected: CANDIDATE },
    );
  });
});

describe("publish waits out an update the ref sends late", () => {
  it("does not settle the intent before a delayed send can no longer land", async () => {
    const world = new World();
    const ref = new FakeMain();
    // The ref queues the update and sends it just inside its send bound; Git applies it just
    // inside its lifetime from that send.
    let queued: { expected: CommitSha; next: CommitSha } | undefined;
    await withIntent(
      ref,
      async (h) => {
        ref.update = (expected, next) => {
          ref.updates.push({ expected, next });
          queued = { expected, next };
          return new Promise(() => undefined);
        };
        expect(await h.writer.publish(INTENT)).toEqual(
          fail("unavailable", "Main did not answer in time; it will be read back first."),
        );
        world.generations.set(CLAIM_B, 4);
        const sentAt = NOW + MAIN_REF_TIMEOUT_MS - 1;

        // A lifetime after the call, the sent update may still apply: nothing settles.
        world.now = NOW + MAIN_UPDATE_LIFETIME_MS;
        expect(await h.writer.publish(INTENT)).toEqual(
          fail("unavailable", "An earlier write of this intent may still land; try again."),
        );
        world.now = NOW + MAIN_UPDATE_EXPIRY_MS - 1;
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        expect(h.authorization.record(INTENT)).toEqual(pendingRecord(1));
        expect(h.log.head()).toBe(1);

        // The update lands within its lifetime from the send.
        world.now = sentAt + MAIN_UPDATE_LIFETIME_MS - 1;
        if (queued !== undefined && ref.main === queued.expected) ref.main = queued.next;
        world.now = NOW + MAIN_UPDATE_EXPIRY_MS;
        expect(await h.writer.publish(INTENT)).toEqual({
          ok: true,
          value: { ...settled("reconciled", 1, CANDIDATE), updatedAt: world.now },
        });
        // The record and its event agree with main.
        expect(h.authorization.record(INTENT)).toMatchObject({ main: ref.main });
        expect(mainEvents(h.log)).toEqual([
          mainEvent(2, "reconciled", CANDIDATE, INTENT, world.now),
        ]);
        expect(ref.updates).toHaveLength(1);
      },
      world,
      freshStub(),
      { timeoutMs: TIMEOUT_MS },
    );
  });
});

/** Main is read just before the lifetime ends; `apply` runs before the answer arrives after it. */
function readAcrossExpiry(world: World, ref: FakeMain, apply: () => void): void {
  world.now = NOW + MAIN_UPDATE_EXPIRY_MS - 1_000;
  ref.duringRead = () => {
    apply();
    world.now = NOW + MAIN_UPDATE_EXPIRY_MS + 500;
  };
}

describe("publish settles a write as not landed only from a read begun after its lifetime", () => {
  it("records a write that lands during a read begun before expiry as landed", async () => {
    const world = new World();
    const ref = new FakeMain(MAIN, ["refuse"]);
    await withIntent(
      ref,
      async (h) => {
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        world.generations.set(CLAIM_B, 4);

        // The read sees the expected commit; the update lands within its lifetime before the
        // stale answer arrives after it.
        readAcrossExpiry(world, ref, () => {
          ref.main = CANDIDATE;
        });
        const reads = ref.reads;
        expect(await h.writer.publish(INTENT)).toEqual({
          ok: true,
          value: { ...settled("reconciled", 1, CANDIDATE), updatedAt: world.now },
        });
        expect(ref.reads).toBe(reads + 2);
        expect(ref.updates).toHaveLength(1);
        expect(mainEvents(h.log)).toEqual([
          mainEvent(2, "reconciled", CANDIDATE, INTENT, world.now),
        ]);
      },
      world,
    );
  });

  it("settles a write that never lands from a second read begun after expiry", async () => {
    const world = new World();
    const ref = new FakeMain(MAIN, ["refuse"]);
    await withIntent(
      ref,
      async (h) => {
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        world.generations.set(CLAIM_B, 4);

        let readsBegun: number[] = [];
        readAcrossExpiry(world, ref, () => undefined);
        const read = ref.read.bind(ref);
        ref.read = async () => {
          readsBegun = [...readsBegun, world.now];
          return read();
        };
        expect(await h.writer.publish(INTENT)).toEqual({
          ok: true,
          value: { ...settled("reconciled", 1, MAIN), updatedAt: world.now },
        });
        // The settling read began after the lifetime ended; the one before it proved nothing.
        expect(readsBegun).toEqual([
          NOW + MAIN_UPDATE_EXPIRY_MS - 1_000,
          NOW + MAIN_UPDATE_EXPIRY_MS + 500,
        ]);
        expect(ref.updates).toHaveLength(1);
        expect(mainEvents(h.log)).toEqual([mainEvent(2, "reconciled", MAIN, INTENT, world.now)]);
      },
      world,
    );
  });

  it("records an earlier intent's late landing before another intent writes past it", async () => {
    const world = new World();
    const ref = new FakeMain(MAIN, ["drop"]);
    await withIntent(
      ref,
      async (h) => {
        ref.readFails = true;
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        ref.readFails = false;
        await authorizeB(h);

        readAcrossExpiry(world, ref, () => {
          ref.main = CANDIDATE;
        });
        expect(await h.writer.publish(INTENT_B)).toMatchObject({
          ok: true,
          value: { intentId: INTENT_B, status: "updated", main: CANDIDATE_B },
        });
        expect(ref.updates).toEqual([
          { expected: MAIN, next: CANDIDATE },
          { expected: CANDIDATE, next: CANDIDATE_B },
        ]);
        expect(outcomes(h.log)).toEqual([
          { intentId: INTENT, outcome: "reconciled", main: CANDIDATE },
          { intentId: INTENT_B, outcome: "updated", main: CANDIDATE_B },
        ]);
      },
      world,
      freshStub(),
      { secondExpected: CANDIDATE },
    );
  });

  it("settles an earlier intent that never landed only after reading main again", async () => {
    const world = new World();
    const ref = new FakeMain(MAIN, ["drop"]);
    await withIntent(
      ref,
      async (h) => {
        ref.readFails = true;
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        ref.readFails = false;
        await authorizeB(h);

        readAcrossExpiry(world, ref, () => undefined);
        const reads = ref.reads;
        expect(await h.writer.publish(INTENT_B)).toMatchObject({
          ok: true,
          value: { intentId: INTENT_B, status: "rejected", main: MAIN },
        });
        expect(ref.reads).toBe(reads + 2);
        expect(outcomes(h.log)).toEqual([
          { intentId: INTENT, outcome: "reconciled", main: MAIN },
          { intentId: INTENT_B, outcome: "rejected", main: MAIN },
        ]);
      },
      world,
      freshStub(),
      { secondExpected: CANDIDATE },
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

/** Every `train.main` outcome recorded so far, in log order. */
function outcomes(log: EventLog): unknown[] {
  return log
    .replay(0, 50)
    .events.filter((event) => event.type === "train.main")
    .map((event) => event.data);
}

/** Authorizes the second intent, composed on `expectedMain`. */
async function authorizeB(h: Harness): Promise<void> {
  expect(await h.authorization.authorize(ATTEMPT_B)).toMatchObject({
    ok: true,
    value: { intentId: INTENT_B, status: "authorized" },
  });
}

describe("publish settles an earlier unresolved write before another intent writes", () => {
  it("records the earlier landing before a later intent moves main past it", async () => {
    // A lands but its answer is lost and main cannot be read back; B was composed on A's
    // candidate, as a `head()` read during that window would allow.
    const ref = new FakeMain(MAIN, ["lose"]);
    await withIntent(
      ref,
      async (h) => {
        ref.readFails = true;
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        expect(ref.main).toBe(CANDIDATE);
        await authorizeB(h);

        // B may not write while A's write cannot be read back.
        expect(await h.writer.publish(INTENT_B)).toMatchObject({ ok: false, code: "unavailable" });
        expect(ref.updates).toHaveLength(1);
        expect(h.authorization.record(INTENT)).toEqual(pendingRecord(1));

        ref.readFails = false;
        expect(await h.writer.publish(INTENT_B)).toMatchObject({
          ok: true,
          value: { intentId: INTENT_B, status: "updated", main: CANDIDATE_B },
        });
        expect(ref.updates).toEqual([
          { expected: MAIN, next: CANDIDATE },
          { expected: CANDIDATE, next: CANDIDATE_B },
        ]);
        expect(outcomes(h.log)).toEqual([
          { intentId: INTENT, outcome: "reconciled", main: CANDIDATE },
          { intentId: INTENT_B, outcome: "updated", main: CANDIDATE_B },
        ]);
        // A stays recorded as landed; a repeat neither reads nor writes.
        expect(await h.writer.publish(INTENT)).toEqual({
          ok: true,
          value: settled("reconciled", 1, CANDIDATE),
        });
        expect(ref.updates).toHaveLength(2);
      },
      new World(),
      freshStub(),
      { secondExpected: CANDIDATE },
    );
  });

  it("finds the earlier landing after the object is recreated", async () => {
    const stub = freshStub();
    const ref = new FakeMain(MAIN, ["crash-after"]);
    await withIntent(
      ref,
      async (h) => {
        await expect(h.writer.publish(INTENT)).rejects.toThrow("the object was reset");
        await authorizeB(h);
      },
      new World(),
      stub,
      { secondExpected: CANDIDATE },
    );
    await evictDurableObject(stub);

    const after = new FakeMain(ref.main);
    await runInDurableObject(stub, async (_instance, state) => {
      const h = harness(state.storage, new World(), after, { secondExpected: CANDIDATE });
      expect(await h.writer.publish(INTENT_B)).toMatchObject({
        ok: true,
        value: { intentId: INTENT_B, status: "updated", main: CANDIDATE_B },
      });
      expect(after.updates).toEqual([{ expected: CANDIDATE, next: CANDIDATE_B }]);
      expect(outcomes(h.log)).toEqual([
        { intentId: INTENT, outcome: "reconciled", main: CANDIDATE },
        { intentId: INTENT_B, outcome: "updated", main: CANDIDATE_B },
      ]);
    });
  });

  it("holds a write from another commit while the earlier write may still land", async () => {
    const stub = freshStub();
    const ref = new FakeMain(MAIN, ["drop"]);
    await withIntent(
      ref,
      async (h) => {
        ref.readFails = true;
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        await authorizeB(h);
      },
      new World(),
      stub,
      { secondExpected: CANDIDATE },
    );
    await evictDurableObject(stub);

    const after = new FakeMain(MAIN);
    await runInDurableObject(stub, async (_instance, state) => {
      const h = harness(state.storage, new World(), after, { secondExpected: CANDIDATE });
      // Main is still at A's expected commit, so A's write may yet apply: B does not write.
      expect(await h.writer.publish(INTENT_B)).toMatchObject({ ok: false, code: "unavailable" });
      expect(after.updates).toHaveLength(0);
      expect(h.authorization.record(INTENT_B)).toMatchObject({ status: "authorized", attempts: 0 });

      // A's write lands late; B's next publication records it before writing on top of it.
      after.main = CANDIDATE;
      expect(await h.writer.publish(INTENT_B)).toMatchObject({
        ok: true,
        value: { status: "updated", main: CANDIDATE_B },
      });
      expect(outcomes(h.log)).toEqual([
        { intentId: INTENT, outcome: "reconciled", main: CANDIDATE },
        { intentId: INTENT_B, outcome: "updated", main: CANDIDATE_B },
      ]);
    });
  });

  it("lets a write from the same commit proceed and settles the earlier one as not landed", async () => {
    // A's attempts are used up with main still at its expected commit. B was composed on the
    // same commit, so its conditional write and A's can never both apply.
    const ref = new FakeMain(
      MAIN,
      Array.from({ length: MAX_WRITE_ATTEMPTS }, () => "drop"),
    );
    await withIntent(
      ref,
      async (h) => {
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        await authorizeB(h);

        expect(await h.writer.publish(INTENT_B)).toMatchObject({
          ok: true,
          value: { status: "updated", main: CANDIDATE_B },
        });
        expect(ref.updates.at(-1)).toEqual({ expected: MAIN, next: CANDIDATE_B });
        expect(await h.writer.publish(INTENT)).toEqual({
          ok: true,
          value: settled("reconciled", MAX_WRITE_ATTEMPTS, CANDIDATE_B),
        });
        expect(outcomes(h.log)).toEqual([
          { intentId: INTENT_B, outcome: "updated", main: CANDIDATE_B },
          { intentId: INTENT, outcome: "reconciled", main: CANDIDATE_B },
        ]);
      },
      new World(),
      freshStub(),
      { secondExpected: MAIN },
    );
  });

  it("rejects the later write when the earlier one lands first, and records both", async () => {
    const ref = new FakeMain(MAIN, ["drop"]);
    await withIntent(
      ref,
      async (h) => {
        ref.readFails = true;
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        ref.readFails = false;
        await authorizeB(h);
        // A's write lands between B's read-back and B's conditional write.
        const original = ref.update.bind(ref);
        ref.update = async (expected, next) => {
          ref.main = CANDIDATE;
          return original(expected, next);
        };

        expect(await h.writer.publish(INTENT_B)).toMatchObject({
          ok: true,
          value: { status: "rejected", main: CANDIDATE },
        });
        expect(await h.writer.publish(INTENT)).toEqual({
          ok: true,
          value: settled("reconciled", 1, CANDIDATE),
        });
        expect(outcomes(h.log)).toEqual([
          { intentId: INTENT_B, outcome: "rejected", main: CANDIDATE },
          { intentId: INTENT, outcome: "reconciled", main: CANDIDATE },
        ]);
      },
      new World(),
      freshStub(),
      { secondExpected: MAIN },
    );
  });
});

describe("publish bounds every call to main's ref", () => {
  it("refuses within the deadline when a read-back never answers, writing nothing", async () => {
    const ref = new FakeMain(MAIN, ["drop", "drop"]);
    await withIntent(
      ref,
      async (h) => {
        ref.read = () => new Promise(() => undefined);
        const started = Date.now();
        // The first attempt is uncertain; its read-back hangs.
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 10);
        expect(ref.updates).toHaveLength(1);
        expect(h.authorization.record(INTENT)).toEqual(pendingRecord(1));
        expect(h.log.head()).toBe(1);
      },
      new World(),
      freshStub(),
      { timeoutMs: TIMEOUT_MS },
    );
  });

  it("keeps a timed-out write unresolved and frees the queue for the next publication", async () => {
    let answer: ((result: PortResult<MainUpdate>) => void) | undefined;
    const ref = new FakeMain();
    await withIntent(
      ref,
      async (h) => {
        ref.update = (expected, next) => {
          ref.updates.push({ expected, next });
          return new Promise((resolve) => {
            answer = resolve;
          });
        };
        await authorizeB(h);
        const first = h.writer.publish(INTENT);
        const queued = h.writer.publish(INTENT_B);

        expect(await first).toMatchObject({ ok: false, code: "unavailable" });
        expect(h.authorization.record(INTENT)).toEqual(pendingRecord(1));
        // B was composed on A's candidate: it waits, then is held without writing.
        expect(await queued).toMatchObject({ ok: false, code: "unavailable" });
        expect(ref.updates).toEqual([{ expected: MAIN, next: CANDIDATE }]);

        // The write lands and answers after the deadline; the late answer is dropped, and the
        // next publication reads main back instead.
        ref.main = CANDIDATE;
        answer?.(ok({ kind: "updated" }));
        expect(h.authorization.record(INTENT)).toEqual(pendingRecord(1));
        ref.update = FakeMain.prototype.update.bind(ref);
        expect(await h.writer.publish(INTENT_B)).toMatchObject({
          ok: true,
          value: { status: "updated", main: CANDIDATE_B },
        });
        expect(outcomes(h.log)).toEqual([
          { intentId: INTENT, outcome: "reconciled", main: CANDIDATE },
          { intentId: INTENT_B, outcome: "updated", main: CANDIDATE_B },
        ]);
      },
      new World(),
      freshStub(),
      { secondExpected: CANDIDATE, timeoutMs: TIMEOUT_MS },
    );
  });

  it("ignores a failure that arrives after the deadline", async () => {
    let refuse: ((reason: Error) => void) | undefined;
    const ref = new FakeMain();
    await withIntent(
      ref,
      async (h) => {
        ref.update = () =>
          new Promise((_resolve, reject) => {
            refuse = reject;
          });
        expect(await h.writer.publish(INTENT)).toMatchObject({ ok: false, code: "unavailable" });
        refuse?.(new Error("the connection reset"));
        ref.update = FakeMain.prototype.update.bind(ref);
        expect(await h.writer.publish(INTENT)).toEqual({
          ok: true,
          value: settled("updated", 2, CANDIDATE),
        });
      },
      new World(),
      freshStub(),
      { timeoutMs: TIMEOUT_MS },
    );
  });
});

function unreachable(value: never): never {
  throw new Error(`unhandled step: ${String(value)}`);
}
