import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
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
  MAX_QUEUE,
  MAX_RETRIES,
  MAX_WAKE_FAILURES,
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
  readonly intents = new Map<string, MergeIntentRecord>();

  ready(...pins: ClaimPin[]): void {
    for (const p of pins) this.pins.set(p.claimId, p);
  }

  ports(real: RepoPorts): RepoPorts {
    return {
      ...real,
      claims: {
        ...real.claims,
        pin: async (claimId) => {
          const current = this.pins.get(claimId);
          return current === undefined ? fail("not_found", "No such claim.") : ok(current);
        },
      },
      decisions: {
        ...real.decisions,
        requirements: async (claimId) => ok(this.requirements.get(claimId) ?? []),
      },
      merge: {
        compose: async (main, pins) => {
          this.composeCalls.push({ main, pins });
          return this.compose(main, pins);
        },
      },
      checks: {
        definitions: async (main) => this.definitions(main),
        start: async (attempt) => {
          this.started.push(attempt);
          if (this.startGate !== null) await this.startGate();
          return this.start(attempt);
        },
      },
      authorization: {
        authorize: async (attemptId) => {
          this.authorized.push(attemptId);
          const attempt = this.started.find((a) => a.attemptId === attemptId);
          if (attempt === undefined) return fail("check_not_passed", "Unknown attempt.");
          const result = this.authorize(attempt);
          if (result.ok) this.intents.set(result.value.intentId, result.value);
          return result;
        },
        intent: async () => fail("not_found", "No intent."),
      },
      mainWriter: {
        head: async () => this.head(),
        publish: async (intentId) => {
          this.published.push(intentId);
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
    const build = () => createTrain(context, () => ports);
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
      // The lease alarm set with the queue entry, then the backoff that moved it earlier.
      expect(wakes).toEqual([accepted + DRIVE_LEASE_MS, now() + WAKE_BASE_MS]);

      // An alarm set by another module fires early: nothing is driven, and the wake is asked again.
      fakes.compose = (main, pins) => ok({ kind: "clean", candidate: candidateOf(main, pins) });
      await train.resume();
      expect(fakes.composeCalls).toHaveLength(1);
      expect(wakes).toHaveLength(3);
      expect(wakes[2]).toBe(wakes[1]);

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
    fakes.start = () => fail("unavailable", "Runner offline.");
    await withTrain(async ({ train, sql, wakes, now, advance }) => {
      fakes.ready(pin(1), pin(2));
      await train.enqueue(pin(1));
      const attemptId = lastStarted(fakes).attemptId;
      expect(owed(sql).failures).toBe(1);

      for (let failures = 2; failures <= MAX_WAKE_FAILURES; failures += 1) {
        advance(owed(sql).dueAt - now());
        await train.resume();
        const delay = Math.min(WAKE_BASE_MS * 2 ** (failures - 1), WAKE_MAX_MS);
        expect(owed(sql)).toEqual({ dueAt: now() + delay, failures });
      }
      expect(owed(sql).dueAt - now()).toBe(WAKE_MAX_MS);
      // The enqueue's lease, then one backoff per failure.
      expect(wakes).toHaveLength(MAX_WAKE_FAILURES + 1);

      advance(WAKE_MAX_MS);
      await train.resume();
      expect(readWake(sql)).toBeNull();
      expect(wakes).toHaveLength(MAX_WAKE_FAILURES + 1);
      expect(fakes.started).toHaveLength(MAX_WAKE_FAILURES + 1);
      expect(train.batches(64)).toMatchObject([{ state: "checking", checkStarted: false }]);

      // The work stayed in storage: the next call starts the same attempt again.
      fakes.start = (attempt) => ok({ attemptId: attempt.attemptId });
      expect(await train.enqueue(pin(2))).toEqual(ok({ queued: true }));
      expect(lastStarted(fakes).attemptId).toBe(attemptId);
      expect(train.batches(64)).toMatchObject([{ state: "checking", checkStarted: true }]);
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
      const ports = composeRepo({
        repoId: REPO_ID,
        storage: state.storage,
        log,
        clock: () => 0,
        env,
        wake: () => {},
      });

      expect(await ports.train.enqueue(pin(1))).toEqual(ok({ queued: true }));
      expect(
        await ports.train.recordCheck({
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

    // The rebuilt train asks for its wake; the alarm drives it, and with no claims module
    // installed the drive stops on the pin and backs off. Nobody called the train.
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(stub);
        const after = await runInDurableObject(stub, (_instance, state) =>
          readWake(state.storage.sql),
        );
        expect(after).toMatchObject({ failures: 1 });
      },
      { timeout: 5_000, interval: 20 },
    );
    const { wake, alarm, entry } = await runInDurableObject(stub, async (_instance, state) => ({
      wake: readWake(state.storage.sql),
      alarm: await state.storage.getAlarm(),
      entry: state.storage.sql.exec("SELECT state FROM train_queue").toArray(),
    }));
    expect(alarm).toBe(wake?.dueAt);
    expect(entry).toEqual([{ state: "queued" }]);
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
    // The object stops while the drive waits on the port.
    await evictDurableObject(stub);

    // Nothing touches the object until the alarm is well past due.
    await new Promise((resolve) => setTimeout(resolve, Math.max(due - Date.now(), 0) + 1_500));
    const after = await runInDurableObject(stub, (_instance, state) => ({
      wake: readWake(state.storage.sql),
      entry: state.storage.sql.exec("SELECT state FROM train_queue").toArray(),
    }));
    // The alarm drove the pin before this read: with no claims module installed, each drive stops
    // on the pin and backs off, and the first backoff may have fired too.
    expect(after.wake?.failures).toBeGreaterThanOrEqual(1);
    expect(after.entry).toEqual([{ state: "queued" }]);
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  });
});
