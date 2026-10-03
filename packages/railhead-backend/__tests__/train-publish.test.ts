// The train, authorization and main writer together, over one Repo's storage. Only Git's main ref
// and the sandbox-backed ports are fakes: every intent, attempt count, batch and event comes from
// the real modules.

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { CommitSha, RailheadEvent } from "@railhead/shared/events";
import type { ClaimPin, ReadyPin } from "../src/contracts/claims";
import type { ReadyGate } from "../src/contracts/inbox";
import { fail, ok, type PortResult } from "../src/contracts/result";
import type {
  AuthorizationPort,
  CheckAttempt,
  MainRefPort,
  MainUpdate,
  MainWriterPort,
} from "../src/contracts/train";
import {
  createMainWriter,
  MAIN_UPDATE_EXPIRY_MS,
  MAX_WRITE_ATTEMPTS,
} from "../src/modules/mainWriter/mainWriter";
import {
  createTrain,
  EXHAUSTED_FAILURES,
  MAX_WAKE_FAILURES,
  SETTLE_WAKE_MS,
  STARTUP_WAKE_ATTEMPTS,
  type Train,
} from "../src/modules/train/scheduler";
import { readEntry, readWake, writeWake } from "../src/modules/train/store";
import {
  composeRepo,
  resumables,
  resumeAll,
  type RepoContext,
  type RepoPorts,
} from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { EarliestAlarm, type AlarmStorage } from "../src/repo/storage";
import { createAuthorization } from "../src/train/authorize";
import { queueing, type QueueingTrain } from "./trainQueue";

const REPO_ID = "rep_publish01";
const MAIN = "1".repeat(40);
const ELSEWHERE = "e".repeat(40);
/** Short enough for a test to wait out. */
const REF_TIMEOUT_MS = 50;

/** An attempt's pins without the ready episodes they are fenced to. */
function pinsOf(attempt: { pins: readonly ClaimPin[] } | undefined): ClaimPin[] | undefined {
  return attempt?.pins.map(({ claimId, generation, commit }) => ({ claimId, generation, commit }));
}

function pin(n: number): ClaimPin {
  return { claimId: `clm_claim${String(n).padStart(3, "0")}`, generation: 1, commit: sha(n) };
}

function sha(n: number): CommitSha {
  return n.toString(16).padStart(2, "0").repeat(20);
}

/** A distinct candidate for each main and pin list, as a real merge would produce. */
function candidateOf(main: CommitSha, pins: ClaimPin[]): CommitSha {
  const key = `${main}:${pins.map((p) => `${p.claimId}@${p.generation}:${p.commit}`).join(",")}`;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0").repeat(5);
}

/** How the fake ref answers one conditional update. */
type Step =
  /** Applies the update if main is at the expected commit, and says what happened. */
  | "honest"
  /** Applies nothing and reports an uncertain outcome. */
  | "drop"
  /** The ref refuses without effect. */
  | "refuse"
  /** Never answers; `release` later applies it, conditionally, as Git would a late request. */
  | "hang";

/** A Git ref with compare-and-swap semantics. It never moves main from anything but `expected`. */
class FakeMain implements MainRefPort {
  updates: { expected: CommitSha; next: CommitSha }[] = [];
  /** Updates that have not reached Git yet, oldest first. */
  readonly late: (() => void)[] = [];
  /** How every update past `steps` answers. */
  fallback: Step = "honest";
  /** Runs once while the next read is in flight: after it observes main, before it answers. */
  duringRead: (() => void) | null = null;
  /** While true, Git answers neither reads nor updates. */
  down = false;

  constructor(
    public main: CommitSha,
    public steps: Step[] = [],
  ) {}

  async read(): Promise<PortResult<CommitSha>> {
    if (this.down) return fail("unavailable", "Git is down.");
    const seen = this.main;
    const during = this.duringRead;
    this.duringRead = null;
    during?.();
    return ok(seen);
  }

  async update(expected: CommitSha, next: CommitSha): Promise<PortResult<MainUpdate>> {
    if (this.down) return fail("unavailable", "Git is down.");
    this.updates.push({ expected, next });
    const step = this.steps.shift() ?? this.fallback;
    switch (step) {
      case "honest":
        if (this.main !== expected) return ok({ kind: "rejected", actual: this.main });
        this.main = next;
        return ok({ kind: "updated" });
      case "drop":
        return ok({ kind: "uncertain" });
      case "refuse":
        return fail("unavailable", "Git refused the connection.");
      case "hang":
        return new Promise<never>(() => {
          this.late.push(() => {
            if (this.main === expected) this.main = next;
          });
        });
      default:
        return unreachable(step);
    }
  }

  /** Lets the oldest outstanding update reach Git. */
  release(): void {
    const apply = this.late.shift();
    if (apply === undefined) throw new Error("no update is outstanding");
    apply();
  }
}

interface Harness {
  train: QueueingTrain;
  ref: FakeMain;
  authorization: AuthorizationPort;
  /** Each claim's current pin; a test replaces one to model a change of owner. */
  claims: Map<string, ClaimPin>;
  /** Inbox gates that override the real inbox's, by claim; a test sets one to block a claim. */
  gates: Map<string, ReadyGate>;
  started: CheckAttempt[];
  events(): RailheadEvent[];
  sql: SqlStorage;
  /** Moves the clock past the wake the train owes, then runs the Repo's alarm for it. */
  alarm(): Promise<void>;
  /** The Repo's clock, without advancing it. */
  now(): number;
  /** Moves the Repo's clock forward to `at`. */
  advance(at: number): void;
  /** Every time the Repo's alarm was asked for, oldest first. */
  wakes: number[];
  /** Builds another train over the same storage, as a restarted `Repo` does, and uses it. */
  restart(): QueueingTrain;
  /**
   * Queues `pin` as `ready` does, as the claim's first ready episode, without driving: it waits for
   * the next drive.
   */
  queue(pin: ClaimPin): PortResult<{ queued: boolean }>;
  /** How many of the next composes refuse as `unavailable`. */
  composeFailures: number;
  /** The alarm time the object's storage holds, or `null`. */
  storedAlarm(): Promise<number | null>;
  /**
   * Moves the clock to the stored alarm and runs what the Repo's alarm handler runs: marks the
   * alarm fired, resumes every module and waits for the wakes they asked for. Only with
   * `realAlarm`.
   */
  fireAlarm(): Promise<void>;
}

/** The Repo a harness runs in: a fresh one by default. */
interface RepoTarget {
  stub: DurableObjectStub;
  /**
   * Whether wakes reach the object's storage alarm, as the Repo's do, rather than a list only. The
   * clock then starts a day ahead of real time, so the runtime never fires a stored alarm itself.
   */
  realAlarm: boolean;
  /** How many of the first storage alarm writes reject, as a storage fault would. */
  failedAlarmWrites?: number;
  /** How many of the first merge intent reads throw, as a storage fault would. */
  failedIntentReads?: number;
}

/**
 * Runs `body` against the real train, authorization and main writer of a fresh Repo, or of
 * `target`. Claims answer with the pins given, decisions require nothing, merges are clean and
 * every check start is acknowledged.
 */
function withRepo<R>(
  ref: FakeMain,
  pins: ClaimPin[],
  body: (h: Harness) => Promise<R>,
  target: RepoTarget = { stub: env.REPO.getByName(crypto.randomUUID()), realAlarm: false },
): Promise<R> {
  const { stub, realAlarm } = target;
  let failedWrites = target.failedAlarmWrites ?? 0;
  let failedReads = target.failedIntentReads ?? 0;
  return runInDurableObject(stub, async (_instance, state) => {
    let now = realAlarm ? Date.now() + 24 * 60 * 60_000 : 1_000;
    const log = EventLog.open(state.storage, REPO_ID, () => now);
    const alarmStorage: AlarmStorage = {
      getAlarm: (options) => state.storage.getAlarm(options),
      setAlarm: async (at, options) => {
        if (failedWrites > 0) {
          failedWrites -= 1;
          throw new Error("alarm write failed");
        }
        return state.storage.setAlarm(at, options);
      },
    };
    const alarm = new EarliestAlarm(alarmStorage, () => {});
    if (realAlarm) await alarm.load();
    const context: RepoContext = {
      repoId: REPO_ID,
      storage: state.storage,
      log,
      clock: () => (now += 1),
      env,
      wake: async (at) => {
        wakes.push(at);
        return realAlarm ? alarm.request(at) : true;
      },
    };
    const wakes: number[] = [];
    const current = new Map(pins.map((p) => [p.claimId, p]));
    const currentGeneration = (claimId: string): number | null =>
      current.get(claimId)?.generation ?? null;
    const currentVersions = (claimId: string): [] | null => (current.has(claimId) ? [] : null);
    const started: CheckAttempt[] = [];
    const real = composeRepo(context);
    const readyPin = (claimId: string): ReadyPin | null => {
      const found = current.get(claimId);
      const entry =
        found === undefined ? null : readEntry(state.storage.sql, claimId, found.generation);
      return found === undefined || entry === null
        ? null
        : { pin: found, episode: entry.episode, decisions: [] };
    };
    const gates = new Map<string, ReadyGate>();
    const readyGateNow = (claimId: string, generation: number): ReadyGate | null =>
      gates.get(claimId) ?? real.inbox.readyGateNow(claimId, generation);
    const readers = {
      attemptOutcome: (attemptId: string) => train.attemptOutcome(attemptId),
      currentGeneration,
      currentVersions,
      readyPin,
      readyGateNow,
    };
    const authorization = createAuthorization(context, readers);
    const mainWriter: MainWriterPort = createMainWriter(
      context,
      () => ({ authorization, ...readers }),
      ref,
      REF_TIMEOUT_MS,
    );
    const ports: RepoPorts = {
      ...real,
      inbox: { ...real.inbox, readyGateNow },
      claims: {
        ...real.claims,
        // As the real pin, refused while the claim's inbox gate blocks. Without it a requeued entry
        // whose gate blocks is neither formed nor dropped, and each drive spins through `MAX_STEPS`.
        pin: async (claimId) => {
          const found = current.get(claimId);
          if (found === undefined) return fail("not_found", "No such claim.");
          if (gates.get(claimId)?.kind === "blocked") {
            return fail(
              "unacked_decision",
              "An inbox item affecting the claim is not acknowledged.",
            );
          }
          return ok(found);
        },
        currentGeneration,
        readyPin,
      },
      decisions: { ...real.decisions, requirements: async () => ok([]), currentVersions },
      merge: {
        compose: async (main, composed) => {
          if (harness.composeFailures > 0) {
            harness.composeFailures -= 1;
            return fail("unavailable", "The merge service is down.");
          }
          return ok({ kind: "clean", candidate: candidateOf(main, composed) });
        },
        discard: async () => ok({ removed: 1 }),
      },
      checks: {
        definitions: async (main) =>
          ok([{ name: "test", source: main, digest: "d".repeat(64), acceptance: null }]),
        start: async (attempt) => {
          started.push(attempt);
          return ok({ attemptId: attempt.attemptId });
        },
        // Reports reach the train through `recordCheck` in these tests.
        report: async () => fail("unavailable", "Not used."),
        detail: async () => fail("unavailable", "Not used."),
      },
      authorization: {
        ...authorization,
        record: (intentId) => {
          if (failedReads > 0) {
            failedReads -= 1;
            throw new Error("intent read failed");
          }
          return authorization.record(intentId);
        },
      },
      mainWriter,
    };
    let train = queueing(
      createTrain(context, () => ports),
      log,
    );
    const harness: Harness = {
      get train() {
        return train;
      },
      ref,
      authorization,
      claims: current,
      gates,
      started,
      events: () => log.replay(0, 256).events,
      sql: state.storage.sql,
      alarm: async () => {
        const wake = readWake(state.storage.sql);
        if (wake === null) throw new Error("the train owes no drive");
        now = Math.max(now, wake.dueAt);
        await train.resume();
      },
      now: () => now,
      advance: (at) => {
        now = Math.max(now, at);
      },
      wakes,
      restart: () => {
        train = queueing(
          createTrain(context, () => ports),
          log,
        );
        return train;
      },
      queue: (queued) => log.transaction((tx) => train.queue(tx, queued, 1)).value,
      composeFailures: 0,
      storedAlarm: () => state.storage.getAlarm(),
      async fireAlarm() {
        if (!realAlarm) throw new Error("this harness has no storage alarm");
        const at = await state.storage.getAlarm();
        if (at === null) throw new Error("storage holds no alarm");
        now = Math.max(now, at);
        alarm.fired();
        // The train here is this harness's, not the composition's.
        await resumeAll(context, resumables({ ...ports, train }));
        await alarm.settle();
      },
    };
    return body(harness);
  });
}

/** Records a pass for the latest started attempt and returns it. */
async function pass(h: Harness): Promise<CheckAttempt> {
  const attempt = h.started.at(-1);
  if (attempt === undefined) throw new Error("no check was started");
  const recorded = await h.train.recordCheck({
    attemptId: attempt.attemptId,
    candidate: attempt.candidate,
    result: "pass",
    logDigest: null,
    finishedAt: attempt.createdAt,
  });
  expect(recorded).toEqual(ok(attempt));
  return attempt;
}

/**
 * Runs `train.startup()` with its retry backoff on a controlled clock, so a loaded runner cannot
 * spend the test's time limit on real sleeps. The clock jumps only to a sleep already scheduled.
 */
async function startupOnFakeTimers(train: Train): Promise<boolean> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const startup = { settled: false };
    const started = train.startup().finally(() => {
      startup.settled = true;
    });
    while (!startup.settled) await vi.advanceTimersToNextTimerAsync();
    return await started;
  } finally {
    vi.useRealTimers();
  }
}

/** The intent of the newest batch; fails the test when it has none. */
function latestIntent(train: Train): string {
  const intentId = train.batches(1)[0]?.intentId;
  if (intentId === null || intentId === undefined) throw new Error("no intent was recorded");
  return intentId;
}

function states(train: Train): Record<string, string> {
  return Object.fromEntries(train.entries(64).map((entry) => [entry.pin.claimId, entry.state]));
}

function batchStates(train: Train): [string, string | null][] {
  return train
    .batches(64)
    .map((batch): [string, string | null] => [batch.state, batch.failure])
    .toReversed();
}

/** The `train.main` outcomes in the log, oldest first. */
function mainOutcomes(events: RailheadEvent[]): unknown[] {
  return events.filter((event) => event.type === "train.main").map((event) => event.data);
}

describe("the train publishes through the real main writer", () => {
  it("lands the batch and the queued work once Git recovers, past a late update", async () => {
    const ref = new FakeMain(MAIN, [
      ...Array.from({ length: MAX_WRITE_ATTEMPTS }, (): Step => "drop"),
      "refuse",
      "hang",
    ]);
    await withRepo(ref, [pin(1), pin(2)], async (h) => {
      await h.train.enqueue(pin(1));
      await h.train.enqueue(pin(2));
      const first = await pass(h);
      const intentId = latestIntent(h.train);

      // Every write so far applied nothing: the intent stays authorized under the active batch.
      expect(ref.updates).toHaveLength(MAX_WRITE_ATTEMPTS);
      expect(h.authorization.record(intentId)).toMatchObject({
        status: "authorized",
        attempts: MAX_WRITE_ATTEMPTS,
      });
      expect(readWake(h.sql)).toMatchObject({ failures: 1 });

      // The alarm retries after its backoff: the ref refuses, then an update never answers.
      await h.alarm();
      await h.alarm();
      expect(ref.updates).toHaveLength(MAX_WRITE_ATTEMPTS + 2);
      expect(ref.late).toHaveLength(1);
      expect(readWake(h.sql)).toMatchObject({ failures: 3 });
      expect(states(h.train)).toEqual({ clm_claim001: "batched", clm_claim002: "queued" });

      // Git answers again. The next drive reads main back and writes conditionally.
      await h.alarm();
      expect(ref.main).toBe(first.candidate);
      expect(h.authorization.record(intentId)).toMatchObject({
        status: "updated",
        attempts: MAX_WRITE_ATTEMPTS + 3,
        main: first.candidate,
      });

      // The outstanding update reaches Git late; it is conditional on a commit main has left.
      h.ref.release();
      expect(ref.main).toBe(first.candidate);

      // The queued pin composes on the new main and lands.
      const second = await pass(h);
      expect(second.expectedMain).toBe(first.candidate);
      expect(ref.main).toBe(second.candidate);
      expect(states(h.train)).toEqual({ clm_claim001: "landed", clm_claim002: "landed" });
      expect(batchStates(h.train)).toEqual([
        ["landed", null],
        ["landed", null],
      ]);
      expect(mainOutcomes(h.events())).toEqual([
        { intentId, outcome: "updated", main: first.candidate },
        { intentId: expect.stringMatching(/^int_/), outcome: "updated", main: second.candidate },
      ]);
      expect(readWake(h.sql)).toBeNull();
      for (const update of ref.updates.slice(0, -1)) {
        expect(update).toEqual({ expected: MAIN, next: first.candidate });
      }
    });
  });

  it("keeps retrying, bounded per drive, while Git stays down", async () => {
    const ref = new FakeMain(MAIN);
    ref.fallback = "drop";
    await withRepo(ref, [pin(1)], async (h) => {
      await h.train.enqueue(pin(1));
      await pass(h);
      for (let drive = 2; drive <= 4; drive += 1) {
        await h.alarm();
        expect(ref.updates).toHaveLength(drive * MAX_WRITE_ATTEMPTS);
        // Each failed drive counts toward the alarm's backoff; none settles the batch.
        expect(readWake(h.sql)).toMatchObject({ failures: drive });
      }
      expect(ref.main).toBe(MAIN);
      expect(states(h.train)).toEqual({ clm_claim001: "batched" });
      expect(mainOutcomes(h.events())).toEqual([]);
    });
  });

  it("fails the batch and requeues its work when main moves elsewhere during the outage", async () => {
    const ref = new FakeMain(
      MAIN,
      Array.from({ length: MAX_WRITE_ATTEMPTS }, (): Step => "drop"),
    );
    await withRepo(ref, [pin(1)], async (h) => {
      await h.train.enqueue(pin(1));
      const first = await pass(h);
      const intentId = latestIntent(h.train);

      ref.main = ELSEWHERE;
      await h.alarm();
      expect(h.authorization.record(intentId)).toMatchObject({
        status: "reconciled",
        main: ELSEWHERE,
      });
      expect(mainOutcomes(h.events())).toEqual([
        { intentId, outcome: "reconciled", main: ELSEWHERE },
      ]);
      // The first batch settled; its pin was composed again on the commit main moved to.
      expect(batchStates(h.train)[0]).toEqual(["failed", "main_rejected"]);
      expect(h.started.at(-1)?.expectedMain).toBe(ELSEWHERE);
      expect(h.started.at(-1)?.candidate).not.toBe(first.candidate);
      expect(ref.updates).toHaveLength(MAX_WRITE_ATTEMPTS);
    });
  });

  it("holds a batch whose claim moved while its write may still land, and lands it late", async () => {
    const ref = new FakeMain(MAIN, ["hang"]);
    await withRepo(ref, [pin(1)], async (h) => {
      await h.train.enqueue(pin(1));
      const first = await pass(h);
      const intentId = latestIntent(h.train);
      expect(ref.late).toHaveLength(1);

      // The claim changes owner while the timed-out update is still on its way to Git.
      h.claims.set(pin(1).claimId, { ...pin(1), generation: 2 });
      await h.alarm();
      expect(batchStates(h.train)).toEqual([["passed", null]]);
      expect(states(h.train)).toEqual({ clm_claim001: "batched" });
      expect(h.authorization.record(intentId)).toMatchObject({ status: "authorized", attempts: 1 });
      expect(ref.updates).toHaveLength(1);

      // The update lands: the batch lands with it, not a failure beside work already on main.
      ref.release();
      await h.alarm();
      expect(ref.main).toBe(first.candidate);
      expect(batchStates(h.train)).toEqual([["landed", null]]);
      expect(states(h.train)).toEqual({ clm_claim001: "landed" });
      expect(mainOutcomes(h.events())).toEqual([
        { intentId, outcome: "reconciled", main: first.candidate },
      ]);
      expect(ref.updates).toHaveLength(1);
    });
  });

  it("holds a batch whose inbox gate blocks while its write may still land, and lands it late", async () => {
    const ref = new FakeMain(MAIN, ["hang"]);
    await withRepo(ref, [pin(1)], async (h) => {
      await h.train.enqueue(pin(1));
      const first = await pass(h);
      const intentId = latestIntent(h.train);
      expect(ref.late).toHaveLength(1);

      // An item affecting the claim arrives while the timed-out update is still on its way.
      h.gates.set(pin(1).claimId, { kind: "blocked", items: [7] });
      await h.alarm();
      await h.alarm();
      expect(batchStates(h.train)).toEqual([["passed", null]]);
      expect(states(h.train)).toEqual({ clm_claim001: "batched" });
      expect(h.authorization.record(intentId)).toMatchObject({ status: "authorized", attempts: 1 });
      expect(ref.updates).toHaveLength(1);

      // The update lands: the batch records the landing rather than a refusal.
      ref.release();
      await h.alarm();
      expect(ref.main).toBe(first.candidate);
      expect(batchStates(h.train)).toEqual([["landed", null]]);
      expect(states(h.train)).toEqual({ clm_claim001: "landed" });
      expect(mainOutcomes(h.events())).toEqual([
        { intentId, outcome: "reconciled", main: first.candidate },
      ]);
      expect(ref.updates).toHaveLength(1);
    });
  });

  it("fails a batch whose inbox gate blocks only once its write can no longer land", async () => {
    const ref = new FakeMain(MAIN, ["hang"]);
    await withRepo(ref, [pin(1)], async (h) => {
      await h.train.enqueue(pin(1));
      await pass(h);
      const intentId = latestIntent(h.train);
      const attemptAt = h.authorization.record(intentId)?.updatedAt ?? 0;
      h.gates.set(pin(1).claimId, { kind: "blocked", items: [7] });

      let drives = 0;
      while (batchStates(h.train)[0]?.[0] === "passed") {
        expect(h.now() - attemptAt).toBeLessThan(MAIN_UPDATE_EXPIRY_MS + 5 * 60_000);
        await h.alarm();
        drives += 1;
      }
      expect(drives).toBeGreaterThan(1);
      expect(h.now() - attemptAt).toBeGreaterThanOrEqual(MAIN_UPDATE_EXPIRY_MS);
      expect(h.authorization.record(intentId)).toMatchObject({ status: "reconciled", main: MAIN });
      expect(mainOutcomes(h.events())).toEqual([{ intentId, outcome: "reconciled", main: MAIN }]);
      expect(batchStates(h.train)[0]).toEqual(["failed", "main_rejected"]);
      expect(ref.updates).toHaveLength(1);
      expect(ref.main).toBe(MAIN);
      // The requeued pin is refused while its gate blocks, so the drive drops it and owes nothing.
      expect(states(h.train)).toEqual({ clm_claim001: "dropped" });
      expect(readWake(h.sql)).toBeNull();
      expect(h.started).toHaveLength(1);
    });
  });

  it("lands a batch whose write lands while a read begun before its window ends is answering", async () => {
    const ref = new FakeMain(MAIN, ["hang"]);
    await withRepo(ref, [pin(1)], async (h) => {
      await h.train.enqueue(pin(1));
      const first = await pass(h);
      const intentId = latestIntent(h.train);
      const attemptAt = h.authorization.record(intentId)?.updatedAt ?? 0;
      h.claims.set(pin(1).claimId, { ...pin(1), generation: 2 });

      // The drive's read sees main at the expected commit; the update reaches Git within its
      // window, and the read's answer arrives after the window has ended.
      ref.duringRead = () => {
        expect(h.now() - attemptAt).toBeLessThan(MAIN_UPDATE_EXPIRY_MS);
        ref.release();
        h.advance(attemptAt + MAIN_UPDATE_EXPIRY_MS + 500);
      };
      await h.alarm();
      expect(ref.main).toBe(first.candidate);
      expect(h.authorization.record(intentId)).toMatchObject({
        status: "reconciled",
        main: first.candidate,
      });
      expect(mainOutcomes(h.events())).toEqual([
        { intentId, outcome: "reconciled", main: first.candidate },
      ]);
      expect(batchStates(h.train)).toEqual([["landed", null]]);
      expect(states(h.train)).toEqual({ clm_claim001: "landed" });
      expect(ref.updates).toHaveLength(1);
    });
  });

  it("fails the batch and requeues its work once a write that never lands outlives its window", async () => {
    const ref = new FakeMain(MAIN, ["drop"]);
    ref.fallback = "refuse";
    await withRepo(ref, [pin(1), pin(2)], async (h) => {
      await h.train.enqueue(pin(1));
      await pass(h);
      const intentId = latestIntent(h.train);
      const attemptAt = h.authorization.record(intentId)?.updatedAt ?? 0;
      await h.train.enqueue(pin(2));

      // Claim 1 changes owner while the write is unsettled: the batch is held while it may land.
      const writes = ref.updates.length;
      h.claims.set(pin(1).claimId, { ...pin(1), generation: 2 });
      await h.alarm();
      expect(batchStates(h.train)).toEqual([["passed", null]]);
      expect(h.authorization.record(intentId)).toMatchObject({ status: "authorized" });

      // The alarm keeps driving; once the attempt is older than its window, the intent settles.
      let drives = 1;
      while (batchStates(h.train)[0]?.[0] === "passed") {
        expect(h.now() - attemptAt).toBeLessThan(MAIN_UPDATE_EXPIRY_MS + 5 * 60_000);
        await h.alarm();
        drives += 1;
      }
      expect(drives).toBeGreaterThan(2);
      expect(h.now() - attemptAt).toBeGreaterThanOrEqual(MAIN_UPDATE_EXPIRY_MS);
      expect(h.authorization.record(intentId)).toMatchObject({ status: "reconciled", main: MAIN });
      expect(mainOutcomes(h.events())).toEqual([{ intentId, outcome: "reconciled", main: MAIN }]);
      expect(batchStates(h.train)[0]).toEqual(["failed", "main_rejected"]);
      expect(ref.updates).toHaveLength(writes);
      expect(ref.main).toBe(MAIN);

      // The train moves on: the queued pin is composed on main in a batch of its own.
      expect(h.started.at(-1)?.expectedMain).toBe(MAIN);
      expect(h.started.at(-1)?.pins.map((p) => p.claimId)).toEqual([pin(2).claimId]);
    });
  });
});

function unreachable(value: never): never {
  throw new Error(`unhandled step: ${String(value)}`);
}

/** Drives the alarm until the train's retries run out; fails the test if they never do. */
async function exhaust(h: Harness): Promise<void> {
  for (let drive = 0; drive <= MAX_WAKE_FAILURES; drive += 1) {
    if (readWake(h.sql)?.failures === EXHAUSTED_FAILURES) return;
    await h.alarm();
  }
  throw new Error("the wake was never exhausted");
}

/**
 * Leaves an exhausted wake owing the settlement of an intent whose main write went unheard, in
 * `target`'s storage with no stored alarm, then stops the object.
 */
async function owedAcrossRestart(
  target: RepoTarget,
  ref: FakeMain,
): Promise<{ intentId: string; candidate: CommitSha; owed: number | undefined }> {
  const left = await withRepo(
    ref,
    [pin(1)],
    async (h) => {
      await h.train.enqueue(pin(1));
      ref.down = true;
      const first = await pass(h);
      const intent = latestIntent(h.train);
      expect(h.authorization.record(intent)).toMatchObject({ status: "authorized", attempts: 1 });
      await exhaust(h);
      const wake = readWake(h.sql);
      expect(wake?.failures).toBe(EXHAUSTED_FAILURES);
      return { intentId: intent, candidate: first.candidate, owed: wake?.dueAt };
    },
    { stub: target.stub, realAlarm: true },
  );
  // The object stops before its alarm write reached storage.
  await runInDurableObject(target.stub, (_instance, state) => state.storage.deleteAlarm());
  await evictDurableObject(target.stub);
  return left;
}

describe("the train's settle wake", () => {
  it("settles an intent whose write may have landed once Git recovers, with no further call", async () => {
    const ref = new FakeMain(MAIN, ["drop"]);
    await withRepo(ref, [pin(1)], async (h) => {
      await h.train.enqueue(pin(1));
      ref.down = true;
      const first = await pass(h);
      const intentId = latestIntent(h.train);
      expect(h.authorization.record(intentId)).toMatchObject({ status: "authorized", attempts: 1 });

      await exhaust(h);

      // The retries ran out, but the intent may have moved main, so a slow wake stays armed.
      const exhausted = readWake(h.sql);
      expect(exhausted).toEqual({ dueAt: h.now() + SETTLE_WAKE_MS, failures: EXHAUSTED_FAILURES });
      expect(h.wakes.at(-1)).toBe(exhausted?.dueAt);

      // An alarm another module asked for asks again for the settle wake and drives nothing.
      const asked = h.wakes.length;
      await h.train.resume();
      expect(h.wakes.slice(asked)).toEqual([exhausted?.dueAt]);
      // A repeated ready confirms the settle wake too.
      expect(await h.train.armWake()).toBe(true);
      expect(h.wakes.at(-1)).toBe(exhausted?.dueAt);

      // The settle drive finds Git still down: the row stays exhausted, an hour out again.
      await h.alarm();
      expect(readWake(h.sql)).toEqual({
        dueAt: h.now() + SETTLE_WAKE_MS,
        failures: EXHAUSTED_FAILURES,
      });
      expect(batchStates(h.train)).toEqual([["passed", null]]);

      // Git recovers and nothing else calls the train: the next settle drive lands the batch.
      ref.down = false;
      await h.alarm();
      expect(ref.main).toBe(first.candidate);
      expect(h.authorization.record(intentId)).toMatchObject({ status: "updated" });
      expect(batchStates(h.train)).toEqual([["landed", null]]);
      expect(states(h.train)).toEqual({ clm_claim001: "landed" });
      expect(readWake(h.sql)).toBeNull();
    });
  });

  it("asks again for an exhausted settle wake when the Repo restarts", async () => {
    const ref = new FakeMain(MAIN, ["drop"]);
    await withRepo(ref, [pin(1)], async (h) => {
      await h.train.enqueue(pin(1));
      ref.down = true;
      const first = await pass(h);
      await exhaust(h);
      const owed = readWake(h.sql);
      const asked = h.wakes.length;

      const restarted = h.restart();
      // The restarted train asks once the composition building it has returned.
      expect(h.wakes.slice(asked)).toEqual([]);
      await Promise.resolve();
      expect(h.wakes.slice(asked)).toEqual([owed?.dueAt]);

      ref.down = false;
      await h.alarm();
      expect(restarted.batches(1)).toMatchObject([{ state: "landed" }]);
      expect(ref.main).toBe(first.candidate);
    });
  });

  it("reconciles a write that landed unrecorded after the wake ran out, writing nothing again", async () => {
    const ref = new FakeMain(
      MAIN,
      Array.from({ length: MAX_WRITE_ATTEMPTS }, (): Step => "drop"),
    );
    await withRepo(ref, [pin(1)], async (h) => {
      await h.train.enqueue(pin(1));
      const first = await pass(h);
      const intentId = latestIntent(h.train);
      expect(ref.updates).toHaveLength(MAX_WRITE_ATTEMPTS);
      ref.down = true;
      await exhaust(h);
      const writes = ref.updates.length;
      expect(writes).toBe(MAX_WRITE_ATTEMPTS);
      expect(h.authorization.record(intentId)).toMatchObject({ status: "authorized" });

      // One of the writes did land, though it answered as uncertain: main holds the candidate
      // while the intent is still authorized and the batch still passed.
      ref.main = first.candidate;
      ref.down = false;
      await h.alarm();

      expect(ref.updates).toHaveLength(writes);
      expect(h.authorization.record(intentId)).toMatchObject({
        status: "reconciled",
        main: first.candidate,
      });
      expect(mainOutcomes(h.events())).toEqual([
        { intentId, outcome: "reconciled", main: first.candidate },
      ]);
      expect(batchStates(h.train)).toEqual([["landed", null]]);
      expect(states(h.train)).toEqual({ clm_claim001: "landed" });
      expect(readWake(h.sql)).toBeNull();
    });
  });

  it("rejects a write that never landed once its fence moved after the wake ran out, and requeues the batch", async () => {
    const ref = new FakeMain(
      MAIN,
      Array.from({ length: MAX_WRITE_ATTEMPTS }, (): Step => "drop"),
    );
    await withRepo(ref, [pin(1), pin(2)], async (h) => {
      // Both pins wait for one drive, so they form one batch.
      expect(h.queue(pin(1))).toEqual(ok({ queued: true }));
      await h.train.enqueue(pin(2));
      const first = await pass(h);
      ref.down = true;
      expect(pinsOf(first)).toEqual([pin(1), pin(2)]);
      const intentId = latestIntent(h.train);
      const attemptAt = h.authorization.record(intentId)?.updatedAt ?? 0;
      await exhaust(h);
      const writes = ref.updates.length;

      // Claim 1 changes owner while the wake is exhausted; the write never reached main, and its
      // window has long ended.
      h.claims.set(pin(1).claimId, { ...pin(1), generation: 2 });
      ref.down = false;
      expect(h.now() - attemptAt).toBeGreaterThanOrEqual(MAIN_UPDATE_EXPIRY_MS);
      const asked = h.wakes.length;
      await h.alarm();

      expect(ref.updates).toHaveLength(writes);
      expect(ref.main).toBe(MAIN);
      expect(h.authorization.record(intentId)).toMatchObject({ status: "reconciled", main: MAIN });
      expect(mainOutcomes(h.events())).toEqual([{ intentId, outcome: "reconciled", main: MAIN }]);
      expect(batchStates(h.train)[0]).toEqual(["failed", "main_rejected"]);
      // Claim 2's pin was requeued and batched again on main; claim 1's moved pin was dropped.
      expect(states(h.train)).toEqual({ clm_claim001: "dropped", clm_claim002: "batched" });
      const second = h.started.at(-1);
      expect(second?.expectedMain).toBe(MAIN);
      expect(pinsOf(second)).toEqual([pin(2)]);
      // The wake left exhaustion: it is armed for the new attempt, and clears once it lands. The
      // failed batch also asked the alarm for its candidate's discard.
      const wake = readWake(h.sql);
      expect(wake?.failures).not.toBe(EXHAUSTED_FAILURES);
      expect(h.wakes.slice(asked)).toContain(wake?.dueAt);
      await pass(h);
      expect(ref.main).toBe(h.started.at(-1)?.candidate);
      expect(states(h.train)).toEqual({ clm_claim001: "dropped", clm_claim002: "landed" });
      expect(readWake(h.sql)).toBeNull();
    });
  });

  // This runs the Repo alarm handler's steps over the modules built here: the Repo's own
  // composition has no authorization module or main ref yet, so it never owes a settlement.
  // casqueblanc/railhead#242 tracks the test through `Repo.alarm` itself.
  it("settles an owed intent from the stored alarm after the object restarts, with no call", async () => {
    const target: RepoTarget = { stub: env.REPO.getByName(crypto.randomUUID()), realAlarm: true };
    const ref = new FakeMain(MAIN, ["drop"]);
    const { intentId, candidate, owed } = await owedAcrossRestart(target, ref);

    ref.down = false;
    await withRepo(
      ref,
      [pin(1)],
      async (h) => {
        // The rebuilt train asks for the settle wake once its composition returns, and storage
        // holds it.
        expect(await h.train.startup()).toBe(true);
        expect(owed).toBeDefined();
        expect(await h.storedAlarm()).toBe(owed);

        // Git is back and nothing calls the train: the stored alarm settles the intent.
        await h.fireAlarm();
        expect(ref.main).toBe(candidate);
        expect(h.authorization.record(intentId)).toMatchObject({
          status: "updated",
          main: candidate,
        });
        expect(batchStates(h.train)).toEqual([["landed", null]]);
        expect(states(h.train)).toEqual({ clm_claim001: "landed" });
        // The train owes no drive. The alarm left, no later than the landed candidate's discard,
        // writes nothing to main when it fires.
        expect(readWake(h.sql)).toBeNull();
        const discard = h.sql
          .exec<{ due_at: number }>("SELECT MIN(due_at) AS due_at FROM train_discards")
          .one().due_at;
        expect(await h.storedAlarm()).toBeLessThanOrEqual(discard);
        const writes = ref.updates.length;
        await h.fireAlarm();
        expect(ref.updates).toHaveLength(writes);
        expect(batchStates(h.train)).toEqual([["landed", null]]);
        expect(readWake(h.sql)).toBeNull();
      },
      target,
    );
    await runInDurableObject(target.stub, (_instance, state) => state.storage.deleteAlarm());
  });

  it.each([
    ["alarm write", { failedAlarmWrites: 1 }],
    ["intent read", { failedIntentReads: 1 }],
  ])(
    "retries a restarted train's settle wake after a failed %s, and the alarm settles the intent",
    async (_fault, fault) => {
      const stub = env.REPO.getByName(crypto.randomUUID());
      const ref = new FakeMain(MAIN, ["drop"]);
      const { intentId, candidate, owed } = await owedAcrossRestart({ stub, realAlarm: true }, ref);

      ref.down = false;
      await withRepo(
        ref,
        [pin(1)],
        async (h) => {
          // The first attempt failed; a later one stored the alarm.
          expect(await startupOnFakeTimers(h.train)).toBe(true);
          expect(owed).toBeDefined();
          expect(await h.storedAlarm()).toBe(owed);

          // Nothing calls the train: the stored alarm settles the intent.
          await h.fireAlarm();
          expect(ref.main).toBe(candidate);
          expect(h.authorization.record(intentId)).toMatchObject({
            status: "updated",
            main: candidate,
          });
          expect(batchStates(h.train)).toEqual([["landed", null]]);
        },
        { stub, realAlarm: true, ...fault },
      );
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
    },
  );

  it("reports a restarted train whose every settle wake write failed, and a repeated ready stores it", async () => {
    const stub = env.REPO.getByName(crypto.randomUUID());
    const ref = new FakeMain(MAIN, ["drop"]);
    const { owed } = await owedAcrossRestart({ stub, realAlarm: true }, ref);

    await withRepo(
      ref,
      [pin(1)],
      async (h) => {
        expect(await startupOnFakeTimers(h.train)).toBe(false);
        expect(await h.storedAlarm()).toBeNull();
        // The wake row still owes the settlement, so a ready's `armWake` asks again.
        expect(readWake(h.sql)?.failures).toBe(EXHAUSTED_FAILURES);
        expect(await h.train.armWake()).toBe(true);
        expect(owed).toBeDefined();
        expect(await h.storedAlarm()).toBe(owed);
      },
      { stub, realAlarm: true, failedAlarmWrites: STARTUP_WAKE_ATTEMPTS },
    );
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  });

  it("settles the intent through the train a reset Repo rebuilds after every settle wake write failed", async () => {
    const stub = env.REPO.getByName(crypto.randomUUID());
    const ref = new FakeMain(MAIN, ["drop"]);
    const { intentId, candidate, owed } = await owedAcrossRestart({ stub, realAlarm: true }, ref);

    ref.down = false;
    await withRepo(
      ref,
      [pin(1)],
      async (h) => {
        // Every startup write failed: the Repo resets on this, so no alarm and no call remains.
        expect(await startupOnFakeTimers(h.train)).toBe(false);
        expect(await h.storedAlarm()).toBeNull();
        expect(batchStates(h.train)).toEqual([["passed", null]]);

        // The next request builds the train again, which stores the wake from its row, and the
        // alarm alone settles the intent.
        const rebuilt = h.restart();
        expect(await rebuilt.startup()).toBe(true);
        expect(owed).toBeDefined();
        expect(await h.storedAlarm()).toBe(owed);
        await h.fireAlarm();
        expect(ref.main).toBe(candidate);
        expect(h.authorization.record(intentId)).toMatchObject({
          status: "updated",
          main: candidate,
        });
        expect(batchStates(h.train)).toEqual([["landed", null]]);
        expect(states(h.train)).toEqual({ clm_claim001: "landed" });
        expect(readWake(h.sql)).toBeNull();
      },
      { stub, realAlarm: true, failedAlarmWrites: STARTUP_WAKE_ATTEMPTS },
    );
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  });

  it("confirms no startup wake for an exhausted train that owes no settlement", async () => {
    const stub = env.REPO.getByName(crypto.randomUUID());
    const ref = new FakeMain(MAIN, ["drop"]);
    await withRepo(
      ref,
      [pin(1)],
      async (h) => {
        // Work exhausted its retries, and no batch holds an intent that may have moved main.
        writeWake(h.sql, { dueAt: h.now(), failures: EXHAUSTED_FAILURES });
      },
      { stub, realAlarm: true },
    );
    await evictDurableObject(stub);
    await withRepo(
      ref,
      [pin(1)],
      async (h) => {
        const asked = h.wakes.length;
        expect(await h.train.startup()).toBe(true);
        expect(h.wakes).toHaveLength(asked);
        expect(await h.storedAlarm()).toBeNull();
      },
      { stub, realAlarm: true },
    );
  });

  it("settles a batch whose intent settled without the train hearing it", async () => {
    const ref = new FakeMain(MAIN, ["drop"]);
    await withRepo(ref, [pin(1)], async (h) => {
      await h.train.enqueue(pin(1));
      ref.down = true;
      const first = await pass(h);
      const intentId = latestIntent(h.train);
      await exhaust(h);
      const before = h.authorization.record(intentId);
      if (before === null) throw new Error("no intent was recorded");

      // The writer's last answer was lost: main moved and the intent settled, but the batch did not.
      ref.down = false;
      ref.main = first.candidate;
      expect(
        h.authorization.recordWrite(intentId, before.attempts, {
          status: "updated",
          attempts: before.attempts,
          main: first.candidate,
        }),
      ).toMatchObject({ status: "updated" });
      expect(batchStates(h.train)).toEqual([["passed", null]]);

      await h.alarm();
      expect(batchStates(h.train)).toEqual([["landed", null]]);
      expect(states(h.train)).toEqual({ clm_claim001: "landed" });
      expect(readWake(h.sql)).toBeNull();
    });
  });

  it("gives the next batch a fresh budget once a settle drive lands the stranded one", async () => {
    const ref = new FakeMain(MAIN, ["drop"]);
    await withRepo(ref, [pin(1), pin(2)], async (h) => {
      await h.train.enqueue(pin(1));
      ref.down = true;
      const first = await pass(h);
      // Claim 2's pin waits behind the active batch while the retries run out.
      expect(h.queue(pin(2))).toEqual(ok({ queued: true }));
      await exhaust(h);
      expect(readWake(h.sql)?.failures).toBe(EXHAUSTED_FAILURES);

      // Git recovers: the settle drive lands batch A, forms batch B, and its compose fails once.
      ref.down = false;
      h.composeFailures = 1;
      const asked = h.wakes.length;
      await h.alarm();
      expect(ref.main).toBe(first.candidate);
      expect(batchStates(h.train)).toEqual([
        ["landed", null],
        ["composing", null],
      ]);
      const retry = readWake(h.sql);
      expect(retry?.failures).toBe(1);
      // The retry asked for the alarm; batch A's discard asked for its own.
      expect(h.wakes.slice(asked)).toContain(retry?.dueAt);

      // The alarm alone retries batch B, with no further call, and it lands.
      await h.alarm();
      expect(pinsOf(h.started.at(-1))).toEqual([pin(2)]);
      const second = await pass(h);
      expect(ref.main).toBe(second.candidate);
      expect(batchStates(h.train)).toEqual([
        ["landed", null],
        ["landed", null],
      ]);
      expect(states(h.train)).toEqual({ clm_claim001: "landed", clm_claim002: "landed" });
      expect(readWake(h.sql)).toBeNull();
    });
  });
});
