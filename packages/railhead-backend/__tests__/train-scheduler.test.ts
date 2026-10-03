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
import { fail, ok, type PortResult } from "../src/contracts/result";
import type {
  CheckAttempt,
  CheckDefinition,
  CheckReport,
  MergeIntentRecord,
  MergeOutcome,
} from "../src/contracts/train";
import {
  CHECK_DEADLINE_MS,
  createTrain,
  DRIVE_LEASE_MS,
  EXHAUSTED_FAILURES,
  MAX_QUEUE,
  MAX_RETRIES,
  MAX_WAKE_FAILURES,
  PORT_TIMEOUT_MS,
  WAKE_BASE_MS,
  WAKE_MAX_MS,
  type Train,
} from "../src/modules/train/scheduler";
import {
  insertEntry,
  migrateTrain,
  readWake,
  writeWake,
  type PendingWake,
} from "../src/modules/train/store";
import { unavailableClaims } from "../src/contracts/unavailable";
import { composeRepo, type RepoContext, type RepoPorts } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName } from "../src/repo/RepoObject";
import { EarliestAlarm } from "../src/repo/storage";

const REPO_ID = "rep_train0001";
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
  | "mainWriter.publish";

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
  composeCalls: { main: CommitSha; pins: ClaimPin[] }[] = [];
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
  readonly intents = new Map<string, MergeIntentRecord>();

  ready(...pins: ClaimPin[]): void {
    for (const p of pins) this.pins.set(p.claimId, p);
  }

  /** Never settles while `call` is the hung one. */
  async answer(call: PortCall): Promise<void> {
    if (this.hang === call) await new Promise<never>(() => {});
    await this.holds.get(call);
  }

  /** Makes every `call` wait until the returned function releases them. */
  hold(call: PortCall): () => void {
    const { promise, resolve } = released();
    this.holds.set(call, promise);
    return () => {
      this.holds.delete(call);
      resolve();
    };
  }

  ports(real: RepoPorts): RepoPorts {
    return {
      ...real,
      claims: {
        ...real.claims,
        pin: async (claimId) => {
          await this.answer("claims.pin");
          const current = this.pins.get(claimId);
          return current === undefined ? fail("not_found", "No such claim.") : ok(current);
        },
      },
      decisions: {
        ...real.decisions,
        requirements: async (claimId) => {
          await this.answer("decisions.requirements");
          return ok(this.requirements.get(claimId) ?? []);
        },
      },
      merge: {
        compose: async (main, pins) => {
          this.composeCalls.push({ main, pins });
          await this.answer("merge.compose");
          return this.compose(main, pins);
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

/** A promise and the function that settles it. */
function released(): { promise: Promise<void>; resolve: () => void } {
  let settle: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: () => settle?.() };
}

/** A distinct candidate for each main and pin list, as a real merge would produce. */
function candidateOf(main: CommitSha, pins: ClaimPin[]): CommitSha {
  const key = `${main}:${pins.map((p) => `${p.claimId}@${p.generation}:${p.commit}`).join(",")}`;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0").repeat(5);
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
  train: Train;
  fakes: Fakes;
  /** Builds another train over the same storage, as a restarted `Repo` does. */
  restart(): Train;
  events(): RailheadEvent[];
  sql: SqlStorage;
  /** Every time the train asked the Repo's alarm for, oldest first. */
  wakes: number[];
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
    const context: RepoContext = {
      repoId: REPO_ID,
      storage: state.storage,
      log,
      clock: () => (now += 1),
      env,
      wake: (at) => wakes.push(at),
    };
    const ports = fakes.ports(composeRepo(context));
    const build = () => createTrain(context, () => ports, fakes.portTimeoutMs);
    return body({
      train: build(),
      fakes,
      restart: build,
      events: () => log.replay(0, 256).events,
      sql: state.storage.sql,
      wakes,
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

  it("treats a duplicate ready as a no-op and refuses a changed or older pin", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train }) => {
      fakes.ready(pin(1, 2));
      expect(await train.enqueue(pin(1, 2))).toEqual(ok({ queued: true }));
      expect(await train.enqueue(pin(1, 2))).toEqual(ok({ queued: false }));
      expect(await train.enqueue(pin(1, 2, sha("f")))).toMatchObject({
        ok: false,
        code: "after_ready",
      });
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
      expect(shared.pins).toEqual([pin(1), pin(2)]);

      await train.recordCheck(report(shared, "fail"));
      const alone = lastStarted(fakes);
      expect(alone.pins).toEqual([pin(1)]);
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
      expect(second.pins).toEqual([pin(2)]);
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
        ? ok({ kind: "conflict", pins: [pin(1), pin(3)], paths: ["../escape", "src/upload.ts"] })
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
      expect(lastStarted(fakes).pins).toEqual([pin(2)]);
      // No question exists yet (#118): a parked pin stays parked, and a repeat does not requeue it.
      expect(train.entries(64).find((e) => e.state === "parked")).toMatchObject({
        reason: "conflict",
      });
      expect(await train.enqueue(pin(1))).toEqual(ok({ queued: false }));
      expect(states(train)["clm_claim001@1"]).toBe("parked");
    }, fakes);
  });

  it("fails the batch when a conflict names a pin outside it", async () => {
    const fakes = new Fakes();
    fakes.compose = () =>
      ok({ kind: "conflict", pins: [pin(1), pin(9)], paths: ["src/upload.ts"] });
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
      expect(lastStarted(fakes).pins).toEqual([pin(1)]);
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
      expect(lastStarted(fakes).pins).toEqual([pin(1, 2)]);
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
      // The lease alarm set with the queue entry, the drive's own lease, then the backoff that
      // moved the alarm earlier.
      expect(wakes).toEqual([
        accepted + DRIVE_LEASE_MS,
        accepted + 1 + DRIVE_LEASE_MS,
        now() + WAKE_BASE_MS,
      ]);

      // An alarm set by another module fires early: nothing is driven, and the wake is asked again.
      fakes.compose = (main, pins) => ok({ kind: "clean", candidate: candidateOf(main, pins) });
      await train.resume();
      expect(fakes.composeCalls).toHaveLength(1);
      expect(wakes).toHaveLength(4);
      expect(wakes[3]).toBe(wakes[2]);

      advance(WAKE_BASE_MS);
      await train.resume();
      const attempt = lastStarted(fakes);
      expect(attempt.pins).toEqual([pin(1)]);
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
      expect(lastStarted(fakes).pins).toEqual([pin(1)]);
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

      // Duplicate ready: the existing pin restarts the drive, which commits a due wake with its
      // lease before the merge port is asked, and the merge port then stops answering.
      fakes.compose = (main, pins) => ok({ kind: "clean", candidate: candidateOf(main, pins) });
      const release = fakes.hold("merge.compose");
      const duplicate = train.enqueue(pin(1));
      await vi.waitFor(() => expect(fakes.composeCalls).toHaveLength(composes + 1));
      expect(owed(sql)).toEqual({ dueAt: now(), failures: 0 });
      expect(wakes.slice(asked)).toEqual([now() + DRIVE_LEASE_MS]);
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
      expect(resumed.pins).toEqual([pin(1)]);
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

      expect(await train.enqueue(pin(1))).toEqual(ok({ queued: false }));
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
      insertEntry(sql, pin(1), 1);
      writeWake(sql, { dueAt: 1, failures: 0 });

      const again = restart();
      expect(wakes).toEqual([1]);
      expect(fakes.composeCalls).toEqual([]);

      await again.resume();
      expect(lastStarted(fakes).pins).toEqual([pin(1)]);
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
      expect(second.pins).toEqual([pin(2)]);
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
      const fresh = lastStarted(fakes);
      expect(fresh.attemptId).not.toBe(silent.attemptId);
      expect(fresh.pins).toEqual([pin(1)]);
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
      expect(events()).toEqual([]);

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
      expect(fakes.authorized).toEqual([]);
      expect(fakes.main).toBe(MAIN);
    }, fakes);
  });

  it("drops a pin whose attempts keep expiring and moves the next queued pin", async () => {
    const fakes = new Fakes();
    await withTrain(async ({ train, sql, now, advance }) => {
      fakes.ready(pin(1), pin(2));
      await train.enqueue(pin(1));
      await train.enqueue(pin(2));
      for (let expiry = 0; expiry <= MAX_RETRIES; expiry += 1) {
        advance(owed(sql).dueAt - now());
        await train.resume();
      }
      expect(states(train)).toEqual({ "clm_claim001@1": "dropped", "clm_claim002@1": "batched" });
      expect(train.entries(64).find((e) => e.pin.claimId === pin(1).claimId)?.reason).toBe(
        "retries_exhausted",
      );
      const last = lastStarted(fakes);
      expect(last.pins).toEqual([pin(2)]);
      expect(await train.recordCheck(report(last, "pass"))).toEqual(ok(last));
      expect(states(train)).toEqual({ "clm_claim001@1": "dropped", "clm_claim002@1": "landed" });
      expect(fakes.authorized).toEqual([last.attemptId]);
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
      expect(lastStarted(fakes).pins).toEqual([pin(2)]);
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
    await withTrain(async ({ train, now, advance }) => {
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
        wake: () => {},
      };
      // The real claims module would drop a pin for a claim it never opened, so its port is the
      // missing one here: the pin must wait for it rather than be dropped.
      const ports: RepoPorts = { ...composeRepo(context), claims: unavailableClaims };
      const train = createTrain(context, () => ports);

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
      insertEntry(state.storage.sql, pin(1), now);
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
      void createTrain(context, () => ports).enqueue(pin(1));
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
