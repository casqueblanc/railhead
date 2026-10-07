import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { CommitSha, DecisionRef, RailheadEvent } from "@railhead/shared/events";
import type { ClaimPin } from "../src/contracts/claims";
import type { SystemQuestion } from "../src/contracts/decisions";
import { fail, ok, type PortResult } from "../src/contracts/result";
import {
  MERGE_PUSH_WINDOW_MS,
  type CheckAttempt,
  type CheckDefinition,
  type CheckReport,
  type MergeIntentRecord,
  type MergeOutcome,
} from "../src/contracts/train";
import {
  CHECK_DEADLINE_MS,
  createTrain,
  DISCARD_BASE_MS,
  DISCARD_MAX_MS,
  DRIVE_LEASE_MS,
  EXHAUSTED_FAILURES,
  HELD_PARK_TTL_MS,
  MAX_PARKED_HELD,
  MAX_QUEUE,
  MAX_DISCARDS_PER_WAKE,
  MAX_RELEASE_READS,
  MAX_RETRIES,
  MAX_WAKE_FAILURES,
  PORT_TIMEOUT_MS,
  QUESTION_BASE_MS,
  QUESTION_MAX_MS,
  SETTLE_WAKE_MS,
  WAKE_BASE_MS,
  WAKE_MAX_MS,
  type DriveOutcome,
  type Train,
} from "../src/modules/train/scheduler";
import {
  insertConflict,
  insertEntry,
  migrateTrain,
  readConflict,
  readEntry,
  readWake,
  settleConflict,
  settleEntry,
  writeWake,
  type ConflictRecord,
  type ConflictState,
  type PendingWake,
} from "../src/modules/train/store";
import {
  UnavailableError,
  unavailableChecks,
  unavailableClaims,
} from "../src/contracts/unavailable";
import { composeRepo, type RepoContext, type RepoPorts } from "../src/repo/composeRepo";
import type { ConflictInput, ConflictVerdict } from "../src/train/classification/classify";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName } from "../src/repo/RepoObject";
import { EarliestAlarm } from "../src/repo/storage";
import { deferred } from "./sliceWorld";
import { candidateOf, queueing, type QueueingTrain } from "./trainQueue";

const REPO_ID = "rep_train0001";

/** A compatible verdict at the gate. */
const REDO: ConflictVerdict = { route: "redo", class: "compatible", probability: 0.95 };

/** One conflicted region of `src/upload.ts`. */
const REGION = {
  path: "src/upload.ts",
  base: "export const limit = 10;\n",
  ours: "export const limit = 10;\nexport const chunk = 1;\n",
  theirs: "export const limit = 10;\nexport const retries = 3;\n",
};

/** The verdict on a conflict no model judged. */
const UNJUDGED: ConflictVerdict = {
  route: "question",
  class: "contradictory",
  probability: 0,
  reason: "unavailable",
};
const MAIN = sha("1");

function sha(digit: string): CommitSha {
  return digit.repeat(40);
}

function pin(
  n: number,
  generation = 1,
  commit = n.toString(16).padStart(2, "0").repeat(20),
): ClaimPin {
  return { claimId: `clm_claim${String(n).padStart(3, "0")}`, generation, commit };
}

function definition(main: CommitSha): CheckDefinition {
  return { name: "test", source: main, digest: "d".repeat(64), acceptance: null };
}

/** The port calls the train makes. */
type PortCall =
  | "claims.pin"
  | "mainWriter.head"
  | "checks.definitions"
  | "decisions.requirements"
  | "merge.compose"
  | "checks.start"
  | "authorization.authorize"
  | "mainWriter.publish"
  | "conflicts.classify";

/**
 * Fakes of the published ports. Merge composes deterministically from main and the pins; the
 * main writer is a compare-and-swap ref. Each records what it was asked.
 */
class Fakes {
  main: CommitSha = MAIN;
  /** The claims module's current pin of each claim. */
  readonly pins = new Map<string, ClaimPin>();
  /** Requirements returned per claim. */
  readonly requirements = new Map<string, DecisionRef[]>();
  /** When true, the decisions fence reader reports every claim's versions unknown. */
  unknownVersions = false;
  /** How many times the decisions fence reader was read. */
  versionReads = 0;
  composeCalls: { main: CommitSha; pins: ClaimPin[] }[] = [];
  /** The merge attempt of each compose, in order. */
  composeAttempts: string[] = [];
  /**
   * The attempts whose candidate ref the merge fake holds. Every compose publishes its ref before
   * it answers, as a real one may before it times out, and `discard` deletes it.
   */
  readonly candidateRefs = new Set<string>();
  /** Each discard asked for, in order. */
  discards: string[] = [];
  discard: (attempt: string) => PortResult<{ removed: number }> = (attempt) =>
    ok({ removed: this.candidateRefs.delete(attempt) ? 1 : 0 });
  /** Each claim's issue title, as the claims module answers it for the conflict's intents. */
  readonly titles = new Map<string, string>();
  /** Every conflict the conflicts port was asked to classify, oldest first. */
  classified: ConflictInput[] = [];
  /** How the conflicts port answers. */
  verdict: (conflict: ConflictInput) => ConflictVerdict = () => UNJUDGED;
  /** Every system question the train asked, oldest first, including refused ones. */
  asked: SystemQuestion[] = [];
  /** How the decisions module answers a system question. */
  answerAsk: (question: SystemQuestion) => PortResult<{ questionId: string; decisionId: string }> =
    () => {
      const n = String(this.asked.length).padStart(4, "0");
      return ok({ questionId: `qst_question${n}`, decisionId: `dec_decision${n}` });
    };
  /** Every decision whose question the train withdrew, oldest first. */
  withdrawn: string[] = [];
  /** How the decisions module answers a withdrawal. */
  withdraw: (decisionId: string) => boolean = () => true;
  started: CheckAttempt[] = [];
  authorized: string[] = [];
  published: string[] = [];
  compose: (main: CommitSha, pins: ClaimPin[]) => PortResult<MergeOutcome> = (main, pins) =>
    ok({ kind: "clean", candidate: candidateOf(main, pins) });
  start: (attempt: CheckAttempt) => PortResult<{ attemptId: string }> = (attempt) =>
    ok({ attemptId: attempt.attemptId });
  authorize: (attempt: CheckAttempt) => PortResult<MergeIntentRecord> = (attempt) =>
    ok(intentFor(attempt, this.authorized.length));
  publishOverride: ((record: MergeIntentRecord) => PortResult<MergeIntentRecord>) | null = null;
  definitions: (main: CommitSha) => PortResult<CheckDefinition[]> = (main) =>
    ok([definition(main)]);
  head: () => PortResult<CommitSha> = () => ok(this.main);
  /** When set, each check start waits for it before answering. */
  startGate: (() => Promise<void>) | null = null;
  /** The port call that never answers, if any. */
  hang: PortCall | null = null;
  /** Port calls that wait for a test to release them. */
  readonly holds = new Map<PortCall, Promise<void>>();
  /** How long the train waits on each port call. */
  portTimeoutMs = PORT_TIMEOUT_MS;
  /** While true, every alarm write the train asks for fails, as `EarliestAlarm.request` reports. */
  alarmDown = false;
  readonly intents = new Map<string, MergeIntentRecord>();

  ready(...pins: ClaimPin[]): void {
    for (const p of pins) this.pins.set(p.claimId, p);
  }

  /** Every port call the train made, in order. */
  readonly reached: PortCall[] = [];

  /** Never settles while `call` is the hung one. */
  async answer(call: PortCall): Promise<void> {
    this.reached.push(call);
    if (this.hang === call) await new Promise<never>(() => {});
    await this.holds.get(call);
  }

  /** Makes every `call` wait until the returned function releases them. */
  hold(call: PortCall): () => void {
    const { promise, resolve } = deferred();
    this.holds.set(call, promise);
    return () => {
      this.holds.delete(call);
      resolve();
    };
  }

  /**
   * The ports the train sees. A ready pin's fence readers follow `pins` and `requirements`, at the
   * episode its queue entry in `sql` holds, so a test that changes either changes what they answer.
   */
  ports(real: RepoPorts, sql: SqlStorage): RepoPorts {
    return {
      ...real,
      claims: {
        ...real.claims,
        pin: async (claimId) => {
          await this.answer("claims.pin");
          const current = this.pins.get(claimId);
          return current === undefined ? fail("not_found", "No such claim.") : ok(current);
        },
        currentGeneration: (claimId) => this.pins.get(claimId)?.generation ?? null,
        intent: (claimId) => this.titles.get(claimId) ?? null,
        readyPin: (claimId) => {
          const current = this.pins.get(claimId);
          if (current === undefined) return null;
          const entry = readEntry(sql, claimId, current.generation);
          if (entry === null) return null;
          return {
            pin: current,
            episode: entry.episode,
            decisions: this.requirements.get(claimId) ?? [],
          };
        },
      },
      decisions: {
        ...real.decisions,
        requirements: async (claimId) => {
          await this.answer("decisions.requirements");
          return ok(this.requirements.get(claimId) ?? []);
        },
        askSystem: (_tx, question) => {
          this.asked.push(question);
          return this.answerAsk(question);
        },
        withdraw: (_tx, _asker, decisionId) => {
          const withdrew = this.withdraw(decisionId);
          this.withdrawn.push(decisionId);
          return withdrew;
        },
        currentVersions: (claimId) => {
          this.versionReads += 1;
          return this.pins.has(claimId) && !this.unknownVersions
            ? (this.requirements.get(claimId) ?? [])
            : null;
        },
      },
      conflicts: {
        classify: async (conflict) => {
          this.classified.push(conflict);
          await this.answer("conflicts.classify");
          return this.verdict(conflict);
        },
      },
      merge: {
        compose: async (main, pins, attempt) => {
          this.composeCalls.push({ main, pins });
          this.composeAttempts.push(attempt);
          this.candidateRefs.add(attempt);
          await this.answer("merge.compose");
          return this.compose(main, pins);
        },
        discard: async (attempt) => {
          this.discards.push(attempt);
          return this.discard(attempt);
        },
      },
      checks: {
        definitions: async (main) => {
          await this.answer("checks.definitions");
          return this.definitions(main);
        },
        start: async (attempt) => {
          this.started.push(attempt);
          await this.answer("checks.start");
          if (this.startGate !== null) await this.startGate();
          return this.start(attempt);
        },
        // Reports reach the train through `recordCheck` in these tests.
        report: unavailableChecks.report,
        // Approvals reach the train through `release` in these tests.
        approve: unavailableChecks.approve,
        detail: unavailableChecks.detail,
      },
      authorization: {
        authorize: async (attemptId) => {
          this.authorized.push(attemptId);
          await this.answer("authorization.authorize");
          const attempt = this.started.find((a) => a.attemptId === attemptId);
          if (attempt === undefined) return fail("check_not_passed", "Unknown attempt.");
          const result = this.authorize(attempt);
          if (result.ok) this.intents.set(result.value.intentId, result.value);
          return result;
        },
        intent: async () => fail("not_found", "No intent."),
        // The scheduler reaches intents only through the main writer fake below.
        record: (intentId) => this.intents.get(intentId) ?? null,
        unsettled: () => [],
        recordWrite: () => null,
      },
      mainWriter: {
        head: async () => {
          await this.answer("mainWriter.head");
          return this.head();
        },
        publish: async (intentId) => {
          this.published.push(intentId);
          await this.answer("mainWriter.publish");
          const record = this.intents.get(intentId);
          if (record === undefined) return fail("not_found", "No intent.");
          if (this.publishOverride !== null) return this.publishOverride(record);
          if (this.main !== record.expectedMain) {
            return ok({ ...record, status: "rejected", main: this.main });
          }
          this.main = record.candidate;
          return ok({ ...record, status: "updated", main: record.candidate, attempts: 1 });
        },
      },
    };
  }
}

function intentFor(attempt: CheckAttempt, n: number): MergeIntentRecord {
  return {
    intentId: `int_intent${String(n).padStart(3, "0")}`,
    expectedMain: attempt.expectedMain,
    candidate: attempt.candidate,
    pins: attempt.pins,
    decisions: attempt.decisions,
    checkAttemptId: attempt.attemptId,
    status: "authorized",
    attempts: 0,
    main: null,
    authorizedAt: 0,
    updatedAt: 0,
  };
}

interface Harness {
  train: QueueingTrain;
  fakes: Fakes;
  /** Builds another train over the same storage, as a restarted `Repo` does. */
  restart(): QueueingTrain;
  events(): RailheadEvent[];
  /** The Repo's event log, for a transaction a test runs as another module would. */
  log: EventLog;
  sql: SqlStorage;
  /** Every time the train asked the Repo's alarm for a drive, oldest first. */
  wakes: number[];
  /** Every time it asked the alarm for a pending discard, oldest first. */
  discardWakes: number[];
  /** The clock's current time. */
  now(): number;
  /** Moves the clock forward. */
  advance(ms: number): void;
}

/** Runs `body` against a train over the storage of a Durable Object no other test touches. */
function withTrain<R>(body: (harness: Harness) => Promise<R>, fakes = new Fakes()): Promise<R> {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    let now = 1_000;
    const log = EventLog.open(state.storage, REPO_ID, () => now);
    const wakes: number[] = [];
    const discardWakes: number[] = [];
    // A wake for a pending discard is kept apart from the drive wakes most tests count.
    const forDiscard = (at: number) =>
      state.storage.sql
        .exec<{ found: number }>(
          "SELECT EXISTS (SELECT 1 FROM train_discards WHERE due_at = ?) AS found",
          at,
        )
        .one().found === 1;
    const context: RepoContext = {
      repoId: REPO_ID,
      storage: state.storage,
      log,
      clock: () => (now += 1),
      env,
      wake: async (at) => {
        if (fakes.alarmDown) return false;
        (forDiscard(at) ? discardWakes : wakes).push(at);
        return true;
      },
    };
    const ports = fakes.ports(composeRepo(context), state.storage.sql);
    const build = () =>
      queueing(
        createTrain(context, () => ports, fakes.portTimeoutMs),
        log,
      );
    return body({
      train: build(),
      fakes,
      restart: build,
      events: () => log.replay(0, 256).events,
      log,
      sql: state.storage.sql,
      wakes,
      discardWakes,
      now: () => now,
      advance: (ms) => {
        now += ms;
      },
    });
  });
}

function report(attempt: CheckAttempt, result: CheckReport["result"]): CheckReport {
  return {
    attemptId: attempt.attemptId,
    candidate: attempt.candidate,
    result,
    logDigest: "e".repeat(64),
    finishedAt: 5_000,
  };
}

/** An attempt's pins without the ready episodes they are fenced to. */
function pinsOf(attempt: { pins: readonly ClaimPin[] } | undefined): ClaimPin[] | undefined {
  return attempt?.pins.map(({ claimId, generation, commit }) => ({ claimId, generation, commit }));
}

function lastStarted(fakes: Fakes): CheckAttempt {
  const attempt = fakes.started.at(-1);
  if (attempt === undefined) throw new Error("no check was started");
  return attempt;
}

/** The drive the train owes; fails the test when it owes none. */
function owed(sql: SqlStorage): PendingWake {
  const wake = readWake(sql);
  if (wake === null) throw new Error("the train owes no drive");
  return wake;
}

/**
 * Asserts the train's wake invariant from storage alone: while an active batch or a queued pin is
 * stored, a wake row is too, and unless that row is exhausted, the latest alarm the train asked for
 * is due no later than the row or the latest drive's lease, whichever is later.
 */
function expectDebtCovered(sql: SqlStorage, wakes: number[], exhausted: boolean): void {
  const work = sql
    .exec<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM train_batches WHERE active = 1)
         + (SELECT COUNT(*) FROM train_queue WHERE state = 'queued') AS n`,
    )
    .toArray()[0];
  const wake = readWake(sql);
  if ((work?.n ?? 0) === 0) return;
  expect(wake).not.toBeNull();
  if (wake === null) return;
  expect(wake.failures === EXHAUSTED_FAILURES).toBe(exhausted);
  if (exhausted) return;
  const lease = sql.exec<{ lease: number }>("SELECT lease_until AS lease FROM train_drive").one();
  expect(wakes.at(-1)).toBeLessThanOrEqual(Math.max(wake.dueAt, lease.lease));
}

/** A clock a lease behind real time, so a lease alarm it asks for is due within a second. */
function leaseBehind(): number {
  return Date.now() - DRIVE_LEASE_MS + 500;
}

function states(train: Train): Record<string, string> {
  return Object.fromEntries(
    train.entries(64).map((entry) => [`${entry.pin.claimId}@${entry.pin.generation}`, entry.state]),
  );
}

describe("train batches", () => {
  it("composes the exact pins on main, checks the candidate and lands on a pass", async () => {
    const fakes = new Fakes();
    const decision: DecisionRef = { decisionId: "dec_upload01", version: 2 };
    fakes.requirements.set(pin(1).claimId, [decision]);
    fakes.requirements.set(pin(2).claimId, [decision]);
    await withTrain(async ({ train, events }) => {
      fakes.ready(pin(1), pin(2));
      expect(await train.enqueue(pin(1))).toEqual(ok({ queued: true }));
      // The first pin started a batch alone; the second waits for it.
      expect(await train.enqueue(pin(2))).toEqual(ok({ queued: true }));

      expect(fakes.composeCalls).toEqual([{ main: MAIN, pins: [pin(1)] }]);
      const attempt = lastStarted(fakes);
      expect(attempt).toMatchObject({
        expectedMain: MAIN,
        candidate: candidateOf(MAIN, [pin(1)]),
        pins: [pin(1)],
        definition: definition(MAIN),
        decisions: [decision],
      });
      expect(attempt.attemptId).toMatch(/^chk_[0-9a-f]{32}$/);

      expect(await train.recordCheck(report(attempt, "pass"))).toEqual(ok(attempt));

      expect(fakes.main).toBe(attempt.candidate);
      expect(fakes.authorized).toEqual([attempt.attemptId]);
      // The second pin is composed on the new main, never on the commit the first batch used.
      expect(fakes.composeCalls[1]).toEqual({ main: attempt.candidate, pins: [pin(2)] });
      expect(states(train)).toEqual({ "clm_claim001@1": "landed", "clm_claim002@1": "batched" });
      expect(train.batches(2).map((b) => [b.state, b.failure])).toEqual([
        ["checking", null],
        ["landed", null],
      ]);
      const [check] = events();
      expect(events()).toHaveLength(1);
      expect(check).toMatchObject({
        type: "train.check",
        actor: { kind: "system", id: "sys_train" },
        data: {
          checkRunId: attempt.attemptId,
          candidate: attempt.candidate,
          check: "test",
          result: "pass",
          acceptance: null,
        },
      });
    }, fakes);
  });

  it("batches every waiting pin together, up to the batch limit", async () => {
    const fakes = new Fakes();
    // Main cannot be read until all ten are queued, so they wait together.
    fakes.head = () => fail("unavailable", "Not yet.");
    await withTrain(async ({ train }) => {
      const pins = Array.from({ length: 10 }, (_, n) => pin(n + 1));
      fakes.ready(...pins);
      for (const p of pins) expect(await train.enqueue(p)).toEqual(ok({ queued: true }));
      expect(fakes.composeCalls).toEqual([]);

      fakes.head = () => ok(fakes.main);
      expect(await train.drive()).toMatchObject({ kind: "checking" });
      expect(fakes.composeCalls).toEqual([{ main: MAIN, pins: pins.slice(0, 8) }]);
    }, fakes);
  });

  it("treats a duplicate pin as a no-op, holds a newer commit of a batched one and refuses an older generation", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1, 2));
      expect(await train.enqueue(pin(1, 2))).toEqual(ok({ queued: true }));
      expect(await train.enqueue(pin(1, 2))).toEqual(ok({ queued: false }));
      expect(await train.enqueue(pin(1, 2, sha("f")))).toEqual(ok({ queued: false }));
      expect(train.entries(1)[0]).toMatchObject({ state: "batched", nextCommit: sha("f") });
      expect(await train.enqueue(pin(1, 1))).toMatchObject({
        ok: false,
        code: "stale_generation",
      });

      expect(fakes.composeCalls).toHaveLength(1);
      expect(fakes.started).toHaveLength(1);
      expect(train.entries(64)).toHaveLength(1);
    }, fakes);
  });

  it("refuses malformed pins and reports without writing", async () => {
    await withTrain(async ({ train, events, fakes }) => {
      for (const bad of [
        pin(1, 0),
        pin(1, 1.5),
        pin(1, Number.MAX_SAFE_INTEGER + 1),
        { ...pin(1), claimId: "iss_claim001" },
        { ...pin(1), commit: "A".repeat(40) },
      ]) {
        expect(await train.enqueue(bad)).toMatchObject({ ok: false, code: "invalid_request" });
      }
      const good: CheckReport = {
        attemptId: "chk_attempt01",
        candidate: sha("2"),
        result: "pass",
        logDigest: null,
        finishedAt: 0,
      };
      for (const bad of [
        { ...good, attemptId: "int_attempt01" },
        { ...good, candidate: "abc" },
        { ...good, logDigest: "x".repeat(64) },
        { ...good, finishedAt: -1 },
      ]) {
        expect(await train.recordCheck(bad)).toMatchObject({ ok: false, code: "invalid_request" });
      }
      expect(train.entries(64)).toEqual([]);
      expect(events()).toEqual([]);
      expect(fakes.composeCalls).toEqual([]);
    });
  });

  it("never runs a second batch while one is active, even under concurrent enqueues", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train }) => {
      const pins = [pin(1), pin(2), pin(3)];
      fakes.ready(...pins);
      await Promise.all(pins.map((p) => train.enqueue(p)));

      const active = train.batches(64).filter((b) => b.state === "checking");
      expect(active).toHaveLength(1);
      expect(fakes.started).toHaveLength(1);
      expect(fakes.composeCalls).toHaveLength(1);
      expect(await train.drive()).toMatchObject({ kind: "checking" });
      expect(fakes.composeCalls).toHaveLength(1);
    }, fakes);
  });

  it("refuses a pin beyond the queue bound", async () => {
    const fakes = new Fakes();
    fakes.head = () => fail("unavailable", "Main cannot be read.");
    await withTrain(async ({ train }) => {
      for (let n = 1; n <= MAX_QUEUE; n += 1) {
        const p: ClaimPin = {
          claimId: `clm_bound${String(n).padStart(4, "0")}`,
          generation: 1,
          commit: sha("a"),
        };
        fakes.ready(p);
        expect(await train.enqueue(p)).toEqual(ok({ queued: true }));
      }
      const extra: ClaimPin = { claimId: "clm_boundextra", generation: 1, commit: sha("a") };
      expect(await train.enqueue(extra)).toMatchObject({ ok: false, code: "busy" });
      expect(train.batches(64)).toEqual([]);
    }, fakes);
  });
});

describe("train restart", () => {
  it("starts the same attempt again when the check port never acknowledged it", async () => {
    const fakes = new Fakes();
    fakes.start = () => fail("unavailable", "Runner offline.");
    await withTrain(async ({ train, restart }) => {
      fakes.ready(pin(1));
      expect(await train.enqueue(pin(1))).toEqual(ok({ queued: true }));
      expect(await train.drive()).toMatchObject({
        kind: "blocked",
        reason: "checks_unavailable",
        code: "unavailable",
      });
      const first = lastStarted(fakes);

      fakes.start = (attempt) => ok({ attemptId: attempt.attemptId });
      const again = restart();
      expect(await again.enqueue(pin(1))).toEqual(ok({ queued: false }));

      expect(fakes.composeCalls).toHaveLength(1);
      expect(fakes.started.map((a) => a.attemptId)).toEqual([
        first.attemptId,
        first.attemptId,
        first.attemptId,
      ]);
      expect(lastStarted(fakes)).toEqual(first);
      expect(await again.recordCheck(report(first, "pass"))).toEqual(ok(first));
      expect(fakes.main).toBe(first.candidate);
    }, fakes);
  });

  it("composes a batch left composing again from the same main and pins", async () => {
    const fakes = new Fakes();
    fakes.compose = () => fail("unavailable", "Sandbox offline.");
    await withTrain(async ({ train, restart }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      expect(train.batches(1)[0]).toMatchObject({ state: "composing", candidate: null });
      // Main moves while the batch waits; the batch keeps the main it was formed on.
      fakes.main = sha("9");

      fakes.compose = (main, pins) => ok({ kind: "clean", candidate: candidateOf(main, pins) });
      const again = restart();
      expect(await again.drive()).toMatchObject({ kind: "checking" });
      expect(fakes.composeCalls).toEqual([
        { main: MAIN, pins: [pin(1)] },
        { main: MAIN, pins: [pin(1)] },
      ]);
      // Publication then finds main moved, so the pass is not used.
      await again.recordCheck(report(lastStarted(fakes), "pass"));
      expect(again.batches(64).at(-1)).toMatchObject({ state: "failed", failure: "main_rejected" });
      expect(fakes.main).toBe(sha("9"));
    }, fakes);
  });
});

describe("train failures", () => {
  it("checks the pins of a failed composition alone, then drops the one that cannot compose", async () => {
    const fakes = new Fakes();
    fakes.head = () => fail("unavailable", "Not yet.");
    fakes.compose = (main, pins) =>
      pins.some((p) => p.claimId === pin(2).claimId)
        ? ok({ kind: "error", reason: "missing_commit" })
        : ok({ kind: "clean", candidate: candidateOf(main, pins) });
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1), pin(2));
      await train.enqueue(pin(1));
      await train.enqueue(pin(2));
      fakes.head = () => ok(fakes.main);
      await train.drive();

      expect(fakes.composeCalls.map((c) => c.pins)).toEqual([[pin(1), pin(2)], [pin(1)]]);
      expect(train.batches(64).at(-1)).toMatchObject({
        state: "failed",
        failure: "compose_missing_commit",
      });
      await train.recordCheck(report(lastStarted(fakes), "pass"));

      expect(fakes.composeCalls.map((c) => c.pins).at(-1)).toEqual([pin(2)]);
      expect(train.entries(64).find((e) => e.pin.claimId === pin(2).claimId)).toMatchObject({
        state: "dropped",
        reason: "compose_failed",
      });
      expect(fakes.started).toHaveLength(1);
      expect(fakes.main).toBe(candidateOf(MAIN, [pin(1)]));
    }, fakes);
  });

  it("retries a merge timeout a bounded number of times", async () => {
    const fakes = new Fakes();
    fakes.compose = () => ok({ kind: "error", reason: "timeout" });
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      expect(await train.drive()).toEqual({ kind: "idle" });

      expect(fakes.composeCalls).toHaveLength(MAX_RETRIES + 1);
      expect(train.entries(1)[0]).toMatchObject({ state: "dropped", reason: "retries_exhausted" });
      expect(train.batches(64).every((b) => b.failure === "compose_timeout")).toBe(true);
      expect(fakes.started).toEqual([]);
    }, fakes);
  });

  it("recomposes after a check error and never accepts the old attempt's pass", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, events }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      const errored = lastStarted(fakes);

      expect(await train.recordCheck(report(errored, "error"))).toEqual(ok(errored));
      const retried = lastStarted(fakes);
      expect(retried.attemptId).not.toBe(errored.attemptId);
      expect(fakes.composeCalls).toHaveLength(2);
      expect(train.entries(1)[0]).toMatchObject({ state: "batched", retries: 1 });

      // A late pass for the errored attempt is refused, and the same result again changes nothing.
      expect(await train.recordCheck(report(errored, "pass"))).toMatchObject({
        ok: false,
        code: "check_mismatch",
      });
      expect(await train.recordCheck(report(errored, "error"))).toEqual(ok(errored));
      expect(fakes.authorized).toEqual([]);
      expect(fakes.main).toBe(MAIN);
      expect(events().map((e) => (e.type === "train.check" ? e.data.result : e.type))).toEqual([
        "error",
      ]);
    }, fakes);
  });

  it("splits a failed batch into fresh single checks without passing any subset", async () => {
    const fakes = new Fakes();
    fakes.head = () => fail("unavailable", "Not yet.");
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1), pin(2));
      await train.enqueue(pin(1));
      await train.enqueue(pin(2));
      fakes.head = () => ok(fakes.main);
      await train.drive();
      const shared = lastStarted(fakes);
      expect(pinsOf(shared)).toEqual([pin(1), pin(2)]);

      await train.recordCheck(report(shared, "fail"));
      const alone = lastStarted(fakes);
      expect(pinsOf(alone)).toEqual([pin(1)]);
      expect(alone.candidate).toBe(candidateOf(MAIN, [pin(1)]));
      expect(fakes.authorized).toEqual([]);
      expect(train.batches(64).at(-1)).toMatchObject({ failure: "check_fail" });

      // The shared batch's result never transfers to the single candidate.
      expect(
        await train.recordCheck({ ...report(shared, "pass"), candidate: alone.candidate }),
      ).toMatchObject({
        ok: false,
        code: "check_mismatch",
      });
      await train.recordCheck(report(alone, "fail"));
      expect(train.entries(64).find((e) => e.pin.claimId === pin(1).claimId)).toMatchObject({
        state: "dropped",
        reason: "check_failed",
      });
      const second = lastStarted(fakes);
      expect(pinsOf(second)).toEqual([pin(2)]);
      await train.recordCheck(report(second, "pass"));
      expect(fakes.main).toBe(candidateOf(MAIN, [pin(2)]));
    }, fakes);
  });

  it("refuses a report for another candidate or an unknown attempt", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, events }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      const attempt = lastStarted(fakes);

      expect(
        await train.recordCheck({ ...report(attempt, "pass"), candidate: sha("7") }),
      ).toMatchObject({
        ok: false,
        code: "check_mismatch",
      });
      expect(
        await train.recordCheck({ ...report(attempt, "pass"), attemptId: "chk_unknown01" }),
      ).toMatchObject({
        ok: false,
        code: "check_mismatch",
      });
      expect(events()).toEqual([]);
      expect(train.batches(1)[0]).toMatchObject({ state: "checking", checkResult: null });
    }, fakes);
  });

  it("parks a conflicting pair, records it for the board and continues with the rest", async () => {
    const fakes = new Fakes();
    fakes.head = () => fail("unavailable", "Not yet.");
    fakes.compose = (main, pins) =>
      pins.length === 3
        ? ok({
            kind: "conflict",
            pins: [pin(1), pin(3)],
            paths: ["../escape", "src/upload.ts"],
            regions: [],
          })
        : ok({ kind: "clean", candidate: candidateOf(main, pins) });
    await withTrain(async ({ train, events }) => {
      fakes.ready(pin(1), pin(2), pin(3));
      for (const p of [pin(1), pin(2), pin(3)]) await train.enqueue(p);
      fakes.head = () => ok(fakes.main);
      await train.drive();

      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        type: "train.conflict",
        actor: { kind: "system", id: "sys_train" },
        data: {
          claims: [pin(1).claimId, pin(3).claimId],
          path: "src/upload.ts",
          class: "contradictory",
          route: "question",
        },
      });
      expect(states(train)).toEqual({
        "clm_claim001@1": "parked",
        "clm_claim002@1": "batched",
        "clm_claim003@1": "parked",
      });
      expect(pinsOf(lastStarted(fakes))).toEqual([pin(2)]);
      expect(train.entries(64).find((e) => e.state === "parked")).toMatchObject({
        reason: "conflict",
      });
    }, fakes);
  });

  it("fails the batch when a conflict names a pin outside it", async () => {
    const fakes = new Fakes();
    fakes.compose = () =>
      ok({ kind: "conflict", pins: [pin(1), pin(9)], paths: ["src/upload.ts"], regions: [] });
    await withTrain(async ({ train, events }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));

      expect(events()).toEqual([]);
      expect(train.batches(1)[0]).toMatchObject({
        state: "failed",
        failure: "compose_unsupported",
      });
      expect(train.entries(1)[0]).toMatchObject({ state: "dropped", reason: "compose_failed" });
    }, fakes);
  });
});

/** Fakes whose merge finds pins 1 and 3 conflicting on one region, with both issue titles. */
function classifying(verdict: ConflictVerdict): Fakes {
  const fakes = new Fakes();
  fakes.compose = (main, pins) => {
    const has = (n: number) => pins.some((p) => p.claimId === pin(n).claimId);
    return has(1) && has(3)
      ? ok({
          kind: "conflict",
          pins: [pin(1), pin(3)],
          paths: ["src/upload.ts"],
          regions: [REGION],
        })
      : ok({ kind: "clean", candidate: candidateOf(main, pins) });
  };
  fakes.titles.set(pin(1).claimId, "Add uploads");
  fakes.titles.set(pin(3).claimId, "Add downloads");
  fakes.verdict = () => verdict;
  return fakes;
}

/** Queues pins 1, 2 and 3 before the first batch forms, so all three are composed together. */
async function queueThree(train: QueueingTrain, fakes: Fakes): Promise<void> {
  fakes.head = () => fail("unavailable", "Not yet.");
  fakes.ready(pin(1), pin(2), pin(3));
  for (const p of [pin(1), pin(2), pin(3)]) await train.enqueue(p);
  fakes.head = () => ok(fakes.main);
}

describe("a classified conflict", () => {
  it("drops the losing pin of a redo and composes its partner with the rest, asking nothing", async () => {
    const fakes = classifying(REDO);
    await withTrain(async ({ train, events }) => {
      await queueThree(train, fakes);
      await train.drive();

      expect(fakes.classified).toEqual([
        { regions: [REGION], oursIntent: "Add uploads", theirsIntent: "Add downloads" },
      ]);
      expect(events()).toMatchObject([
        {
          type: "train.conflict",
          data: {
            claims: [pin(1).claimId, pin(3).claimId],
            path: "src/upload.ts",
            class: "compatible",
            probability: 0.95,
            route: "redo",
          },
        },
      ]);
      expect(states(train)).toEqual({
        "clm_claim001@1": "batched",
        "clm_claim002@1": "batched",
        "clm_claim003@1": "dropped",
      });
      expect(train.entries(64).find((e) => e.state === "dropped")).toMatchObject({
        reason: "conflict",
      });
      expect(pinsOf(lastStarted(fakes))).toEqual([pin(1), pin(2)]);
      expect(train.conflicts(8)).toEqual([]);
      expect(fakes.asked).toEqual([]);
    }, fakes);
  });

  it("parks and asks with the verdict a question carries", async () => {
    const fakes = classifying({
      route: "question",
      class: "compatible",
      probability: 0.82,
      reason: "below_gate",
    });
    await withTrain(async ({ train, events }) => {
      await queueThree(train, fakes);
      await train.drive();

      expect(events().map((e) => e.type)).toEqual(["train.conflict"]);
      expect(events()[0]).toMatchObject({
        data: { class: "compatible", probability: 0.82, route: "question" },
      });
      expect(states(train)).toMatchObject({
        "clm_claim001@1": "parked",
        "clm_claim003@1": "parked",
      });
      expect(train.conflicts(8)).toMatchObject([{ state: "asked" }]);
      expect(fakes.asked).toHaveLength(1);
    }, fakes);
  });

  it("parks and asks when the conflicts port does not answer in time", async () => {
    const fakes = classifying(REDO);
    fakes.portTimeoutMs = 20;
    fakes.hang = "conflicts.classify";
    await withTrain(async ({ train, events }) => {
      await queueThree(train, fakes);
      await train.drive();

      expect(events()[0]).toMatchObject({
        type: "train.conflict",
        data: { class: "contradictory", probability: 0, route: "question" },
      });
      expect(train.conflicts(8)).toMatchObject([{ state: "asked" }]);
    }, fakes);
  });

  it("classifies a conflict without text or intents as a question would be", async () => {
    const fakes = classifying(UNJUDGED);
    fakes.compose = () =>
      ok({ kind: "conflict", pins: [pin(1), pin(3)], paths: ["src/upload.ts"], regions: [] });
    fakes.titles.clear();
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1), pin(3));
      fakes.head = () => fail("unavailable", "Not yet.");
      await train.enqueue(pin(1));
      await train.enqueue(pin(3));
      fakes.head = () => ok(fakes.main);
      await train.drive();

      expect(fakes.classified).toEqual([{ regions: [], oursIntent: "", theirsIntent: "" }]);
      expect(train.conflicts(8)).toMatchObject([{ state: "asked" }]);
    }, fakes);
  });

  it("records nothing from a classification that a later drive's compose overtook", async () => {
    const fakes = classifying(UNJUDGED);
    await withTrain(async ({ train, restart, advance, events }) => {
      fakes.head = () => fail("unavailable", "Not yet.");
      fakes.ready(pin(1), pin(3));
      await train.enqueue(pin(1));
      await train.enqueue(pin(3));
      fakes.head = () => ok(fakes.main);
      const release = fakes.hold("conflicts.classify");
      const stale = train.drive();
      await vi.waitFor(() => expect(fakes.classified).toHaveLength(1));

      // The object stops mid-classification; the lease alarm composes and classifies again.
      const again = restart();
      fakes.holds.delete("conflicts.classify");
      advance(DRIVE_LEASE_MS);
      await again.resume();
      expect(fakes.composeAttempts).toHaveLength(2);
      expect(events().map((e) => e.type)).toEqual(["train.conflict"]);
      expect(again.conflicts(8)).toMatchObject([{ state: "asked" }]);

      // The stale drive's late redo is not recorded: nothing is dropped and nothing reopened.
      fakes.verdict = () => REDO;
      release();
      expect(await stale).toEqual({ kind: "superseded" });
      expect(events().map((e) => e.type)).toEqual(["train.conflict"]);
      expect(events()[0]).toMatchObject({ data: { route: "question" } });
      expect(states(again)).toEqual({ "clm_claim001@1": "parked", "clm_claim003@1": "parked" });
    }, fakes);
  });
});

/** Fakes whose merge finds pins 1 and 3 conflicting whenever both are in a batch. */
function conflicting(): Fakes {
  const fakes = new Fakes();
  fakes.compose = (main, pins) => {
    const has = (n: number) => pins.some((p) => p.claimId === pin(n).claimId);
    return has(1) && has(3)
      ? ok({ kind: "conflict", pins: [pin(1), pin(3)], paths: ["src/upload.ts"], regions: [] })
      : ok({ kind: "clean", candidate: candidateOf(main, pins) });
  };
  return fakes;
}

/** One asked pair seeded into storage. */
interface SeededPair {
  batchId: number;
  decisionId: string;
  pins: [ClaimPin, ClaimPin];
}

/**
 * Stores `count` parked pairs whose questions are asked, oldest first, each of two held claims of
 * its own, as successive conflicts leave them. None is counted against the queue.
 */
function seedAskedPairs(sql: SqlStorage, fakes: Fakes, count: number, now: number): SeededPair[] {
  return Array.from({ length: count }, (_, n) => {
    const batchId = 1_000 + n;
    const decisionId = `dec_seeded${String(n).padStart(4, "0")}`;
    const pins: [ClaimPin, ClaimPin] = [pin(10 + 2 * n, 1, sha("a")), pin(11 + 2 * n, 1, sha("b"))];
    for (const p of pins) {
      insertEntry(sql, p, 1, now);
      settleEntry(sql, p, "parked", "conflict", now);
      fakes.ready(p);
    }
    insertConflict(sql, batchId, pins, "src/upload.ts", now);
    settleConflict(sql, batchId, "asked", decisionId, now);
    return { batchId, decisionId, pins };
  });
}

/** How many stored pairs are in each state. */
function conflictStates(sql: SqlStorage): Partial<Record<ConflictState, number>> {
  return Object.fromEntries(
    sql
      .exec<{ state: ConflictState; n: number }>(
        "SELECT state, COUNT(*) AS n FROM train_conflicts GROUP BY state ORDER BY state",
      )
      .toArray()
      .map((row) => [row.state, row.n]),
  );
}

/** The newest pair, which must still owe its question. */
function owedQuestion(train: Train): ConflictRecord {
  const [conflict] = train.conflicts(1);
  if (conflict?.state !== "asking") throw new Error("the train owes no question");
  return conflict;
}

/** Queues pins 1 and 3 while main cannot be read, then drives them into one batch. */
async function park(train: QueueingTrain, fakes: Fakes): Promise<DriveOutcome> {
  const head = fakes.head;
  fakes.head = () => fail("unavailable", "Not yet.");
  fakes.ready(pin(1), pin(3));
  await train.enqueue(pin(1));
  await train.enqueue(pin(3));
  fakes.head = head;
  return train.drive();
}

describe("train conflict questions", () => {
  it("asks the owner exactly once when it parks a conflicting pair", async () => {
    const fakes = conflicting();
    await withTrain(async ({ train, sql, wakes }) => {
      const outcome = await park(train, fakes);

      expect(outcome).toEqual({ kind: "idle" });
      expect(fakes.asked).toEqual([
        {
          asker: "sys_train",
          key: "conflict_1",
          claims: [
            { claimId: pin(1).claimId, generation: 1 },
            { claimId: pin(3).claimId, generation: 1 },
          ],
          text: expect.stringContaining("src/upload.ts"),
          options: [
            { key: "keep_first", label: `Keep the change from ${pin(1).claimId}` },
            { key: "keep_second", label: `Keep the change from ${pin(3).claimId}` },
          ],
          scope: ["src/upload.ts"],
        },
      ]);
      expect(train.conflicts(8)).toMatchObject([
        { batchId: 1, state: "asked", decisionId: "dec_decision0001", path: "src/upload.ts" },
      ]);
      expect(states(train)).toEqual({ "clm_claim001@1": "parked", "clm_claim003@1": "parked" });
      // A parked pair waiting for its answer owes no drive.
      expect(readWake(sql)).toBeNull();

      // Later drives and alarms never ask again.
      const before = wakes.length;
      await train.drive();
      await train.resume();
      expect(fakes.asked).toHaveLength(1);
      expect(wakes.length).toBe(before);
    }, fakes);
  });

  it("returns the pair to the queue in the transaction that records the answer", async () => {
    const fakes = conflicting();
    await withTrain(async ({ train, sql, log, wakes }) => {
      await park(train, fakes);
      const [conflict] = train.conflicts(1);
      if (conflict?.decisionId == null) throw new Error("no question was asked");
      const { decisionId } = conflict;
      // An alarm before the answer changes nothing.
      await train.resume();
      expect(states(train)).toEqual({ "clm_claim001@1": "parked", "clm_claim003@1": "parked" });
      expect(readWake(sql)).toBeNull();

      const unparked = log.transaction((tx) => train.answered(tx, decisionId)).value;

      expect(unparked).toBe(true);
      expect(train.conflicts(1)).toMatchObject([{ state: "answered", decisionId }]);
      expect(states(train)).toEqual({ "clm_claim001@1": "queued", "clm_claim003@1": "queued" });
      expect(train.entries(64)).toMatchObject([
        { state: "queued", isolate: false, retries: 0, reason: null },
        { state: "queued", isolate: false, retries: 0, reason: null },
      ]);
      // The drive it owes is stored and asked for with the answer.
      const wake = owed(sql);
      expect(wake.failures).toBe(0);
      expect(wakes.at(-1)).toBe(wake.dueAt);
      // A later version of the same decision finds no parked pair and writes nothing.
      expect(log.transaction((tx) => train.answered(tx, decisionId)).value).toBe(false);
      expect(train.conflicts(1)).toMatchObject([{ state: "answered" }]);

      // The drive reads the pins again; main cannot be read, so it stops there.
      fakes.head = () => fail("unavailable", "Main is down.");
      fakes.reached.length = 0;
      await train.resume();
      expect(fakes.reached).toContain("claims.pin");
      expect(fakes.asked).toHaveLength(1);
    }, fakes);
  });

  it("keeps the pair parked when the answer's transaction rolls back", async () => {
    const fakes = conflicting();
    await withTrain(async ({ train, sql, log }) => {
      await park(train, fakes);
      const [conflict] = train.conflicts(1);
      if (conflict?.decisionId == null) throw new Error("no question was asked");
      const { decisionId } = conflict;

      expect(() =>
        log.transaction((tx) => {
          train.answered(tx, decisionId);
          throw new Error("the answer was refused");
        }),
      ).toThrow("the answer was refused");

      expect(train.conflicts(1)).toMatchObject([{ state: "asked" }]);
      expect(states(train)).toEqual({ "clm_claim001@1": "parked", "clm_claim003@1": "parked" });
      expect(readWake(sql)).toBeNull();
    }, fakes);
  });

  it("writes nothing for a decision no parked pair waits on", async () => {
    const fakes = conflicting();
    fakes.answerAsk = () => fail("unavailable", "Not yet.");
    await withTrain(async ({ train, sql, log }) => {
      await park(train, fakes);
      const before = readWake(sql);

      // An agent's decision, and a pair whose question is still owed, are not the train's answer.
      expect(log.transaction((tx) => train.answered(tx, "dec_unrelated1")).value).toBe(false);
      expect(train.conflicts(1)).toMatchObject([{ state: "asking", decisionId: null }]);
      expect(states(train)).toEqual({ "clm_claim001@1": "parked", "clm_claim003@1": "parked" });
      expect(readWake(sql)).toEqual(before);
    }, fakes);
  });

  it("returns an answered pair behind more than MAX_RELEASE_READS older unanswered pairs", async () => {
    const fakes = new Fakes();
    fakes.head = () => fail("unavailable", "Main is down.");
    await withTrain(async ({ train, sql, log, now }) => {
      const pairs = seedAskedPairs(sql, fakes, MAX_RELEASE_READS + 2, now());
      const last = pairs.at(-1);
      if (last === undefined) throw new Error("no pair was seeded");
      // Alarms before the answer reach no answer and leave every pair parked.
      await train.resume();
      await train.resume();

      const unparked = log.transaction((tx) => train.answered(tx, last.decisionId)).value;

      expect(unparked).toBe(true);
      expect(conflictStates(sql)).toEqual({ asked: MAX_RELEASE_READS + 1, answered: 1 });
      for (const p of last.pins) {
        expect(readEntry(sql, p.claimId, p.generation)?.state).toBe("queued");
      }
      const first = pairs[0];
      if (first === undefined) throw new Error("no pair was seeded");
      for (const p of first.pins) {
        expect(readEntry(sql, p.claimId, p.generation)?.state).toBe("parked");
      }
    }, fakes);
  });

  it("asks again for the answer's wake after its alarm write failed", async () => {
    const fakes = conflicting();
    await withTrain(async ({ train, sql, log, wakes, restart }) => {
      await park(train, fakes);
      const [conflict] = train.conflicts(1);
      if (conflict?.decisionId == null) throw new Error("no question was asked");
      const { decisionId } = conflict;
      fakes.head = () => fail("unavailable", "Main is down.");
      fakes.alarmDown = true;
      const asked = wakes.length;

      log.transaction((tx) => train.answered(tx, decisionId));

      // The answer and the train's wake row committed; only the alarm is missing.
      const wake = owed(sql);
      expect(wakes).toHaveLength(asked);
      expect(await train.armWake()).toBe(false);
      expect(states(train)).toEqual({ "clm_claim001@1": "queued", "clm_claim003@1": "queued" });

      // The next request asks again once the alarm can be written, and so does a restart.
      fakes.alarmDown = false;
      expect(await train.armWake()).toBe(true);
      expect(wakes.at(-1)).toBe(wake.dueAt);
      wakes.length = 0;
      const again = restart();
      expect(await again.startup()).toBe(true);
      expect(wakes).toEqual([wake.dueAt]);
    }, fakes);
  });

  it("checks asked pairs for released claims in turn, a bounded batch per wake", async () => {
    const fakes = new Fakes();
    fakes.head = () => fail("unavailable", "Main is down.");
    await withTrain(async ({ train, sql, now }) => {
      const pairs = seedAskedPairs(sql, fakes, MAX_RELEASE_READS + 2, now());
      const last = pairs.at(-1);
      if (last === undefined) throw new Error("no pair was seeded");
      // Both claims of the newest pair are no longer held.
      for (const p of last.pins) fakes.pins.delete(p.claimId);

      // The first wake checks the oldest MAX_RELEASE_READS pairs, which are all still held.
      await train.resume();
      expect(conflictStates(sql)).toEqual({ asked: MAX_RELEASE_READS + 2 });

      // The next one reaches the rest, then the oldest again.
      await train.resume();
      expect(conflictStates(sql)).toEqual({ asked: MAX_RELEASE_READS + 1, closed: 1 });
      expect(readConflict(sql, last.batchId)?.state).toBe("closed");
      expect(fakes.withdrawn).toEqual([last.decisionId]);
      for (const p of last.pins) {
        expect(readEntry(sql, p.claimId, p.generation)?.state).not.toBe("parked");
      }
    }, fakes);
  });

  it("asks nothing about a pair whose claim was readied again while its question was owed", async () => {
    const fakes = conflicting();
    const answer = fakes.answerAsk;
    fakes.answerAsk = () => fail("unavailable", "Not yet.");
    await withTrain(async ({ train }) => {
      await park(train, fakes);
      expect(train.conflicts(1)).toMatchObject([{ state: "asking" }]);
      const attempts = fakes.asked.length;

      // Claim 1 is readied again with the same commit before the question could be asked.
      fakes.head = () => fail("unavailable", "Main is down.");
      expect(await train.enqueue(pin(1))).toEqual(ok({ queued: true }));
      fakes.answerAsk = answer;
      await train.drive();

      expect(fakes.asked).toHaveLength(attempts);
      expect(train.conflicts(1)).toMatchObject([{ state: "redone", decisionId: null }]);
      expect(states(train)).toEqual({ "clm_claim001@1": "queued", "clm_claim003@1": "queued" });
    }, fakes);
  });

  it("asks nothing about a pair an entry of which is no longer parked", async () => {
    const fakes = conflicting();
    const answer = fakes.answerAsk;
    fakes.answerAsk = () => fail("unavailable", "Not yet.");
    await withTrain(async ({ train, sql, now, advance }) => {
      await park(train, fakes);
      const attempts = fakes.asked.length;
      // A newer episode holds claim 3's entry, which is waiting rather than parked.
      sql.exec(
        "UPDATE train_queue SET state = 'queued', episode = episode + 1 WHERE claim_id = ?",
        pin(3).claimId,
      );
      fakes.head = () => fail("unavailable", "Main is down.");
      fakes.answerAsk = answer;
      advance(owedQuestion(train).retryAt - now());
      await train.drive();

      expect(fakes.asked).toHaveLength(attempts);
      expect(train.conflicts(1)).toMatchObject([{ state: "redone", decisionId: null }]);
      expect(states(train)).toEqual({ "clm_claim001@1": "queued", "clm_claim003@1": "queued" });
    }, fakes);
  });

  it("keeps the pair parked and its question owed, with the wake armed, while the decisions module cannot ask", async () => {
    const fakes = conflicting();
    const answer = fakes.answerAsk;
    fakes.answerAsk = () => fail("unavailable", "The decisions module is missing.");
    await withTrain(async ({ train, sql, wakes, now, advance }) => {
      const outcome = await park(train, fakes);

      // The refusal does not stop the drive; the question is due again after the first delay.
      expect(outcome).toEqual({ kind: "idle" });
      expect(states(train)).toEqual({ "clm_claim001@1": "parked", "clm_claim003@1": "parked" });
      const owing = owedQuestion(train);
      expect(owing).toMatchObject({ state: "asking", decisionId: null, failures: 1 });
      expect(owing.retryAt - owing.updatedAt).toBe(QUESTION_BASE_MS);
      expect(owed(sql)).toEqual({ dueAt: owing.retryAt, failures: 0 });
      expect(wakes.at(-1)).toBe(owing.retryAt);

      // Once the module answers, the alarm asks the owed question, once.
      fakes.answerAsk = answer;
      const attempts = fakes.asked.length;
      advance(owing.retryAt - now());
      await train.resume();
      expect(fakes.asked).toHaveLength(attempts + 1);
      expect(train.conflicts(1)).toMatchObject([{ state: "asked" }]);
      expect(states(train)).toEqual({ "clm_claim001@1": "parked", "clm_claim003@1": "parked" });
      expect(readWake(sql)).toBeNull();
    }, fakes);
  });

  it("asks again after a quota refusal, backing off, until the question is asked", async () => {
    const fakes = conflicting();
    const answer = fakes.answerAsk;
    fakes.answerAsk = () => fail("quota_exceeded", "Too many decisions.");
    await withTrain(async ({ train, sql, wakes, now, advance }) => {
      await park(train, fakes);
      expect(fakes.asked).toHaveLength(1);
      const first = owedQuestion(train);
      expect(first).toMatchObject({ state: "asking", failures: 1 });
      expect(owed(sql).dueAt).toBe(first.retryAt);

      // An alarm before the question is due asks nothing. Each clock read moves the test clock by
      // one, so the alarm comes a few reads early.
      advance(first.retryAt - now() - 10);
      await train.resume();
      expect(fakes.asked).toHaveLength(1);

      // The next refusal doubles the delay, and the wake follows it.
      advance(first.retryAt - now());
      await train.resume();
      expect(fakes.asked).toHaveLength(2);
      const second = owedQuestion(train);
      expect(second).toMatchObject({ state: "asking", failures: 2 });
      expect(second.retryAt - second.updatedAt).toBe(2 * QUESTION_BASE_MS);
      expect(owed(sql)).toEqual({ dueAt: second.retryAt, failures: 0 });
      expect(wakes.at(-1)).toBe(second.retryAt);
      expect(states(train)).toEqual({ "clm_claim001@1": "parked", "clm_claim003@1": "parked" });

      // Once the decisions module takes it, the question is asked and the wake cleared.
      fakes.answerAsk = answer;
      advance(second.retryAt - now());
      await train.resume();
      expect(fakes.asked).toHaveLength(3);
      expect(train.conflicts(1)).toMatchObject([{ state: "asked", failures: 2 }]);
      expect(readWake(sql)).toBeNull();
    }, fakes);
  });

  it("waits at most QUESTION_MAX_MS between refused questions", async () => {
    const fakes = conflicting();
    fakes.answerAsk = () => fail("quota_exceeded", "Too many decisions.");
    await withTrain(async ({ train, sql, now, advance }) => {
      await park(train, fakes);
      sql.exec("UPDATE train_conflicts SET failures = 40");
      advance(owedQuestion(train).retryAt - now());
      await train.resume();

      const owing = owedQuestion(train);
      expect(owing).toMatchObject({ state: "asking", failures: 41 });
      expect(owing.retryAt - owing.updatedAt).toBe(QUESTION_MAX_MS);
      expect(owed(sql).dueAt).toBe(owing.retryAt);
    }, fakes);
  });

  it("lands other work while a parked pair's question is refused", async () => {
    const fakes = conflicting();
    fakes.answerAsk = () => fail("quota_exceeded", "Too many decisions.");
    await withTrain(async ({ train }) => {
      await park(train, fakes);
      fakes.ready(pin(2));
      expect(await train.enqueue(pin(2))).toEqual(ok({ queued: true }));

      expect(fakes.composeCalls.at(-1)?.pins).toEqual([pin(2)]);
      expect(states(train)).toMatchObject({
        "clm_claim001@1": "parked",
        "clm_claim002@1": "batched",
        "clm_claim003@1": "parked",
      });
      expect(fakes.asked).toHaveLength(1);
    }, fakes);
  });

  it("returns a pair whose question was refused unasked once a claim is no longer held", async () => {
    const fakes = conflicting();
    const answer = fakes.answerAsk;
    fakes.answerAsk = () => fail("quota_exceeded", "Too many decisions.");
    await withTrain(async ({ train, now, advance }) => {
      await park(train, fakes);
      const attempts = fakes.asked.length;
      fakes.pins.delete(pin(3).claimId);
      fakes.answerAsk = answer;
      advance(owedQuestion(train).retryAt - now());
      await train.resume();

      expect(fakes.asked).toHaveLength(attempts);
      expect(train.conflicts(1)).toMatchObject([{ state: "closed" }]);
      // Claim 1 re-entered scheduling and runs alone; claim 3's pin is gone, so it is dropped.
      expect(states(train)).toEqual({ "clm_claim001@1": "batched", "clm_claim003@1": "dropped" });
    }, fakes);
  });

  it("returns the pair unasked, each to be merged alone, when the question is invalid", async () => {
    const fakes = conflicting();
    fakes.answerAsk = () => fail("invalid_request", "The scope is not a repository path.");
    await withTrain(async ({ train, sql, now, advance }) => {
      await park(train, fakes);

      expect(fakes.asked).toHaveLength(1);
      expect(train.conflicts(1)).toMatchObject([{ state: "refused", decisionId: null }]);
      // Claim 1 runs alone; claim 3 waits for it, also alone, so the two never merge together.
      expect(fakes.composeCalls.map((call) => call.pins)).toEqual([[pin(1), pin(3)], [pin(1)]]);
      expect(train.entries(64)).toMatchObject([
        { pin: pin(1), state: "batched" },
        { pin: pin(3), state: "queued", isolate: true },
      ]);
      expect(fakes.withdrawn).toEqual([]);

      // Nothing is owed or asked about the pair again.
      advance(QUESTION_MAX_MS);
      await train.resume();
      expect(fakes.asked).toHaveLength(1);
      expect(readConflict(sql, 1)?.updatedAt).toBeLessThan(now());
    }, fakes);
  });

  it("leaves released pairs asked while the decisions module cannot withdraw, and closes them later", async () => {
    const fakes = new Fakes();
    fakes.head = () => fail("unavailable", "Main is down.");
    await withTrain(async ({ train, sql, now }) => {
      const [pair] = seedAskedPairs(sql, fakes, 1, now());
      if (pair === undefined) throw new Error("no pair was seeded");
      for (const p of pair.pins) fakes.pins.delete(p.claimId);
      fakes.withdraw = () => {
        throw new UnavailableError("decisions");
      };

      await train.resume();
      expect(readConflict(sql, pair.batchId)?.state).toBe("asked");
      for (const p of pair.pins)
        expect(readEntry(sql, p.claimId, p.generation)?.state).toBe("parked");

      fakes.withdraw = () => true;
      await train.resume();
      expect(readConflict(sql, pair.batchId)?.state).toBe("closed");
      expect(fakes.withdrawn.at(-1)).toBe(pair.decisionId);
    }, fakes);
  });

  it("returns the partner to the queue when one parked claim is ready again", async () => {
    const fakes = conflicting();
    await withTrain(async ({ train }) => {
      await park(train, fakes);
      fakes.head = () => fail("unavailable", "Main is down.");
      const redone = pin(1, 1, sha("9"));
      fakes.ready(redone);

      expect(await train.enqueue(redone)).toEqual(ok({ queued: true }));
      expect(train.conflicts(1)).toMatchObject([{ state: "redone" }]);
      expect(states(train)).toEqual({ "clm_claim001@1": "queued", "clm_claim003@1": "queued" });
      expect(train.entries(64).find((e) => e.pin.claimId === pin(1).claimId)?.pin).toEqual(redone);
      expect(fakes.asked).toHaveLength(1);
      // The question about the replaced work is withdrawn with the redo.
      expect(fakes.withdrawn).toEqual(["dec_decision0001"]);
    }, fakes);
  });

  it("leaves a parked pair alone when an unrelated claim is queued", async () => {
    const fakes = conflicting();
    await withTrain(async ({ train }) => {
      await park(train, fakes);
      fakes.ready(pin(2));
      await train.enqueue(pin(2));

      expect(train.conflicts(1)).toMatchObject([{ state: "asked" }]);
      expect(states(train)).toMatchObject({
        "clm_claim001@1": "parked",
        "clm_claim003@1": "parked",
      });
    }, fakes);
  });
});

describe("train boundaries", () => {
  it("settles every pin of a full batch that cannot compose in one call", async () => {
    const fakes = new Fakes();
    fakes.head = () => fail("unavailable", "Not yet.");
    fakes.compose = () => ok({ kind: "error", reason: "unsupported" });
    await withTrain(async ({ train }) => {
      const pins = Array.from({ length: 8 }, (_, n) => pin(n + 1));
      fakes.ready(...pins);
      for (const p of pins) await train.enqueue(p);
      fakes.head = () => ok(fakes.main);

      expect(await train.drive()).toEqual({ kind: "idle" });
      expect(fakes.composeCalls.map((c) => c.pins.length)).toEqual([8, 1, 1, 1, 1, 1, 1, 1, 1]);
      expect(train.entries(64).map((e) => [e.state, e.reason])).toEqual(
        pins.map(() => ["dropped", "compose_failed"]),
      );
    }, fakes);
  });

  it("returns a committed enqueue when a port rejects during the drive", async () => {
    const fakes = new Fakes();
    fakes.compose = () => {
      throw new Error("sandbox RPC failed");
    };
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1));
      expect(await train.enqueue(pin(1))).toEqual(ok({ queued: true }));
      expect(train.batches(1)[0]).toMatchObject({ state: "composing" });

      fakes.compose = (main, pins) => ok({ kind: "clean", candidate: candidateOf(main, pins) });
      expect(await train.drive()).toMatchObject({ kind: "checking" });
      expect(pinsOf(lastStarted(fakes))).toEqual([pin(1)]);
    }, fakes);
  });
  it("starts nothing unless main holds exactly one valid trusted definition", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1));
      fakes.definitions = () => ok([]);
      await train.enqueue(pin(1));
      expect(await train.drive()).toMatchObject({
        kind: "blocked",
        reason: "definitions_not_single",
      });

      fakes.definitions = (main) => ok([definition(main), { ...definition(main), name: "lint" }]);
      expect(await train.drive()).toMatchObject({
        kind: "blocked",
        reason: "definitions_not_single",
      });

      fakes.definitions = () => ok([definition(sha("8"))]);
      expect(await train.drive()).toMatchObject({ kind: "blocked", reason: "definition_invalid" });

      fakes.definitions = () => fail("unavailable", "Not installed.");
      expect(await train.drive()).toMatchObject({
        kind: "blocked",
        reason: "definitions_unavailable",
        code: "unavailable",
      });
      expect(fakes.composeCalls).toEqual([]);
      expect(train.batches(64)).toEqual([]);
      expect(train.entries(1)[0]).toMatchObject({ state: "queued" });
    }, fakes);
  });

  it("drops a pin whose claim has moved on before composing it", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1, 2));
      expect(await train.enqueue(pin(1, 1))).toEqual(ok({ queued: true }));

      expect(train.entries(1)[0]).toMatchObject({ state: "dropped", reason: "pin_changed" });
      expect(fakes.composeCalls).toEqual([]);
      expect(await train.enqueue(pin(1, 2))).toEqual(ok({ queued: true }));
      expect(pinsOf(lastStarted(fakes))).toEqual([pin(1, 2)]);
    }, fakes);
  });

  it("requeues for a fresh composition when authorization refuses the pass", async () => {
    const fakes = new Fakes();
    fakes.authorize = () => fail("decision_superseded", "A newer decision exists.");
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      const first = lastStarted(fakes);
      await train.recordCheck(report(first, "pass"));

      expect(train.batches(2).map((b) => [b.state, b.failure])).toEqual([
        ["checking", null],
        ["failed", "authorization_refused"],
      ]);
      expect(lastStarted(fakes).attemptId).not.toBe(first.attemptId);
      expect(fakes.published).toEqual([]);
      expect(fakes.main).toBe(MAIN);
    }, fakes);
  });

  it("keeps a passed batch active while authorization or publication cannot answer", async () => {
    const fakes = new Fakes();
    fakes.authorize = () => fail("unavailable", "Not installed.");
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1), pin(2));
      await train.enqueue(pin(1));
      await train.recordCheck(report(lastStarted(fakes), "pass"));
      await train.enqueue(pin(2));

      expect(await train.drive()).toMatchObject({
        kind: "blocked",
        reason: "authorization_unavailable",
      });
      expect(train.batches(64).map((b) => b.state)).toEqual(["passed"]);
      expect(fakes.composeCalls).toHaveLength(1);

      fakes.authorize = (attempt) => ok(intentFor(attempt, 0));
      fakes.publishOverride = (record) => ok({ ...record, status: "authorized" });
      expect(await train.drive()).toMatchObject({ kind: "blocked", reason: "publish_pending" });
      expect(train.batches(64).map((b) => b.state)).toEqual(["passed"]);

      // The writer reconciles and finds main at the candidate: the batch lands without a new intent.
      fakes.publishOverride = (record) =>
        ok({ ...record, status: "reconciled", main: record.candidate });
      expect(await train.drive()).toMatchObject({ kind: "checking" });
      expect(train.batches(64).map((b) => b.state)).toEqual(["checking", "landed"]);
      expect(new Set(fakes.published).size).toBe(1);
    }, fakes);
  });
});

describe("train wake", () => {
  it("backs off after a drive throws and lands once the alarm resumes, with no other call", async () => {
    const fakes = new Fakes();
    fakes.compose = () => {
      throw new Error("sandbox RPC failed");
    };
    await withTrain(async ({ train, sql, wakes, now, advance }) => {
      fakes.ready(pin(1));
      const accepted = now() + 1;
      expect(await train.enqueue(pin(1))).toEqual(ok({ queued: true }));
      expect(owed(sql)).toEqual({ dueAt: now() + WAKE_BASE_MS, failures: 1 });
      // The alarm due at once, set with the queue entry, the drive's own lease, then the backoff
      // that moved the alarm earlier.
      expect(wakes).toEqual([accepted, accepted + 1 + DRIVE_LEASE_MS, now() + WAKE_BASE_MS]);

      // An alarm set by another module fires early: nothing is driven, and the wake is asked again.
      fakes.compose = (main, pins) => ok({ kind: "clean", candidate: candidateOf(main, pins) });
      await train.resume();
      expect(fakes.composeCalls).toHaveLength(1);
      expect(wakes).toHaveLength(4);
      expect(wakes[3]).toBe(wakes[2]);

      advance(WAKE_BASE_MS);
      await train.resume();
      const attempt = lastStarted(fakes);
      expect(pinsOf(attempt)).toEqual([pin(1)]);
      // Waiting for the runner's report owes a drive at the attempt's deadline.
      const [checking] = train.batches(1);
      expect(checking?.checkDeadline).toBe(attempt.createdAt + 1 + CHECK_DEADLINE_MS);
      expect(owed(sql)).toEqual({ dueAt: checking?.checkDeadline, failures: 0 });
      expect(wakes.at(-1)).toBe(checking?.checkDeadline);

      await train.recordCheck(report(attempt, "pass"));
      expect(fakes.main).toBe(attempt.candidate);
      expect(readWake(sql)).toBeNull();
    }, fakes);
  });

  it("doubles the delay while a port refuses, then stops asking but keeps the work", async () => {
    const fakes = new Fakes();
    fakes.compose = () => fail("unavailable", "Sandbox offline.");
    await withTrain(async ({ train, sql, wakes, now, advance }) => {
      fakes.ready(pin(1), pin(2));
      await train.enqueue(pin(1));
      expect(owed(sql).failures).toBe(1);

      for (let failures = 2; failures <= MAX_WAKE_FAILURES; failures += 1) {
        advance(owed(sql).dueAt - now());
        await train.resume();
        const delay = Math.min(WAKE_BASE_MS * 2 ** (failures - 1), WAKE_MAX_MS);
        expect(owed(sql)).toEqual({ dueAt: now() + delay, failures });
      }
      expect(owed(sql).dueAt - now()).toBe(WAKE_MAX_MS);
      // The enqueue's lease, then each drive's lease and its backoff.
      expect(wakes).toHaveLength(2 * MAX_WAKE_FAILURES + 1);

      // The last drive asks for its lease but no backoff.
      advance(WAKE_MAX_MS);
      await train.resume();
      expect(owed(sql)).toEqual({ dueAt: now(), failures: EXHAUSTED_FAILURES });
      expect(wakes).toHaveLength(2 * MAX_WAKE_FAILURES + 2);
      expect(fakes.composeCalls).toHaveLength(MAX_WAKE_FAILURES + 1);
      expect(train.batches(64)).toMatchObject([{ batchId: 1, state: "composing" }]);

      // An alarm another module asked for neither drives exhausted work nor asks again.
      advance(WAKE_MAX_MS);
      await train.resume();
      expect(fakes.composeCalls).toHaveLength(MAX_WAKE_FAILURES + 1);
      expect(wakes).toHaveLength(2 * MAX_WAKE_FAILURES + 2);

      // The work stayed in storage: the next call composes the same batch again.
      fakes.compose = (main, pins) => ok({ kind: "clean", candidate: candidateOf(main, pins) });
      expect(await train.enqueue(pin(2))).toEqual(ok({ queued: true }));
      expect(pinsOf(lastStarted(fakes))).toEqual([pin(1)]);
      expect(train.batches(64)).toMatchObject([
        { batchId: 1, state: "checking", checkStarted: true },
      ]);
    }, fakes);
  });

  it("keeps a wake for owed work through accept, failure, exhaustion, a duplicate ready, a crash and a deadline", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, sql, wakes, restart, now, advance }) => {
      fakes.ready(pin(1));

      // Accept: the pin is composed and its check started; the wake waits for the deadline.
      await train.enqueue(pin(1));
      const first = lastStarted(fakes);
      expectDebtCovered(sql, wakes, false);

      // Fail: an errored check sends the pin back, and its next batch stops on the merge port.
      fakes.compose = () => fail("unavailable", "Sandbox offline.");
      await train.recordCheck(report(first, "error"));
      expect(train.batches(2).map((b) => [b.state, b.failure])).toEqual([
        ["composing", null],
        ["failed", "check_error"],
      ]);
      expect(owed(sql).failures).toBe(1);
      expectDebtCovered(sql, wakes, false);

      // Retry until exhaustion: the work stays stored under an exhausted row and no alarm.
      while (owed(sql).failures <= MAX_WAKE_FAILURES) {
        advance(owed(sql).dueAt - now());
        await train.resume();
        expectDebtCovered(sql, wakes, owed(sql).failures === EXHAUSTED_FAILURES);
      }
      const asked = wakes.length;
      const composes = fakes.composeCalls.length;

      // Duplicate ready: the existing pin restores the wake due at once, and the drive that follows
      // commits a due wake with its lease before the merge port is asked, which then stops
      // answering.
      fakes.compose = (main, pins) => ok({ kind: "clean", candidate: candidateOf(main, pins) });
      const release = fakes.hold("merge.compose");
      const requeued = now() + 1;
      const duplicate = train.enqueue(pin(1));
      await vi.waitFor(() => expect(fakes.composeCalls).toHaveLength(composes + 1));
      // Due when the drive started, before the merge attempt was recorded and the port asked.
      const started = owed(sql);
      expect(started).toEqual({ dueAt: now() - 1, failures: 0 });
      expect(wakes.slice(asked)).toEqual([requeued, started.dueAt + DRIVE_LEASE_MS]);
      expectDebtCovered(sql, wakes, false);

      // Crash: the object stops mid-drive. The rebuilt train asks for the wake again.
      const again = restart();
      expect(wakes.at(-1)).toBe(owed(sql).dueAt);
      expectDebtCovered(sql, wakes, false);

      // The lease alarm resumes the retained batch with no other call.
      fakes.holds.delete("merge.compose");
      advance(DRIVE_LEASE_MS);
      await again.resume();
      const resumed = lastStarted(fakes);
      expect(pinsOf(resumed)).toEqual([pin(1)]);
      expect(again.batches(1)).toMatchObject([
        { batchId: 2, state: "checking", checkStarted: true },
      ]);
      expectDebtCovered(sql, wakes, false);

      // The stopped drive's late answer changes nothing.
      release();
      expect(await duplicate).toEqual(ok({ queued: false }));
      expect(again.batches(1)).toMatchObject([{ batchId: 2, attemptId: resumed.attemptId }]);
      expectDebtCovered(sql, wakes, false);

      // Deadline: the silent attempt expires and the pin is checked on a fresh one.
      advance(owed(sql).dueAt - now());
      await again.resume();
      const fresh = lastStarted(fakes);
      expect(fresh.attemptId).not.toBe(resumed.attemptId);
      expect(again.batches(2).map((b) => [b.state, b.failure])).toEqual([
        ["checking", null],
        ["failed", "check_timeout"],
      ]);
      expectDebtCovered(sql, wakes, false);

      // Land: nothing is owed and the row is gone.
      await again.recordCheck(report(fresh, "pass"));
      expect(states(again)).toEqual({ "clm_claim001@1": "landed" });
      expect(readWake(sql)).toBeNull();
      expectDebtCovered(sql, wakes, false);
    }, fakes);
  });

  it("restores the wake when a duplicate report restarts an exhausted landing, so the alarm lands it after a crash", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, sql, wakes, restart, now, advance }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      const attempt = lastStarted(fakes);
      fakes.authorize = () => fail("unavailable", "Authorization offline.");
      const passed = report(attempt, "pass");
      expect(await train.recordCheck(passed)).toEqual(ok(attempt));
      while (owed(sql).failures <= MAX_WAKE_FAILURES) {
        advance(owed(sql).dueAt - now());
        await train.resume();
      }
      expect(owed(sql).failures).toBe(EXHAUSTED_FAILURES);
      expect(train.batches(1)).toMatchObject([{ state: "passed", intentId: null }]);
      const asked = wakes.length;

      // The runner repeats its report; the drive it starts hangs on authorization.
      fakes.authorize = (a) => ok(intentFor(a, fakes.authorized.length));
      const release = fakes.hold("authorization.authorize");
      const authorizations = fakes.authorized.length;
      const duplicate = train.recordCheck(passed);
      await vi.waitFor(() => expect(fakes.authorized).toHaveLength(authorizations + 1));
      expect(owed(sql)).toEqual({ dueAt: now(), failures: 0 });
      expect(wakes.slice(asked)).toEqual([now() + DRIVE_LEASE_MS]);

      // The object stops; the lease alarm alone lands the batch under the same attempt.
      const again = restart();
      fakes.holds.delete("authorization.authorize");
      advance(DRIVE_LEASE_MS);
      await again.resume();
      expect(fakes.main).toBe(attempt.candidate);
      expect(fakes.authorized.slice(authorizations)).toEqual([
        attempt.attemptId,
        attempt.attemptId,
      ]);
      expect(states(again)).toEqual({ "clm_claim001@1": "landed" });
      expect(readWake(sql)).toBeNull();

      release();
      expect(await duplicate).toEqual(ok(attempt));
      expect(fakes.published).toHaveLength(1);
    }, fakes);
  });

  it("restores no wake when a duplicate ready finds no stored work", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, sql, wakes }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      await train.recordCheck(report(lastStarted(fakes), "pass"));
      expect(readWake(sql)).toBeNull();
      const asked = wakes.length;

      // The landed commit is not work again, so the train refuses it and stores nothing.
      expect(await train.enqueue(pin(1))).toMatchObject({ ok: false, code: "decision_superseded" });
      expect(readWake(sql)).toBeNull();
      // With nothing owed, the drive asks for no alarm either.
      expect(wakes).toHaveLength(asked);
      expect(fakes.composeCalls).toHaveLength(1);
    }, fakes);
  });

  it("asks again for an owed drive after a restart and resumes an enqueue cut short", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ sql, wakes, restart }) => {
      fakes.ready(pin(1));
      // What an enqueue leaves when the object stops after its commit, before any drive or alarm.
      insertEntry(sql, pin(1), 1, 1);
      writeWake(sql, { dueAt: 1, failures: 0 });

      const again = restart();
      expect(wakes).toEqual([1]);
      expect(fakes.composeCalls).toEqual([]);

      await again.resume();
      expect(pinsOf(lastStarted(fakes))).toEqual([pin(1)]);
      // Now the train waits for the report until the attempt's deadline.
      expect(owed(sql)).toEqual({ dueAt: again.batches(1)[0]?.checkDeadline, failures: 0 });
    }, fakes);
  });

  it("drives again when reports arrive before both coalesced starts are acknowledged", async () => {
    const fakes = new Fakes();
    const gates: (() => void)[] = [];
    fakes.startGate = () => new Promise<void>((resolve) => gates.push(resolve));
    await withTrain(async ({ train, sql, wakes, now }) => {
      fakes.ready(pin(1), pin(2));
      const calls: Promise<unknown>[] = [train.enqueue(pin(1))];
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      calls.push(train.enqueue(pin(2)));
      const first = lastStarted(fakes);
      calls.push(train.recordCheck(report(first, "pass")));
      gates[0]?.();

      // The second pass lands the first batch and waits on the second batch's start.
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      const second = lastStarted(fakes);
      expect(pinsOf(second)).toEqual([pin(2)]);
      calls.push(train.recordCheck(report(second, "pass")));
      gates[1]?.();
      await Promise.all(calls);

      // Two passes ran; the passed second batch is owed a drive now rather than left to stall.
      expect(train.batches(64).map((b) => b.state)).toEqual(["passed", "landed"]);
      expect(owed(sql)).toEqual({ dueAt: now(), failures: 0 });
      expect(wakes.at(-1)).toBe(now());

      await train.resume();
      expect(train.batches(64).map((b) => b.state)).toEqual(["landed", "landed"]);
      expect(fakes.main).toBe(second.candidate);
      expect(fakes.published).toHaveLength(2);
      expect(new Set(fakes.published).size).toBe(2);
      expect(readWake(sql)).toBeNull();
    }, fakes);
  });
});

describe("train check deadline", () => {
  it("expires a started attempt with no report at its deadline and lands the pin on a fresh one", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, sql, wakes, restart, now, advance, events }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      const silent = lastStarted(fakes);
      const deadline = owed(sql).dueAt;
      expect(train.batches(1)).toMatchObject([{ state: "checking", checkDeadline: deadline }]);
      expect(wakes.at(-1)).toBe(deadline);

      // A restart before the deadline asks for the same wake, and resuming early changes nothing.
      const again = restart();
      expect(wakes.at(-1)).toBe(deadline);
      advance(deadline - now() - 10);
      await again.resume();
      expect(fakes.started).toHaveLength(1);
      expect(again.batches(1)).toMatchObject([{ state: "checking", failure: null }]);

      advance(10);
      await again.resume();
      const timedOut = {
        type: "train.unreported",
        actor: { kind: "system", id: "sys_train" },
        data: { checkRunId: silent.attemptId, candidate: silent.candidate, outcome: "timed_out" },
      };
      expect(events()).toMatchObject([timedOut]);
      const fresh = lastStarted(fakes);
      expect(fresh.attemptId).not.toBe(silent.attemptId);
      expect(pinsOf(fresh)).toEqual([pin(1)]);
      expect(again.batches(2).map((b) => [b.state, b.failure])).toEqual([
        ["checking", null],
        ["failed", "check_timeout"],
      ]);
      expect(again.entries(1)).toMatchObject([{ state: "batched", retries: 1 }]);
      expect(owed(sql).dueAt).toBe(again.batches(1)[0]?.checkDeadline);

      // The expired attempt's late pass is refused and leaves it without a result.
      expect(await again.recordCheck(report(silent, "pass"))).toMatchObject({
        ok: false,
        code: "check_mismatch",
      });
      expect(again.attemptOutcome(silent.attemptId)).toEqual({ attempt: silent, report: null });
      // Neither the refused report nor another drive records the expiry again.
      await again.resume();
      expect(events()).toMatchObject([timedOut]);

      expect(await again.recordCheck(report(fresh, "pass"))).toEqual(ok(fresh));
      expect(fakes.authorized).toEqual([fresh.attemptId]);
      expect(fakes.main).toBe(fresh.candidate);
      expect(readWake(sql)).toBeNull();
    }, fakes);
  });

  it("refuses a report that arrives at the deadline, before any drive expires the attempt", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, sql, now, advance, events }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      const attempt = lastStarted(fakes);
      // The report reads the clock once more, which lands exactly on the deadline.
      advance(owed(sql).dueAt - now() - 1);

      expect(await train.recordCheck(report(attempt, "pass"))).toMatchObject({
        ok: false,
        code: "check_mismatch",
      });
      expect(train.batches(1)).toMatchObject([{ state: "checking", checkResult: null }]);
      expect(events()).toEqual([]);

      await train.resume();
      expect(train.batches(2).map((b) => b.failure)).toEqual([null, "check_timeout"]);
      expect(events()).toMatchObject([
        { type: "train.unreported", data: { checkRunId: attempt.attemptId, outcome: "timed_out" } },
      ]);
      expect(fakes.authorized).toEqual([]);
      expect(fakes.main).toBe(MAIN);
    }, fakes);
  });

  it("drops a pin whose attempts keep expiring and moves the next queued pin", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, sql, now, advance, events }) => {
      fakes.ready(pin(1), pin(2));
      await train.enqueue(pin(1));
      await train.enqueue(pin(2));
      const expired: string[] = [];
      for (let expiry = 0; expiry <= MAX_RETRIES; expiry += 1) {
        expired.push(lastStarted(fakes).attemptId);
        advance(owed(sql).dueAt - now());
        await train.resume();
      }
      // Each expired attempt is logged once, under its own id.
      expect(
        events().map((e) => (e.type === "train.unreported" ? e.data.checkRunId : e.type)),
      ).toEqual(expired);
      expect(states(train)).toEqual({ "clm_claim001@1": "dropped", "clm_claim002@1": "batched" });
      expect(train.entries(64).find((e) => e.pin.claimId === pin(1).claimId)?.reason).toBe(
        "retries_exhausted",
      );
      const last = lastStarted(fakes);
      expect(pinsOf(last)).toEqual([pin(2)]);
      expect(await train.recordCheck(report(last, "pass"))).toEqual(ok(last));
      expect(states(train)).toEqual({ "clm_claim001@1": "dropped", "clm_claim002@1": "landed" });
      expect(fakes.authorized).toEqual([last.attemptId]);
    }, fakes);
  });
});

describe("train held checks", () => {
  it("splits a held shared batch, parks the pin held alone and moves the pins behind it", async () => {
    const fakes = new Fakes();
    const offender = pin(1);
    // The check port holds every candidate that carries the offender's change.
    fakes.start = (attempt) =>
      attempt.pins.some((p) => p.claimId === offender.claimId)
        ? fail("check_held", "The candidate edits protected check paths.")
        : ok({ attemptId: attempt.attemptId });
    fakes.head = () => fail("unavailable", "Not yet.");
    await withTrain(async ({ train, sql, now, advance, events }) => {
      fakes.ready(offender, pin(2));
      await train.enqueue(offender);
      await train.enqueue(pin(2));
      fakes.head = () => ok(fakes.main);
      expect(await train.drive()).toMatchObject({ kind: "blocked", reason: "check_held" });
      expect(pinsOf(lastStarted(fakes))).toEqual([offender, pin(2)]);
      // A later pin queues behind the held batch.
      fakes.ready(pin(3));
      await train.enqueue(pin(3));

      // Past the deadline the shared batch splits; the offender, first, is held again alone.
      advance(owed(sql).dueAt - now());
      await train.resume();
      expect(pinsOf(lastStarted(fakes))).toEqual([offender]);
      expect(states(train)).toMatchObject({
        "clm_claim002@1": "queued",
        "clm_claim003@1": "queued",
      });

      // Held alone past its deadline, the offender is parked and the innocent pin checks alone.
      advance(owed(sql).dueAt - now());
      await train.resume();
      const innocent = lastStarted(fakes);
      expect(pinsOf(innocent)).toEqual([pin(2)]);
      expect(await train.recordCheck(report(innocent, "pass"))).toEqual(ok(innocent));
      const later = lastStarted(fakes);
      expect(pinsOf(later)).toEqual([pin(3)]);
      expect(await train.recordCheck(report(later, "pass"))).toEqual(ok(later));

      expect(fakes.main).toBe(later.candidate);
      expect(states(train)).toEqual({
        "clm_claim001@1": "parked",
        "clm_claim002@1": "landed",
        "clm_claim003@1": "landed",
      });
      expect(train.entries(64).find((e) => e.pin.claimId === offender.claimId)).toMatchObject({
        pin: offender,
        retries: 0,
        reason: "check_held",
      });
      // Nothing is left to drive: the parked pin owes no wake.
      expect(readWake(sql)).toBeNull();
      // A held attempt is logged by the check port as `train.held`, never as unreported.
      expect(events().map((e) => e.type)).toEqual(["train.check", "train.check"]);
    }, fakes);
  });

  it("checks a held claim again once a new push enqueues its next generation", async () => {
    const fakes = new Fakes();
    const held = pin(1);
    const pushed = pin(1, 2, sha("9"));
    fakes.start = (attempt) =>
      attempt.pins.some((p) => p.claimId === held.claimId && p.generation === held.generation)
        ? fail("check_held", "The candidate edits protected check paths.")
        : ok({ attemptId: attempt.attemptId });
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(held);
      await train.enqueue(held);
      advance(owed(sql).dueAt - now());
      await train.resume();
      expect(states(train)).toEqual({ "clm_claim001@1": "parked" });
      const parkedAttempt = lastStarted(fakes).attemptId;
      expect(train.holds(parkedAttempt)).toBe(true);

      // The parked generation is never driven again on its own.
      await train.resume();
      expect(fakes.started.filter((a) => a.pins.some((p) => p.generation === 1))).toHaveLength(1);

      fakes.ready(pushed);
      expect(await train.enqueue(pushed)).toEqual(ok({ queued: true }));
      // The newer generation leaves the parked one stale: the train no longer holds its attempt.
      expect(train.holds(parkedAttempt)).toBe(false);
      const fresh = lastStarted(fakes);
      expect(pinsOf(fresh)).toEqual([pushed]);
      expect(await train.recordCheck(report(fresh, "pass"))).toEqual(ok(fresh));
      expect(states(train)).toEqual({ "clm_claim001@1": "parked", "clm_claim001@2": "landed" });
    }, fakes);
  });

  it("checks a same-commit re-ready again instead of parking it with the held batch", async () => {
    const fakes = new Fakes();
    fakes.start = () => fail("check_held", "The candidate edits protected check paths.");
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      expect(await train.enqueue(pin(1))).toEqual(ok({ queued: false }));

      // The held batch fails at its deadline, but the renewed entry is not parked with it.
      advance(owed(sql).dueAt - now());
      await train.resume();

      expect(train.batches(2).map((batch) => batch.failure)).toEqual([null, "check_held"]);
      expect(fakes.started).toHaveLength(2);
      expect(pinsOf(lastStarted(fakes))).toEqual([pin(1)]);
      expect(train.entries(1)[0]).toMatchObject({ state: "batched", retries: 0, reason: null });
    }, fakes);
  });
});

/** A check port that holds every candidate carrying `offender` until `approved` is set. */
function holding(fakes: Fakes, offender: ClaimPin): { approve(): void } {
  let approved = false;
  fakes.start = (attempt) =>
    !approved && attempt.pins.some((p) => p.claimId === offender.claimId)
      ? fail("check_held", "The candidate edits protected check paths.")
      : ok({ attemptId: attempt.attemptId });
  return {
    approve: () => {
      approved = true;
    },
  };
}

describe("train approvals of held checks", () => {
  it("asks again for an approved attempt the active batch still holds, under a fresh deadline", async () => {
    const fakes = new Fakes();
    const held = pin(1);
    const port = holding(fakes, held);
    await withTrain(async ({ train, sql, advance }) => {
      fakes.ready(held);
      await train.enqueue(held);
      const before = train.batches(1)[0];
      if (before?.attemptId == null || before.checkDeadline === null) throw new Error("no hold");
      expect(before.checkHeld).toBe(true);
      expect(train.holds(before.attemptId)).toBe(true);

      advance(1_000);
      port.approve();
      expect(train.releaseHeld(before.attemptId)).toBe(true);
      // Released but not yet run: the train still means to run it.
      expect(train.holds(before.attemptId)).toBe(true);
      // The release owes a drive now, not at the old deadline.
      expect(owed(sql).dueAt).toBeLessThan(before.checkDeadline);
      await train.resume();

      const after = train.batches(1)[0];
      expect(after).toMatchObject({
        batchId: before.batchId,
        attemptId: before.attemptId,
        candidate: before.candidate,
        checkHeld: false,
        checkStarted: true,
      });
      expect(after?.checkDeadline).toBeGreaterThan(before.checkDeadline);
      expect(fakes.composeCalls).toHaveLength(1);
      const run = lastStarted(fakes);
      expect(run.attemptId).toBe(before.attemptId);
      expect(await train.recordCheck(report(run, "pass"))).toEqual(ok(run));
      expect(states(train)).toEqual({ "clm_claim001@1": "landed" });
      expect(train.holds(before.attemptId)).toBe(false);
    }, fakes);
  });

  it("revives a parked pin's batch on the same candidate and attempt, without composing again", async () => {
    const fakes = new Fakes();
    const held = pin(1);
    const port = holding(fakes, held);
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(held);
      await train.enqueue(held);
      const heldBatch = train.batches(1)[0];
      advance(owed(sql).dueAt - now());
      await train.resume();
      expect(states(train)).toEqual({ "clm_claim001@1": "parked" });
      if (heldBatch?.attemptId == null) throw new Error("no hold");
      expect(train.holds(heldBatch.attemptId)).toBe(true);

      port.approve();
      expect(train.releaseHeld(heldBatch.attemptId)).toBe(true);
      expect(states(train)).toEqual({ "clm_claim001@1": "queued" });
      // Queued to revive its batch, the pin still waits for the attempt.
      expect(train.holds(heldBatch.attemptId)).toBe(true);
      await train.resume();

      expect(fakes.composeCalls).toHaveLength(1);
      expect(train.batches(2)).toEqual([
        expect.objectContaining({
          batchId: heldBatch.batchId,
          state: "checking",
          failure: null,
          attemptId: heldBatch.attemptId,
          candidate: heldBatch.candidate,
          checkHeld: false,
          checkStarted: true,
        }),
      ]);
      const run = lastStarted(fakes);
      expect(run.attemptId).toBe(heldBatch.attemptId);
      expect(await train.recordCheck(report(run, "pass"))).toEqual(ok(run));
      expect(fakes.main).toBe(heldBatch.candidate);
      expect(train.entries(1)[0]).toMatchObject({ state: "landed", approvedAttempt: null });
      expect(train.holds(heldBatch.attemptId)).toBe(false);
    }, fakes);
  });

  it("revives a parked batch only once the active batch ahead of it settles", async () => {
    const fakes = new Fakes();
    const held = pin(1);
    const port = holding(fakes, held);
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(held, pin(2));
      await train.enqueue(held);
      const heldBatch = train.batches(1)[0];
      advance(owed(sql).dueAt - now());
      await train.resume();
      await train.enqueue(pin(2));
      const other = lastStarted(fakes);
      expect(pinsOf(other)).toEqual([pin(2)]);
      if (heldBatch?.attemptId == null) throw new Error("no hold");

      // A running attempt is not held: there is nothing to release.
      expect(train.releaseHeld(other.attemptId)).toBe(false);
      port.approve();
      // The other batch is active: the parked pin waits at the front instead.
      expect(train.releaseHeld(heldBatch.attemptId)).toBe(true);
      expect(train.batches(1)[0]?.attemptId).toBe(other.attemptId);
      expect(await train.recordCheck(report(other, "fail"))).toEqual(ok(other));

      const run = lastStarted(fakes);
      expect(run.attemptId).toBe(heldBatch.attemptId);
      expect(run.expectedMain).toBe(heldBatch.expectedMain);
      expect(fakes.composeCalls).toHaveLength(2);
    }, fakes);
  });

  it("refuses an attempt the train does not hold, changing nothing", async () => {
    const fakes = new Fakes();
    const offender = pin(1);
    holding(fakes, offender);
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(offender, pin(2));
      fakes.head = () => fail("unavailable", "Not yet.");
      await train.enqueue(offender);
      await train.enqueue(pin(2));
      fakes.head = () => ok(fakes.main);
      await train.drive();
      const shared = train.batches(1)[0];
      if (shared?.attemptId == null) throw new Error("no hold");
      expect(shared.pins).toHaveLength(2);

      // Past its deadline a shared batch splits: its candidate is gone.
      advance(owed(sql).dueAt - now());
      await train.resume();
      expect(train.holds(shared.attemptId)).toBe(false);
      expect(train.releaseHeld(shared.attemptId)).toBe(false);
      expect(train.holds("chk_unknown000")).toBe(false);
      expect(train.releaseHeld("chk_unknown000")).toBe(false);
      // The split pins went on alone, untouched by the refused release.
      expect(pinsOf(train.batches(1)[0])).toEqual([offender]);
      expect(states(train)).toMatchObject({
        "clm_claim001@1": "batched",
        "clm_claim002@1": "queued",
      });
    }, fakes);
  });

  it("drops a parked pin whose claim moved on before its batch could be revived", async () => {
    const fakes = new Fakes();
    const held = pin(1);
    const port = holding(fakes, held);
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(held);
      await train.enqueue(held);
      const heldBatch = train.batches(1)[0];
      advance(owed(sql).dueAt - now());
      await train.resume();
      if (heldBatch?.attemptId == null) throw new Error("no hold");

      port.approve();
      expect(train.releaseHeld(heldBatch.attemptId)).toBe(true);
      // The claim moved on after the approval, before the train drove the pin back.
      fakes.ready(pin(1, 2, sha("9")));
      await train.resume();

      expect(states(train)).toEqual({ "clm_claim001@1": "dropped" });
      expect(fakes.started).toHaveLength(1);
      expect(train.batches(1)[0]).toMatchObject({ state: "failed", failure: "check_held" });
    }, fakes);
  });

  it("lets an approval that lands after the deadline but before the drive expires it win", async () => {
    const fakes = new Fakes();
    const held = pin(1);
    const port = holding(fakes, held);
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(held);
      await train.enqueue(held);
      const heldBatch = train.batches(1)[0];
      if (heldBatch?.attemptId == null) throw new Error("no hold");
      advance(owed(sql).dueAt - now() + 1);

      port.approve();
      expect(train.releaseHeld(heldBatch.attemptId)).toBe(true);
      await train.resume();
      expect(train.batches(1)[0]).toMatchObject({
        batchId: heldBatch.batchId,
        state: "checking",
        checkStarted: true,
      });
      // A second release of the same attempt finds nothing held.
      expect(train.releaseHeld(heldBatch.attemptId)).toBe(false);
    }, fakes);
  });
});

/** Enqueues `held` alone and drives it past its deadline, so it is parked for its held attempt. */
async function parkHeld(
  { train, fakes, sql, now, advance }: Harness,
  held: ClaimPin,
): Promise<{ attemptId: string; candidate: CommitSha; mergeAttempt: string }> {
  fakes.ready(held);
  await train.enqueue(held);
  const batch = train.batches(1)[0];
  const attemptId = batch?.attemptId;
  const candidate = batch?.candidate;
  const mergeAttempt = fakes.composeAttempts.at(-1);
  if (attemptId == null || candidate == null || mergeAttempt === undefined) {
    throw new Error("no hold");
  }
  advance(owed(sql).dueAt - now());
  await train.resume();
  expect(train.entries(64).find((entry) => entry.pin.claimId === held.claimId)?.state).toBe(
    "parked",
  );
  return { attemptId, candidate, mergeAttempt };
}

/** The `train.held_expired` events in `events`, with who recorded each. */
function heldExpiries(events: RailheadEvent[]) {
  return events.flatMap((event) =>
    event.type === "train.held_expired" ? [{ actor: event.actor, ...event.data }] : [],
  );
}

const TRAIN = { kind: "system", id: "sys_train" } as const;

describe("train parked held pins", () => {
  it("expires the longest-parked pin once MAX_PARKED_HELD newer ones are parked", async () => {
    const fakes = new Fakes();
    fakes.start = () => fail("check_held", "The candidate edits protected check paths.");
    await withTrain(async (harness) => {
      const { train, sql, advance } = harness;
      const parked = [];
      for (let n = 1; n <= MAX_PARKED_HELD + 1; n += 1)
        parked.push(await parkHeld(harness, pin(n)));
      const [oldest, ...kept] = parked;
      if (oldest === undefined) throw new Error("nothing parked");

      // Parking one past the bound dropped the oldest, and only it.
      expect(train.entries(64).find((entry) => entry.pin.claimId === pin(1).claimId)).toMatchObject(
        { state: "dropped", reason: "held_expired" },
      );
      expect(Object.values(states(train)).filter((state) => state === "parked")).toHaveLength(
        MAX_PARKED_HELD,
      );
      expect(train.holds(oldest.attemptId)).toBe(false);
      expect(train.releaseHeld(oldest.attemptId)).toBe(false);
      for (const { attemptId } of kept) expect(train.holds(attemptId)).toBe(true);
      // The log records the expiry once, so the board stops offering its approval.
      expect(heldExpiries(harness.events())).toEqual([
        {
          actor: TRAIN,
          checkRunId: oldest.attemptId,
          candidate: oldest.candidate,
          reason: "over_limit",
        },
      ]);

      // Its candidate goes once its compose can no longer push; the others keep theirs.
      expect(pendingDiscards(sql).map((d) => d.attempt)).toEqual([oldest.mergeAttempt]);
      advance(MERGE_PUSH_WINDOW_MS);
      await train.resume();
      expect(fakes.discards).toEqual([oldest.mergeAttempt]);
      expect(fakes.candidateRefs.size).toBe(MAX_PARKED_HELD);
      expect(heldExpiries(harness.events())).toHaveLength(1);
    }, fakes);
  });

  it("expires a parked pin on the alarm HELD_PARK_TTL_MS after it was parked", async () => {
    const fakes = new Fakes();
    holding(fakes, pin(1));
    await withTrain(async (harness) => {
      const { train, sql, wakes, now, advance, events } = harness;
      const { attemptId, candidate, mergeAttempt } = await parkHeld(harness, pin(1));
      const parkedAt = now();
      // With nothing else owed, the alarm is asked for the expiry.
      expect(wakes.at(-1)).toBeGreaterThan(parkedAt + HELD_PARK_TTL_MS - 10);
      expect(wakes.at(-1)).toBeLessThanOrEqual(parkedAt + HELD_PARK_TTL_MS);

      advance(HELD_PARK_TTL_MS - 10);
      await train.resume();
      expect(states(train)).toEqual({ "clm_claim001@1": "parked" });
      expect(train.holds(attemptId)).toBe(true);
      expect(pendingDiscards(sql)).toEqual([]);
      expect(heldExpiries(events())).toEqual([]);

      advance(10);
      await train.resume();
      expect(train.entries(1)[0]).toMatchObject({ state: "dropped", reason: "held_expired" });
      expect(heldExpiries(events())).toEqual([
        { actor: TRAIN, checkRunId: attemptId, candidate, reason: "timed_out" },
      ]);
      expect(train.holds(attemptId)).toBe(false);
      expect(train.releaseHeld(attemptId)).toBe(false);
      expect(pendingDiscards(sql).map((d) => d.attempt)).toEqual([mergeAttempt]);
      advance(MERGE_PUSH_WINDOW_MS);
      await train.resume();
      expect(fakes.discards).toEqual([mergeAttempt]);
      expect(fakes.candidateRefs.size).toBe(0);
      expect(heldExpiries(events())).toHaveLength(1);
    }, fakes);
  });

  it("refuses an approval that comes after the expiry but before the alarm, and expires the pin", async () => {
    const fakes = new Fakes();
    const port = holding(fakes, pin(1));
    await withTrain(async (harness) => {
      const { train, sql, advance, events } = harness;
      const { attemptId, candidate, mergeAttempt } = await parkHeld(harness, pin(1));

      advance(HELD_PARK_TTL_MS);
      port.approve();
      expect(train.releaseHeld(attemptId)).toBe(false);
      expect(train.entries(1)[0]).toMatchObject({ state: "dropped", reason: "held_expired" });
      expect(pendingDiscards(sql).map((d) => d.attempt)).toEqual([mergeAttempt]);
      expect(fakes.started).toHaveLength(1);
      // The refused approval's transaction records the expiry; the alarm finds nothing more.
      expect(heldExpiries(events())).toEqual([
        { actor: TRAIN, checkRunId: attemptId, candidate, reason: "timed_out" },
      ]);
      expect(train.releaseHeld(attemptId)).toBe(false);
      await train.resume();
      expect(heldExpiries(events())).toHaveLength(1);
    }, fakes);
  });

  it("refuses a held expiry appended by an agent or a person, and records nothing", async () => {
    await withTrain(async ({ log, events }) => {
      for (const actor of [
        { kind: "agent", id: "agt_atlas01" },
        { kind: "human", id: "usr_owner01" },
      ] as const) {
        expect(() =>
          log.transaction((tx) =>
            tx.append(actor, {
              type: "train.held_expired",
              data: { checkRunId: "chk_run0001", candidate: sha("2"), reason: "timed_out" },
            }),
          ),
        ).toThrow(/must be recorded by the system/);
      }
      expect(events()).toEqual([]);
    });
  });

  it("drops a held pin whose newer generation was queued during the hold and deletes its candidate", async () => {
    const fakes = new Fakes();
    const pushed = pin(1, 2, sha("9"));
    // Only the first generation edits a protected path; the next one runs.
    fakes.start = (attempt) =>
      attempt.pins.some((p) => p.generation === 1)
        ? fail("check_held", "The candidate edits protected check paths.")
        : ok({ attemptId: attempt.attemptId });
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      const heldBatch = train.batches(1)[0];
      const [heldAttempt] = fakes.composeAttempts;
      if (heldBatch?.attemptId == null || heldAttempt === undefined) throw new Error("no hold");

      // The next generation is queued while the first is still the active, held batch.
      fakes.ready(pushed);
      expect(await train.enqueue(pushed)).toEqual(ok({ queued: true }));
      expect(states(train)).toMatchObject({
        "clm_claim001@1": "batched",
        "clm_claim001@2": "queued",
      });

      // At the deadline the held pin can never return, so it is dropped, not parked.
      advance(owed(sql).dueAt - now());
      await train.resume();
      expect(train.entries(8).find((entry) => entry.pin.generation === 1)).toMatchObject({
        state: "dropped",
        reason: "pin_changed",
      });
      expect(train.holds(heldBatch.attemptId)).toBe(false);
      expect(pendingDiscards(sql).map((d) => d.attempt)).toContain(heldAttempt);

      // Its candidate refs go once its compose can no longer push, well before a parked pin's day.
      advance(MERGE_PUSH_WINDOW_MS);
      await train.resume();
      expect(fakes.discards).toContain(heldAttempt);
      expect(fakes.candidateRefs.has(heldAttempt)).toBe(false);
      advance(HELD_PARK_TTL_MS);
      await train.resume();
      expect(fakes.discards.filter((attempt) => attempt === heldAttempt)).toHaveLength(1);
    }, fakes);
  });

  it("leaves a parked pin a newer generation superseded to that generation's discard", async () => {
    const fakes = new Fakes();
    const pushed = pin(1, 2, sha("9"));
    // Only the first generation edits a protected path; the next one runs and lands.
    fakes.start = (attempt) =>
      attempt.pins.some((p) => p.generation === 1)
        ? fail("check_held", "The candidate edits protected check paths.")
        : ok({ attemptId: attempt.attemptId });
    await withTrain(async (harness) => {
      const { train, sql, advance } = harness;
      const { mergeAttempt } = await parkHeld(harness, pin(1));
      fakes.ready(pushed);
      await train.enqueue(pushed);
      const run = lastStarted(fakes);
      expect(await train.recordCheck(report(run, "pass"))).toEqual(ok(run));
      expect(pendingDiscards(sql).map((d) => d.attempt)).toContain(mergeAttempt);
      advance(MERGE_PUSH_WINDOW_MS);
      await train.resume();
      expect(fakes.discards).toContain(mergeAttempt);

      // The superseded pin is no longer returnable: its expiry queues no second discard.
      advance(HELD_PARK_TTL_MS);
      await train.resume();
      expect(states(train)).toMatchObject({ "clm_claim001@1": "parked" });
      expect(pendingDiscards(sql).map((d) => d.attempt)).not.toContain(mergeAttempt);
    }, fakes);
  });
});

describe("train hung ports", () => {
  it("takes over from a drive hung on a check start once its lease ends, and fences the late answer", async () => {
    const fakes = new Fakes();
    const gates: (() => void)[] = [];
    // Only the first start hangs; the port answers every later one at once.
    fakes.startGate = () =>
      gates.length === 0 ? new Promise<void>((resolve) => gates.push(resolve)) : Promise.resolve();
    await withTrain(async ({ train, sql, wakes, advance }) => {
      fakes.ready(pin(1), pin(2));
      const accepted = train.enqueue(pin(1));
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      const attempt = lastStarted(fakes);
      // The deadline was recorded before the port was asked.
      const [requested] = train.batches(1);
      expect(requested).toMatchObject({ state: "checking", checkStarted: false });
      expect(requested?.checkDeadline).toBe(attempt.createdAt + 1 + CHECK_DEADLINE_MS);

      // The alarm within the lease returns at once and asks to come back when the lease ends.
      const leaseEnd = wakes.at(-1);
      await train.resume();
      expect(fakes.started).toHaveLength(1);
      expect(wakes.at(-1)).toBe(leaseEnd);

      // After the lease, the alarm drives again without waiting on the hung start: the same
      // attempt is started again and acknowledged, under the same deadline.
      advance(DRIVE_LEASE_MS);
      await train.resume();
      expect(fakes.started.map((a) => a.attemptId)).toEqual([attempt.attemptId, attempt.attemptId]);
      expect(train.batches(1)).toMatchObject([
        { state: "checking", checkStarted: true, checkDeadline: requested?.checkDeadline },
      ]);

      // Later work moves while the first start is still pending.
      expect(await train.recordCheck(report(attempt, "pass"))).toEqual(ok(attempt));
      expect(fakes.main).toBe(attempt.candidate);
      expect(await train.enqueue(pin(2))).toEqual(ok({ queued: true }));
      expect(pinsOf(lastStarted(fakes))).toEqual([pin(2)]);
      const batches = train.batches(64);
      const wake = readWake(sql);
      const calls = fakes.started.length;

      // The hung start answers late: its drive writes nothing and calls no other port.
      gates[0]?.();
      expect(await accepted).toEqual(ok({ queued: true }));
      expect(train.batches(64)).toEqual(batches);
      expect(readWake(sql)).toEqual(wake);
      expect(fakes.started).toHaveLength(calls);
    }, fakes);
  });

  const CASES: [PortCall, string, "form" | "batch" | "land"][] = [
    ["claims.pin", "pin_unavailable", "form"],
    ["mainWriter.head", "main_unavailable", "form"],
    ["checks.definitions", "definitions_unavailable", "form"],
    ["decisions.requirements", "requirements_unavailable", "form"],
    ["merge.compose", "merge_unavailable", "batch"],
    ["checks.start", "checks_unavailable", "batch"],
    ["authorization.authorize", "authorization_unavailable", "land"],
    ["mainWriter.publish", "publish_pending", "land"],
  ];

  it.each(CASES)(
    "stops a drive whose %s never answers, then retries it",
    async (call, reason, at) => {
      const fakes = new Fakes();
      fakes.portTimeoutMs = 20;
      await withTrain(async ({ train }) => {
        fakes.ready(pin(1));
        if (at !== "land") fakes.hang = call;
        expect(await train.enqueue(pin(1))).toEqual(ok({ queued: true }));
        if (at === "land") {
          fakes.hang = call;
          const passed = report(lastStarted(fakes), "pass");
          expect(await train.recordCheck(passed)).toMatchObject({ ok: true });
        }
        expect(await train.drive()).toEqual({
          kind: "blocked",
          batchId: at === "form" ? null : 1,
          reason,
          code: "unavailable",
        });

        fakes.hang = null;
        if (at === "land") {
          expect(await train.drive()).toEqual({ kind: "idle" });
        } else {
          expect(await train.drive()).toMatchObject({ kind: "checking", batchId: 1 });
          await train.recordCheck(report(lastStarted(fakes), "pass"));
        }
        const attempt = lastStarted(fakes);
        expect(new Set(fakes.started.map((a) => a.attemptId))).toEqual(
          new Set([attempt.attemptId]),
        );
        expect(fakes.main).toBe(attempt.candidate);
        // A timed-out authorization or publish is retried for the same attempt and intent.
        expect(new Set(fakes.authorized)).toEqual(new Set([attempt.attemptId]));
        expect(new Set(fakes.published).size).toBe(1);
        expect(train.batches(64).map((b) => b.state)).toEqual(["landed"]);
      }, fakes);
    },
  );

  it("expires an attempt whose start never answered at the deadline recorded before the request", async () => {
    const fakes = new Fakes();
    fakes.portTimeoutMs = 20;
    fakes.hang = "checks.start";
    await withTrain(async ({ train, now, advance, events }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      const silent = lastStarted(fakes);
      const [requested] = train.batches(1);
      expect(requested).toMatchObject({ state: "checking", checkStarted: false });
      const deadline = requested?.checkDeadline ?? 0;
      expect(deadline).toBe(silent.createdAt + 1 + CHECK_DEADLINE_MS);

      // A report from a runner that did start it is refused once the deadline has passed.
      advance(deadline - now() - 1);
      expect(await train.recordCheck(report(silent, "pass"))).toMatchObject({
        ok: false,
        code: "check_mismatch",
      });

      fakes.hang = null;
      await train.resume();
      expect(events()).toMatchObject([
        { type: "train.unreported", data: { checkRunId: silent.attemptId, outcome: "timed_out" } },
      ]);
      const fresh = lastStarted(fakes);
      expect(fresh.attemptId).not.toBe(silent.attemptId);
      expect(train.batches(2).map((b) => [b.state, b.failure, b.checkStarted])).toEqual([
        ["checking", null, true],
        ["failed", "check_timeout", false],
      ]);
      expect(fakes.authorized).toEqual([]);
      expect(fakes.main).toBe(MAIN);
    }, fakes);
  });

  it.each(["duplicate ready calls", "an earlier outage"] as const)(
    "keeps the deadline of a refused check start after %s exhaust the retries",
    async (cause) => {
      const fakes = new Fakes();
      fakes.start = () => fail("unavailable", "Runner offline.");
      await withTrain(async ({ train, sql, wakes, now, advance, restart }) => {
        fakes.ready(pin(1), pin(2));
        if (cause === "duplicate ready calls") {
          await train.enqueue(pin(1));
          for (let failures = 2; failures <= MAX_WAKE_FAILURES + 1; failures += 1) {
            expect(await train.enqueue(pin(1))).toEqual(ok({ queued: false }));
          }
          expect(fakes.started).toHaveLength(MAX_WAKE_FAILURES + 1);
        } else {
          fakes.compose = () => fail("unavailable", "Sandbox offline.");
          await train.enqueue(pin(1));
          while (owed(sql).failures < MAX_WAKE_FAILURES - 1) {
            advance(owed(sql).dueAt - now());
            await train.resume();
          }
          fakes.compose = (main, pins) => ok({ kind: "clean", candidate: candidateOf(main, pins) });
          for (let drives = 0; drives < 2; drives += 1) {
            advance(owed(sql).dueAt - now());
            await train.resume();
          }
          expect(fakes.started).toHaveLength(2);
        }
        const silent = lastStarted(fakes);
        const [requested] = train.batches(1);
        expect(requested).toMatchObject({ state: "checking", checkStarted: false });
        const deadline = requested?.checkDeadline ?? 0;
        expect(deadline).toBeGreaterThan(now());
        // Retries stopped, but the wake that expires the attempt survives exhaustion.
        expect(owed(sql)).toEqual({ dueAt: deadline, failures: MAX_WAKE_FAILURES });
        expect(wakes.at(-1)).toBe(deadline);

        // Later work queues behind the attempt, and its drive cannot remove the deadline either.
        expect(await train.enqueue(pin(2))).toEqual(ok({ queued: true }));
        expect(owed(sql)).toEqual({ dueAt: deadline, failures: MAX_WAKE_FAILURES });
        const starts = fakes.started.length;

        // A restarted Repo asks for the deadline again; an earlier alarm requests nothing.
        const again = restart();
        expect(wakes.at(-1)).toBe(deadline);
        advance(deadline - now() - 10);
        await again.resume();
        expect(fakes.started).toHaveLength(starts);
        expect(wakes.at(-1)).toBe(deadline);

        fakes.start = (attempt) => ok({ attemptId: attempt.attemptId });
        advance(deadline - now());
        await again.resume();
        const fresh = lastStarted(fakes);
        expect(fresh.attemptId).not.toBe(silent.attemptId);
        expect(fakes.started.slice(starts).map((a) => a.attemptId)).toEqual([fresh.attemptId]);
        expect(train.batches(2).map((b) => [b.state, b.failure])).toEqual([
          ["checking", null],
          ["failed", "check_timeout"],
        ]);

        // The expired attempt can neither authorize nor publish.
        expect(await again.recordCheck(report(silent, "pass"))).toMatchObject({
          ok: false,
          code: "check_mismatch",
        });
        for (let landed = 0; landed < 3 && train.batches(1)[0]?.state === "checking"; landed += 1) {
          await again.recordCheck(report(lastStarted(fakes), "pass"));
        }
        expect(states(train)).toEqual({ "clm_claim001@1": "landed", "clm_claim002@1": "landed" });
        expect(fakes.authorized).not.toContain(silent.attemptId);
        expect([...fakes.intents.values()].map((i) => i.checkAttemptId)).not.toContain(
          silent.attemptId,
        );
        expect(readWake(sql)).toBeNull();
      }, fakes);
    },
  );
});

describe("train ready episodes", () => {
  it("gives a waiting entry a newer episode's commit in place and queues a dropped one again", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train }) => {
      fakes.head = () => fail("unavailable", "Main is down.");
      fakes.ready(pin(1), pin(2));
      await train.enqueue(pin(1));
      await train.enqueue(pin(2));

      const newer = pin(1, 1, sha("f"));
      fakes.ready(newer);
      expect(await train.enqueue(newer)).toEqual(ok({ queued: true }));
      expect(train.entries(64).find((e) => e.pin.claimId === newer.claimId)?.pin).toEqual(newer);

      // Claim 2 is no longer ready, so the next drive drops its pin.
      fakes.pins.delete(pin(2).claimId);
      await train.drive();
      expect(states(train)).toEqual({ "clm_claim001@1": "queued", "clm_claim002@1": "dropped" });

      fakes.ready(pin(2));
      expect(await train.enqueue(pin(2))).toEqual(ok({ queued: true }));
      fakes.head = () => ok(fakes.main);
      await train.drive();

      expect(fakes.composeCalls).toEqual([{ main: MAIN, pins: [newer, pin(2)] }]);
    }, fakes);
  });

  it("holds a newer commit of a batched entry until the batch lands, then schedules it", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      const first = lastStarted(fakes);

      const newer = pin(1, 1, sha("f"));
      expect(await train.enqueue(newer)).toEqual(ok({ queued: false }));
      expect(train.entries(1)[0]).toMatchObject({
        pin: pin(1),
        state: "batched",
        nextCommit: newer.commit,
      });
      // Pinning the batched commit again forgets the held one.
      expect(await train.enqueue(pin(1))).toEqual(ok({ queued: false }));
      expect(train.entries(1)[0]).toMatchObject({ state: "batched", nextCommit: null });
      expect(await train.enqueue(newer)).toEqual(ok({ queued: false }));

      fakes.ready(newer);
      await train.recordCheck(report(first, "pass"));

      expect(train.batches(2).map((batch) => batch.state)).toEqual(["checking", "landed"]);
      expect(pinsOf(lastStarted(fakes))).toEqual([newer]);
      expect(train.entries(1)[0]).toMatchObject({ pin: newer, state: "batched", nextCommit: null });
      // A landed commit is not work again: a new episode must bring a new commit.
      await train.recordCheck(report(lastStarted(fakes), "pass"));
      expect(await train.enqueue(newer)).toMatchObject({ ok: false, code: "decision_superseded" });
      expect(train.entries(1)[0]).toMatchObject({ pin: newer, state: "landed" });
    }, fakes);
  });

  it("records each entry's ready episode and refuses an episode that is not a positive integer", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, events }) => {
      for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(await train.enqueue(pin(1), bad)).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
      }
      expect(train.entries(64)).toEqual([]);
      expect(events()).toEqual([]);

      fakes.head = () => fail("unavailable", "Main is down.");
      fakes.ready(pin(1));
      expect(await train.enqueue(pin(1), 2)).toEqual(ok({ queued: true }));
      // The same commit again is a no-op for the queue, but the entry takes the newer episode.
      expect(await train.enqueue(pin(1), 4)).toEqual(ok({ queued: false }));
      expect(train.entries(1)[0]).toMatchObject({ pin: pin(1), state: "queued", episode: 4 });

      fakes.head = () => ok(fakes.main);
      await train.drive();
      expect(train.entries(1)[0]).toMatchObject({ state: "batched", episode: 4 });
      // A batched entry takes a re-pinned commit's episode now and a held commit's once it settles.
      expect(await train.enqueue(pin(1), 6)).toEqual(ok({ queued: false }));
      expect(train.entries(1)[0]).toMatchObject({ state: "batched", episode: 6 });
      const newer = pin(1, 1, sha("f"));
      expect(await train.enqueue(newer, 8)).toEqual(ok({ queued: false }));
      expect(train.entries(1)[0]).toMatchObject({
        pin: pin(1),
        episode: 6,
        nextCommit: newer.commit,
      });

      fakes.ready(newer);
      await train.recordCheck(report(lastStarted(fakes), "fail"));
      expect(train.entries(1)[0]).toMatchObject({ pin: newer, state: "batched", episode: 8 });
    }, fakes);
  });

  it("retries a same-commit re-ready as fresh work after the earlier episode used its retries", async () => {
    const fakes = new Fakes();
    let timeouts = MAX_RETRIES;
    // Main becomes unreachable once episode 1 has used its last retry, so the drive stops with the
    // entry still queued instead of failing it once more.
    let thenMainDown = true;
    fakes.compose = (main, pins) => {
      if (timeouts === 0) return ok({ kind: "clean", candidate: candidateOf(main, pins) });
      timeouts -= 1;
      if (timeouts === 0 && thenMainDown) fakes.head = () => fail("unavailable", "Main is down.");
      return ok({ kind: "error", reason: "timeout" });
    };
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1));
      expect(await train.enqueue(pin(1), 1)).toEqual(ok({ queued: true }));
      expect(fakes.composeCalls).toHaveLength(MAX_RETRIES);
      expect(train.entries(1)[0]).toMatchObject({
        state: "queued",
        episode: 1,
        retries: MAX_RETRIES,
      });

      // Episode 2 readies the same commit and starts with no retries counted.
      expect(await train.enqueue(pin(1), 2)).toEqual(ok({ queued: false }));
      expect(train.entries(1)[0]).toMatchObject({
        state: "queued",
        episode: 2,
        retries: 0,
        isolate: false,
        reason: null,
      });

      // Its first merge times out: the entry is retried, not dropped, and the retry is checked.
      timeouts = 1;
      thenMainDown = false;
      fakes.head = () => ok(fakes.main);
      await train.drive();
      expect(fakes.composeCalls).toHaveLength(MAX_RETRIES + 2);
      expect(train.entries(1)[0]).toMatchObject({ state: "batched", episode: 2, retries: 1 });
      expect(pinsOf(lastStarted(fakes))).toEqual([pin(1)]);

      await train.recordCheck(report(lastStarted(fakes), "pass"));
      expect(train.entries(1)[0]).toMatchObject({ state: "landed", reason: null });
      expect(fakes.main).toBe(candidateOf(MAIN, [pin(1)]));
    }, fakes);
  });

  it("schedules the held commit when the batch fails and drops the old one", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      const first = lastStarted(fakes);
      const newer = pin(1, 1, sha("f"));
      await train.enqueue(newer);
      fakes.ready(newer);

      await train.recordCheck(report(first, "fail"));

      expect(train.batches(2).map((batch) => batch.failure)).toEqual([null, "check_fail"]);
      expect(pinsOf(lastStarted(fakes))).toEqual([newer]);
      expect(train.entries(1)[0]).toMatchObject({ pin: newer, state: "batched", retries: 0 });
    }, fakes);
  });

  it("checks a same-commit re-ready again when the old batch lands under a superseded version", async () => {
    const fakes = new Fakes();
    const first: DecisionRef = { decisionId: "dec_upload01", version: 1 };
    const second: DecisionRef = { decisionId: "dec_upload01", version: 2 };
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1));
      fakes.requirements.set(pin(1).claimId, [first]);
      await train.enqueue(pin(1));
      const old = lastStarted(fakes);
      expect(old.decisions).toEqual([first]);

      // The claim is readied again with the same commit under a newer version.
      fakes.requirements.set(pin(1).claimId, [second]);
      expect(await train.enqueue(pin(1))).toEqual(ok({ queued: false }));
      await train.recordCheck(report(old, "pass"));

      // The old attempt landed, but the new episode's version was never checked.
      expect(train.batches(2).map((batch) => batch.state)).toEqual(["checking", "landed"]);
      expect(fakes.started).toHaveLength(2);
      expect(lastStarted(fakes)).toMatchObject({ pins: [pin(1)], decisions: [second] });
      expect(train.entries(1)[0]).toMatchObject({ pin: pin(1), state: "batched", retries: 0 });
    }, fakes);
  });

  it("lands a same-commit re-ready with the old batch while its version is unchanged", async () => {
    const fakes = new Fakes();
    const first: DecisionRef = { decisionId: "dec_upload01", version: 1 };
    await withTrain(async ({ train, sql }) => {
      fakes.ready(pin(1));
      fakes.requirements.set(pin(1).claimId, [first]);
      await train.enqueue(pin(1));
      expect(await train.enqueue(pin(1))).toEqual(ok({ queued: false }));
      await train.recordCheck(report(lastStarted(fakes), "pass"));

      expect(train.batches(2).map((batch) => batch.state)).toEqual(["landed"]);
      expect(fakes.started).toHaveLength(1);
      expect(train.entries(1)[0]).toMatchObject({ pin: pin(1), state: "landed" });
      expect(readWake(sql)).toBeNull();
    }, fakes);
  });

  it("composes a pair again, unparked and unasked, when one was readied again during its merge", async () => {
    const fakes = new Fakes();
    fakes.head = () => fail("unavailable", "Not yet.");
    // Only the merge of the older episode conflicts; the newer one composes cleanly.
    fakes.compose = (main, pins) =>
      fakes.composeCalls.length === 1
        ? ok({ kind: "conflict", pins: [pin(1), pin(2)], paths: ["src/upload.ts"], regions: [] })
        : ok({ kind: "clean", candidate: candidateOf(main, pins) });
    await withTrain(async ({ train, events }) => {
      fakes.ready(pin(1), pin(2));
      for (const p of [pin(1), pin(2)]) await train.enqueue(p);
      fakes.head = () => ok(fakes.main);
      const release = fakes.hold("merge.compose");
      const driving = train.drive();
      await vi.waitFor(() => expect(fakes.composeCalls).toHaveLength(1));

      // Claim 1 is readied again with its batched commit while the merge runs.
      const queued = train.enqueue(pin(1));
      release();
      expect(await queued).toEqual(ok({ queued: false }));
      await driving;

      // Nothing is parked, asked or recorded about the older episode's conflict.
      expect(fakes.asked).toEqual([]);
      expect(train.conflicts(8)).toEqual([]);
      expect(events().map((event) => event.type)).not.toContain("train.conflict");
      expect(train.batches(2)).toMatchObject([
        { state: "checking" },
        { state: "failed", failure: "conflict" },
      ]);
      expect(states(train)).toEqual({ "clm_claim001@1": "batched", "clm_claim002@1": "batched" });
      expect(pinsOf(lastStarted(fakes))).toEqual([pin(1), pin(2)]);
    }, fakes);
  });

  it("composes a pair again, unparked and unasked, when one was readied with a new commit during its merge", async () => {
    const fakes = new Fakes();
    fakes.head = () => fail("unavailable", "Not yet.");
    const redone = pin(1, 1, sha("9"));
    // Only the merge with claim 1's older commit conflicts.
    fakes.compose = (main, pins) =>
      pins.some((p) => p.claimId === pin(1).claimId && p.commit === pin(1).commit) &&
      pins.length === 2
        ? ok({ kind: "conflict", pins: [pin(1), pin(2)], paths: ["src/upload.ts"], regions: [] })
        : ok({ kind: "clean", candidate: candidateOf(main, pins) });
    await withTrain(async ({ train, events }) => {
      fakes.ready(pin(1), pin(2));
      for (const p of [pin(1), pin(2)]) await train.enqueue(p);
      fakes.head = () => ok(fakes.main);
      const release = fakes.hold("merge.compose");
      const driving = train.drive();
      await vi.waitFor(() => expect(fakes.composeCalls).toHaveLength(1));

      // Claim 1 is readied with a newer commit while the merge runs.
      fakes.ready(redone);
      const queued = train.enqueue(redone);
      release();
      expect(await queued).toEqual(ok({ queued: false }));
      await driving;

      expect(fakes.asked).toEqual([]);
      expect(train.conflicts(8)).toEqual([]);
      expect(events().map((event) => event.type)).not.toContain("train.conflict");
      expect(states(train)).toEqual({ "clm_claim001@1": "batched", "clm_claim002@1": "batched" });
      expect(pinsOf(lastStarted(fakes))).toEqual(expect.arrayContaining([redone, pin(2)]));
    }, fakes);
  });

  it("parks and asks about a pair whose re-readied entry conflicts again", async () => {
    const fakes = new Fakes();
    fakes.head = () => fail("unavailable", "Not yet.");
    fakes.compose = (main, pins) =>
      pins.length === 2
        ? ok({ kind: "conflict", pins: [pin(1), pin(2)], paths: ["src/upload.ts"], regions: [] })
        : ok({ kind: "clean", candidate: candidateOf(main, pins) });
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1), pin(2));
      for (const p of [pin(1), pin(2)]) await train.enqueue(p);
      fakes.head = () => ok(fakes.main);
      const release = fakes.hold("merge.compose");
      const driving = train.drive();
      await vi.waitFor(() => expect(fakes.composeCalls).toHaveLength(1));
      const queued = train.enqueue(pin(1));
      release();
      await queued;
      await driving;

      // The newer episode's own merge conflicts, so only that one is asked about.
      expect(train.batches(2)).toMatchObject([
        { state: "failed", failure: "conflict" },
        { state: "failed", failure: "conflict" },
      ]);
      const [newer, older] = train.batches(2);
      expect(train.conflicts(8)).toMatchObject([{ batchId: newer?.batchId, state: "asked" }]);
      expect(fakes.asked.map((question) => question.key)).toEqual([`conflict_${newer?.batchId}`]);
      expect(older?.batchId).not.toBe(newer?.batchId);
      expect(states(train)).toEqual({ "clm_claim001@1": "parked", "clm_claim002@1": "parked" });
    }, fakes);
  });
});

describe("train batch fence", () => {
  it("forms no batch when a pin's decision versions move while main is read, and schedules its re-ready", async () => {
    const fakes = new Fakes();
    const v1: DecisionRef = { decisionId: "dec_upload001", version: 1 };
    const v2: DecisionRef = { decisionId: "dec_upload001", version: 2 };
    fakes.requirements.set(pin(1).claimId, [v1]);
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1));
      const release = fakes.hold("mainWriter.head");
      const enqueued = train.enqueue(pin(1));
      await vi.waitFor(() => expect(fakes.reached).toContain("mainWriter.head"));
      // Version 2 supersedes the pin; the claims module reopens the claim, so it has no pin.
      fakes.requirements.set(pin(1).claimId, [v2]);
      fakes.pins.delete(pin(1).claimId);
      release();
      await enqueued;

      expect(train.batches(8)).toEqual([]);
      expect(fakes.composeCalls).toEqual([]);
      expect(train.entries(1)[0]).toMatchObject({ state: "dropped", reason: "pin_changed" });

      // The holder marks adapted work ready under version 2, and that pin is scheduled.
      const adapted = pin(1, 1, sha("f"));
      fakes.ready(adapted);
      expect(await train.enqueue(adapted)).toEqual(ok({ queued: true }));
      expect(lastStarted(fakes)).toMatchObject({ pins: [adapted], decisions: [v2] });
    }, fakes);
  });

  it("forms no batch when a claim changes owner while main is read, and drops the old pin", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1));
      const release = fakes.hold("mainWriter.head");
      const enqueued = train.enqueue(pin(1));
      await vi.waitFor(() => expect(fakes.reached).toContain("mainWriter.head"));
      fakes.ready(pin(1, 2));
      release();
      await enqueued;

      expect(train.batches(8)).toEqual([]);
      expect(fakes.composeCalls).toEqual([]);
      expect(train.entries(1)[0]).toMatchObject({ state: "dropped", reason: "pin_changed" });
    }, fakes);
  });

  it("stops blocked after one read while the decision versions are unknown, and forms the batch once they are known", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(pin(1));
      const release = fakes.hold("mainWriter.head");
      const enqueued = train.enqueue(pin(1));
      await vi.waitFor(() => expect(fakes.reached).toContain("mainWriter.head"));
      // The fence reader reports the claim unknown while the async reads still answer.
      fakes.unknownVersions = true;
      const reads = fakes.versionReads;
      release();
      await enqueued;

      // One pass read the versions once and stopped; it did not read the queue again.
      expect(fakes.versionReads - reads).toBe(1);
      const count = (call: PortCall) => fakes.reached.filter((c) => c === call).length;
      expect(count("decisions.requirements")).toBe(1);
      expect(count("claims.pin")).toBe(1);
      expect(count("mainWriter.head")).toBe(1);
      expect(train.batches(8)).toEqual([]);
      expect(train.entries(1)[0]).toMatchObject({ state: "queued" });
      expect(sql.exec("SELECT COUNT(*) AS n FROM train_batches").one().n).toBe(0);
      expect(owed(sql)).toEqual({ dueAt: now() + WAKE_BASE_MS, failures: 1 });
      expect(await train.drive()).toEqual({
        kind: "blocked",
        batchId: null,
        reason: "requirements_unavailable",
        code: "unavailable",
      });

      // Once the reader answers again, the alarm's next drive forms the batch and starts its check.
      fakes.unknownVersions = false;
      advance(owed(sql).dueAt - now());
      await train.resume();
      expect(lastStarted(fakes)).toMatchObject({ pins: [pin(1)], decisions: [] });
      expect(train.entries(1)[0]).toMatchObject({ state: "batched" });
    }, fakes);
  });
});

describe("train settle wake", () => {
  it("drives exhausted work with no unsettled intent only on a call, even after a restart", async () => {
    const fakes = new Fakes();
    fakes.authorize = () => fail("unavailable", "Authorization offline.");
    await withTrain(async ({ train, sql, wakes, restart, now, advance }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      await train.recordCheck(report(lastStarted(fakes), "pass"));
      while (owed(sql).failures <= MAX_WAKE_FAILURES) {
        advance(owed(sql).dueAt - now());
        await train.resume();
      }
      expect(owed(sql)).toEqual({ dueAt: now(), failures: EXHAUSTED_FAILURES });
      const authorizations = fakes.authorized.length;

      // No intent was authorized, so the restarted train asks for no alarm, and an alarm another
      // module asked for drives nothing and asks for nothing more.
      const asked = wakes.length;
      const again = restart();
      await Promise.resolve();
      expect(wakes).toHaveLength(asked);
      advance(SETTLE_WAKE_MS);
      await again.resume();
      expect(fakes.authorized).toHaveLength(authorizations);
      expect(wakes).toHaveLength(asked);
      expect(owed(sql).failures).toBe(EXHAUSTED_FAILURES);
    }, fakes);
  });
});

describe("train attempt outcome", () => {
  it("reads the persisted attempt, then its recorded report, and nothing for an unknown id", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      const attempt = lastStarted(fakes);
      expect(train.attemptOutcome(attempt.attemptId)).toEqual({ attempt, report: null });

      const errored = report(attempt, "error");
      await train.recordCheck(errored);
      // The failed batch keeps its attempt and report after the pin moved to a new attempt.
      expect(train.attemptOutcome(attempt.attemptId)).toEqual({ attempt, report: errored });
      expect(lastStarted(fakes).attemptId).not.toBe(attempt.attemptId);

      expect(train.attemptOutcome("chk_unknown01")).toBeNull();
      expect(train.attemptOutcome("")).toBeNull();
    }, fakes);
  });
});

describe("train module", () => {
  it("queues pins but starts no batch and accepts no report until its ports exist", async () => {
    const stub = env.REPO.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const log = EventLog.open(state.storage, REPO_ID);
      const context: RepoContext = {
        repoId: REPO_ID,
        storage: state.storage,
        log,
        clock: () => 0,
        env,
        wake: async () => true,
      };
      // The real claims module would drop a pin for a claim it never opened, so its port is the
      // missing one here: the pin must wait for it rather than be dropped.
      const ports: RepoPorts = { ...composeRepo(context), claims: unavailableClaims };
      const train = queueing(
        createTrain(context, () => ports),
        log,
      );

      expect(await train.enqueue(pin(1))).toEqual(ok({ queued: true }));
      expect(state.storage.sql.exec("SELECT state, reason FROM train_queue").toArray()).toEqual([
        { state: "queued", reason: null },
      ]);
      expect(owed(state.storage.sql).failures).toBeGreaterThanOrEqual(1);
      expect(
        await train.recordCheck({
          attemptId: "chk_attempt01",
          candidate: sha("2"),
          result: "pass",
          logDigest: null,
          finishedAt: 0,
        }),
      ).toMatchObject({ ok: false, code: "check_mismatch" });
      expect(log.head()).toBe(0);
      expect(
        state.storage.sql.exec("SELECT COUNT(*) AS n FROM train_batches").toArray()[0],
      ).toEqual({ n: 0 });
    });
  });

  it("sets the Repo's alarm for owed work after eviction, and the alarm drives the train", async () => {
    const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const stub = env.REPO.getByName(repoObjectName("acme", name));
    const summary = await stub.initialize("acme", name);
    if (!summary.ok) throw new Error(summary.code);

    // What an enqueue leaves when the object stops after its commit: work owed, no alarm.
    await runInDurableObject(stub, async (_instance, state) => {
      migrateTrain(state.storage);
      const now = Date.now();
      insertEntry(state.storage.sql, pin(1), 1, now);
      writeWake(state.storage.sql, { dueAt: now, failures: 0 });
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);

    // The rebuilt train asks for its wake; the alarm drives it. The real claims module has no
    // such claim, so the drive drops the pin and the train goes idle. Nobody called the train.
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(stub);
        const entry = await runInDurableObject(stub, (_instance, state) =>
          state.storage.sql.exec("SELECT state, reason FROM train_queue").toArray(),
        );
        expect(entry).toEqual([{ state: "dropped", reason: "pin_changed" }]);
      },
      { timeout: 5_000, interval: 20 },
    );
    const wake = await runInDurableObject(stub, (_instance, state) => readWake(state.storage.sql));
    expect(wake).toBeNull();
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  });
  it("sets no Repo alarm after eviction for an exhausted wake that owes no settlement", async () => {
    const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const stub = env.REPO.getByName(repoObjectName("acme", name));
    const summary = await stub.initialize("acme", name);
    if (!summary.ok) throw new Error(summary.code);

    // What retries that ran out before any intent was authorized leave: work stored under an
    // exhausted wake whose time has passed, and no alarm.
    await runInDurableObject(stub, async (_instance, state) => {
      migrateTrain(state.storage);
      const now = Date.now();
      insertEntry(state.storage.sql, pin(1), 1, now - 60_000);
      writeWake(state.storage.sql, { dueAt: now - 1_000, failures: EXHAUSTED_FAILURES });
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);

    // The cold-started Repo builds its train and asks for no alarm. A past alarm would fire at once
    // and be set again by every cold start; none is set after either start, and the stored work
    // waits for a call.
    expect(await stub.describe()).toEqual(summary.value);
    await scheduler.wait(50);
    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    const stored = await runInDurableObject(stub, (_instance, state) => ({
      wake: readWake(state.storage.sql),
      entries: state.storage.sql.exec("SELECT state FROM train_queue").toArray(),
    }));
    expect(stored).toEqual({
      wake: { dueAt: expect.any(Number), failures: EXHAUSTED_FAILURES },
      entries: [{ state: "queued" }],
    });
  });

  it("persists the lease alarm with an accepted pin, so the alarm drives it after the object stops mid-drive", async () => {
    const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const stub = env.REPO.getByName(repoObjectName("acme", name));
    const summary = await stub.initialize("acme", name);
    if (!summary.ok) throw new Error(summary.code);

    // A train over the Repo's storage accepts a pin, then its drive hangs on the claims port. Its
    // clock runs a lease behind, so the lease alarm is due within a second of real time.
    const due = await runInDurableObject(stub, async (_instance, state) => {
      const alarm = new EarliestAlarm(state.storage, () => {});
      await alarm.load();
      const clock = leaseBehind;
      const context: RepoContext = {
        repoId: summary.value.repoId,
        storage: state.storage,
        log: EventLog.open(state.storage, summary.value.repoId),
        clock,
        env,
        wake: (at) => alarm.request(at),
      };
      const real = composeRepo(context);
      let reached: (() => void) | null = null;
      const hanging = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const ports: RepoPorts = {
        ...real,
        claims: {
          ...real.claims,
          pin: () => {
            reached?.();
            return new Promise(() => {});
          },
        },
      };
      const accepted = clock();
      void queueing(
        createTrain(context, () => ports),
        context.log,
      ).enqueue(pin(1));
      await hanging;
      return accepted + 1 + DRIVE_LEASE_MS;
    });
    // The object stops while the drive waits on the port. Eviction would wait for the drive's port
    // timeout, so the object is aborted instead, as a crash or a deploy stops it.
    await abortAllDurableObjects();
    const restarted = env.REPO.getByName(repoObjectName("acme", name));

    // Nothing touches the object until the alarm is well past due.
    await new Promise((resolve) => setTimeout(resolve, Math.max(due - Date.now(), 0) + 1_500));
    const after = await runInDurableObject(restarted, (_instance, state) => ({
      wake: readWake(state.storage.sql),
      entry: state.storage.sql.exec("SELECT state, reason FROM train_queue").toArray(),
    }));
    // The alarm drove the pin before this read: the restarted object's real claims module has no
    // such claim, so the drive dropped the pin and owes no further work.
    expect(after.entry).toEqual([{ state: "dropped", reason: "pin_changed" }]);
    expect(after.wake).toBeNull();
    await runInDurableObject(restarted, (_instance, state) => state.storage.deleteAlarm());
  });
});

/** The discards the train still owes, earliest first. */
function pendingDiscards(sql: SqlStorage): { attempt: string; dueAt: number; failures: number }[] {
  return sql
    .exec<{ attempt: string; due_at: number; failures: number }>(
      "SELECT attempt, due_at, failures FROM train_discards ORDER BY due_at, attempt",
    )
    .toArray()
    .map((row) => ({ attempt: row.attempt, dueAt: row.due_at, failures: row.failures }));
}

describe("candidate discards", () => {
  it("deletes a landed batch's candidate refs once its compose can no longer push", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, sql, discardWakes, now, advance }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      const before = now();
      await train.recordCheck(report(lastStarted(fakes), "pass"));
      expect(states(train)).toEqual({ "clm_claim001@1": "landed" });

      const [attempt] = fakes.composeAttempts;
      expect(attempt).toMatch(/^mrg_[0-9a-f]{32}$/);
      expect(train.batches(1)).toMatchObject([{ state: "landed", mergeAttempt: attempt }]);
      const [pending] = pendingDiscards(sql);
      expect(pending).toMatchObject({ attempt, failures: 0 });
      expect(pending?.dueAt).toBeGreaterThan(before + MERGE_PUSH_WINDOW_MS);
      expect(pending?.dueAt).toBeLessThanOrEqual(now() + MERGE_PUSH_WINDOW_MS);
      expect(discardWakes.at(-1)).toBe(pending?.dueAt);

      // An alarm before the window ends deletes nothing: the compose might still push.
      await train.resume();
      expect(fakes.discards).toEqual([]);
      expect(fakes.candidateRefs.has(attempt ?? "")).toBe(true);

      advance((pending?.dueAt ?? 0) - now());
      await train.resume();
      expect(fakes.discards).toEqual([attempt]);
      expect(fakes.candidateRefs.size).toBe(0);
      expect(pendingDiscards(sql)).toEqual([]);

      // Nothing is owed any more, so a later alarm asks for nothing and discards nothing.
      const asked = discardWakes.length;
      advance(DISCARD_MAX_MS);
      await train.resume();
      expect(fakes.discards).toEqual([attempt]);
      expect(discardWakes).toHaveLength(asked);
    }, fakes);
  });

  it("deletes a failed batch's candidate refs", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, sql, advance }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      // The check fails, so the pin goes back alone and is dropped; nothing lands.
      await train.recordCheck(report(lastStarted(fakes), "fail"));
      expect(train.batches(1)).toMatchObject([{ state: "failed", failure: "check_fail" }]);
      const [failed] = fakes.composeAttempts;
      expect(pendingDiscards(sql).map((d) => d.attempt)).toEqual([failed]);

      advance(MERGE_PUSH_WINDOW_MS);
      await train.resume();
      expect(fakes.discards).toEqual([failed]);
      expect(fakes.candidateRefs.size).toBe(0);
      expect(pendingDiscards(sql)).toEqual([]);
    }, fakes);
  });

  it("keeps a parked held pin's candidate past the push window, so an approval revives and lands it", async () => {
    const fakes = new Fakes();
    const held = pin(1);
    const port = holding(fakes, held);
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(held);
      await train.enqueue(held);
      const heldBatch = train.batches(1)[0];
      advance(owed(sql).dueAt - now());
      await train.resume();
      expect(states(train)).toEqual({ "clm_claim001@1": "parked" });
      const [attempt] = fakes.composeAttempts;
      if (heldBatch?.attemptId == null || attempt === undefined) throw new Error("no hold");
      expect(pendingDiscards(sql)).toEqual([]);

      // Long after its compose could push, an alarm still deletes nothing.
      advance(2 * MERGE_PUSH_WINDOW_MS);
      await train.resume();
      expect(fakes.discards).toEqual([]);
      expect(fakes.candidateRefs.has(attempt)).toBe(true);

      port.approve();
      expect(train.releaseHeld(heldBatch.attemptId)).toBe(true);
      await train.resume();
      const run = lastStarted(fakes);
      expect(run.attemptId).toBe(heldBatch.attemptId);
      expect(fakes.candidateRefs.has(attempt)).toBe(true);
      expect(await train.recordCheck(report(run, "pass"))).toEqual(ok(run));
      expect(fakes.main).toBe(heldBatch.candidate);
      expect(fakes.composeAttempts).toEqual([attempt]);

      // Landed, the revived batch's candidate goes like any other.
      expect(pendingDiscards(sql).map((d) => d.attempt)).toEqual([attempt]);
      advance(MERGE_PUSH_WINDOW_MS);
      await train.resume();
      expect(fakes.discards).toEqual([attempt]);
      expect(fakes.candidateRefs.size).toBe(0);
    }, fakes);
  });

  it("deletes a parked held pin's candidate once a newer generation supersedes it", async () => {
    const fakes = new Fakes();
    const held = pin(1);
    const pushed = pin(1, 2, sha("9"));
    holding(fakes, held);
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(held);
      await train.enqueue(held);
      advance(owed(sql).dueAt - now());
      await train.resume();
      const [parked] = fakes.composeAttempts;
      expect(states(train)).toEqual({ "clm_claim001@1": "parked" });
      expect(pendingDiscards(sql)).toEqual([]);

      // The new push is held too, but alone in the active batch: only the parked candidate goes.
      fakes.ready(pushed);
      expect(await train.enqueue(pushed)).toEqual(ok({ queued: true }));
      expect(pendingDiscards(sql).map((d) => d.attempt)).toEqual([parked]);
      advance(MERGE_PUSH_WINDOW_MS);
      await train.resume();
      expect(fakes.discards).toEqual([parked]);
      expect(fakes.candidateRefs.has(parked ?? "")).toBe(false);
      expect(fakes.candidateRefs.size).toBe(1);

      // A third push supersedes a generation that is not parked: nothing is queued again.
      fakes.ready(pin(1, 3, sha("8")));
      await train.enqueue(pin(1, 3, sha("8")));
      expect(pendingDiscards(sql).map((d) => d.attempt)).not.toContain(parked);
    }, fakes);
  });

  it("deletes a parked held pin's candidate once its claim is readied again in its generation", async () => {
    const fakes = new Fakes();
    const held = pin(1);
    const again = pin(1, 1, sha("9"));
    const port = holding(fakes, held);
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(held);
      await train.enqueue(held);
      const heldBatch = train.batches(1)[0];
      advance(owed(sql).dueAt - now());
      await train.resume();
      const [parked] = fakes.composeAttempts;
      if (heldBatch?.attemptId == null) throw new Error("no hold");
      expect(train.holds(heldBatch.attemptId)).toBe(true);

      // A new episode takes the entry as fresh work, so the parked attempt can no longer return.
      fakes.ready(again);
      expect(await train.enqueue(again)).toEqual(ok({ queued: true }));
      expect(train.holds(heldBatch.attemptId)).toBe(false);
      expect(pendingDiscards(sql).map((d) => d.attempt)).toEqual([parked]);

      // Parked again for the new episode's own hold, the earlier attempt stays stale.
      advance(owed(sql).dueAt - now());
      await train.resume();
      expect(states(train)).toEqual({ "clm_claim001@1": "parked" });
      expect(train.holds(heldBatch.attemptId)).toBe(false);
      port.approve();
      expect(train.releaseHeld(heldBatch.attemptId)).toBe(false);
      expect(fakes.composeAttempts).toHaveLength(2);
    }, fakes);
  });

  it("keeps no held candidate for a pin readied again while its batch was held", async () => {
    const fakes = new Fakes();
    const held = pin(1);
    const again = pin(1, 1, sha("9"));
    holding(fakes, held);
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(held);
      await train.enqueue(held);
      const heldBatch = train.batches(1)[0];
      if (heldBatch?.attemptId == null) throw new Error("no hold");
      fakes.ready(again);
      expect(await train.enqueue(again)).toEqual(ok({ queued: false }));

      // Past the deadline the newer commit goes on as fresh work and the held candidate goes.
      advance(owed(sql).dueAt - now());
      await train.resume();
      const [first, second] = fakes.composeAttempts;
      expect(train.holds(heldBatch.attemptId)).toBe(false);
      expect(pendingDiscards(sql).map((d) => d.attempt)).toEqual([first]);
      expect(pinsOf(train.batches(1)[0])).toEqual([again]);
      expect(second).toBeDefined();
    }, fakes);
  });

  it("deletes the candidate of an approved held pin dropped on its way back", async () => {
    const fakes = new Fakes();
    const held = pin(1);
    const port = holding(fakes, held);
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(held);
      await train.enqueue(held);
      const heldBatch = train.batches(1)[0];
      advance(owed(sql).dueAt - now());
      await train.resume();
      const [attempt] = fakes.composeAttempts;
      if (heldBatch?.attemptId == null) throw new Error("no hold");

      port.approve();
      expect(train.releaseHeld(heldBatch.attemptId)).toBe(true);
      // The claim moved on after the approval, before any new generation was queued.
      fakes.ready(pin(1, 2, sha("9")));
      expect(pendingDiscards(sql)).toEqual([]);
      await train.resume();
      expect(states(train)).toEqual({ "clm_claim001@1": "dropped" });
      expect(pendingDiscards(sql).map((d) => d.attempt)).toEqual([attempt]);

      advance(MERGE_PUSH_WINDOW_MS);
      await train.resume();
      expect(fakes.discards).toEqual([attempt]);
      expect(fakes.candidateRefs.size).toBe(0);
    }, fakes);
  });

  it("deletes an attempt a new compose of the same batch superseded, before the batch settles", async () => {
    const fakes = new Fakes();
    // The first compose publishes its ref and then fails to answer as the train needs.
    fakes.compose = () => fail("unavailable", "Sandbox offline.");
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      expect(train.batches(1)).toMatchObject([{ state: "composing" }]);
      const [first] = fakes.composeAttempts;

      fakes.compose = (main, pins) => ok({ kind: "clean", candidate: candidateOf(main, pins) });
      advance(owed(sql).dueAt - now());
      await train.resume();
      const [, second] = fakes.composeAttempts;
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      // The batch now records the second attempt; the first waits for its discard.
      expect(train.batches(1)).toMatchObject([{ state: "checking", mergeAttempt: second }]);
      expect(pendingDiscards(sql).map((d) => d.attempt)).toEqual([first]);

      advance(MERGE_PUSH_WINDOW_MS);
      await train.resume();
      expect(fakes.discards).toEqual([first]);
      expect([...fakes.candidateRefs]).toEqual([second]);
      expect(train.batches(1)).toMatchObject([{ state: "checking" }]);

      await train.recordCheck(report(lastStarted(fakes), "pass"));
      advance(MERGE_PUSH_WINDOW_MS);
      await train.resume();
      expect(fakes.discards).toEqual([first, second]);
      expect(fakes.candidateRefs.size).toBe(0);
    }, fakes);
  });

  it("tries a failed discard again with a doubling delay, capped, until it succeeds", async () => {
    const fakes = new Fakes();
    const failing = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withTrain(async ({ train, sql, discardWakes, now, advance }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      await train.recordCheck(report(lastStarted(fakes), "pass"));
      const [attempt] = fakes.composeAttempts;

      fakes.discard = () => fail("unavailable", "Sandbox offline.");
      const delays: number[] = [];
      for (let failures = 1; delays.at(-1) !== DISCARD_MAX_MS; failures += 1) {
        advance((pendingDiscards(sql)[0]?.dueAt ?? 0) - now());
        // One failure is a throw, which counts like a refusal.
        if (failures === 2) {
          fakes.discard = () => {
            throw new Error("merge module crashed");
          };
        } else {
          fakes.discard = () => fail("unavailable", "Sandbox offline.");
        }
        await train.resume();
        const [pending] = pendingDiscards(sql);
        expect(pending).toMatchObject({ attempt, failures });
        const delay = (pending?.dueAt ?? 0) - now();
        expect(delay).toBe(Math.min(DISCARD_BASE_MS * 2 ** (failures - 1), DISCARD_MAX_MS));
        expect(discardWakes.at(-1)).toBe(pending?.dueAt);
        delays.push(delay);
      }
      expect(delays.length).toBeGreaterThan(2);
      expect(fakes.candidateRefs.has(attempt ?? "")).toBe(true);
      // Each failure is logged with its code, never with the port's message.
      const logged = failing.mock.calls.map(([line]) => String(line));
      expect(logged.some((line) => line.includes('"event":"train.discard_failed"'))).toBe(true);
      expect(logged.some((line) => line.includes("Sandbox offline"))).toBe(false);

      fakes.discard = (gone) => ok({ removed: fakes.candidateRefs.delete(gone) ? 1 : 0 });
      advance(DISCARD_MAX_MS);
      await train.resume();
      expect(fakes.candidateRefs.size).toBe(0);
      expect(pendingDiscards(sql)).toEqual([]);
    }, fakes);
    failing.mockRestore();
  });

  it("tries at most a few discards per wake and asks again for the rest", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, sql, discardWakes, now }) => {
      // More attempts due than one wake takes, as after a long outage.
      const attempts = Array.from(
        { length: MAX_DISCARDS_PER_WAKE + 2 },
        (_, n) => `mrg_backlog${String(n).padStart(3, "0")}`,
      );
      for (const attempt of attempts) {
        sql.exec(
          "INSERT INTO train_discards (attempt, due_at, failures) VALUES (?, ?, 0)",
          attempt,
          now(),
        );
      }
      await train.resume();
      expect(fakes.discards).toEqual(attempts.slice(0, MAX_DISCARDS_PER_WAKE));
      // The rest are already due, so the alarm is asked for at once.
      expect(discardWakes.at(-1)).toBeLessThanOrEqual(now());

      await train.resume();
      expect(fakes.discards).toEqual(attempts);
      expect(pendingDiscards(sql)).toEqual([]);
    }, fakes);
  });

  it("asks again for a pending discard after a restart", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, sql, restart, discardWakes, now, advance }) => {
      fakes.ready(pin(1));
      await train.enqueue(pin(1));
      await train.recordCheck(report(lastStarted(fakes), "pass"));
      const [pending] = pendingDiscards(sql);
      const asked = discardWakes.length;

      const again = restart();
      expect(discardWakes.slice(asked)).toEqual([pending?.dueAt]);
      advance((pending?.dueAt ?? 0) - now());
      await again.resume();
      expect(fakes.discards).toEqual([pending?.attempt]);
    }, fakes);
  });
});
