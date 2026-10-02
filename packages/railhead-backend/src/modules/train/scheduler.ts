// The train's scheduler: one batch at a time, composed from the queue's exact pins on main,
// checked on exactly its candidate, then authorized and published.
//
// Every step is a durable state change made before the next external call, so a restarted `Repo`
// resumes from storage: a batch left composing is composed again from the same main and pins, and
// an attempt the check port never acknowledged is started again under the same id. Nothing here
// records a pass the runner did not report, and a failed batch's pins are composed and checked
// again rather than inheriting any part of its result.
//
// Nothing schedules the train from a timer: each `enqueue` and `recordCheck` drives it until it
// waits for a check report or a port, or the queue is empty. A train blocked on an unavailable port
// moves again on the next call. A thrown drive error does not undo the call's committed write:
// the call still returns its result, and the next call drives again.

import {
  isCommitSha,
  isId,
  MAX_CHECK_NAME_LENGTH,
  MAX_PATH_LENGTH,
  type Actor,
  type CommitSha,
  type DecisionRef,
} from "@railhead/shared/events";
import type { ClaimPin } from "../../contracts/claims";
import { fail, ok, type PortErrorCode, type PortResult } from "../../contracts/result";
import type {
  CheckAttempt,
  CheckDefinition,
  CheckReport,
  MergeIntentRecord,
  MergeOutcome,
  TrainPort,
} from "../../contracts/train";
import type { RepoContext, RepoPorts } from "../../repo/composeRepo";
import {
  activeBatch,
  batchByAttempt,
  batchedEntries,
  countPending,
  highestGeneration,
  insertBatch,
  insertEntry,
  markCheckStarted,
  migrateTrain,
  readEntry,
  recentBatches,
  recentEntries,
  recordCandidate,
  recordCheckResult,
  recordIntent,
  requeueFront,
  settleBatch,
  settleEntry,
  waitingEntries,
  type BatchFailure,
  type BatchRecord,
  type DropReason,
  type QueueEntry,
} from "./store";

/** Most pins waiting or batched at once. `enqueue` refuses with `busy` beyond it. */
export const MAX_QUEUE = 256;

/** Most pins one batch composes. */
export const MAX_BATCH = 8;

/** How many batches may fail for reasons outside a pin before the pin is dropped. */
export const MAX_RETRIES = 3;

/**
 * Most state transitions one call drives. Every transition that does not stop the drive settles or
 * consumes queue state: a batch costs at most four (form, compose, start or land, and a drop of
 * stale pins), and a pin joins at most `MAX_RETRIES + 3` batches (its retries, one shared failure,
 * one isolated run and its last one). The budget covers a full queue, so a drive never stops with
 * pins it could still move; `yielded` marks a broken bound rather than a normal pause.
 */
export const MAX_STEPS = 4 * MAX_QUEUE * (MAX_RETRIES + 3);

/** Most rows a diagnostic read returns. */
export const MAX_DIAGNOSTIC_ROWS = 64;

const TRAIN_ACTOR: Actor = { kind: "system", id: "sys_train" };

/**
 * What the train needs that no published port provides yet. #107 adds `MainWriterPort.head` and
 * `CheckPort.definitions`; until then production refuses both, so no batch starts.
 */
export interface TrainDeps {
  /** Main's current commit. */
  mainHead(): Promise<PortResult<CommitSha>>;
  /** The trusted check definitions read from `main`. */
  checkDefinitions(main: CommitSha): Promise<PortResult<CheckDefinition[]>>;
}

/** Why the train stopped short of a check or a landing. */
export type BlockReason =
  /** Main's commit could not be read. */
  | "main_unavailable"
  /** The check definitions could not be read. */
  | "definitions_unavailable"
  /** Main does not hold exactly one trusted check definition, so nothing can be checked. */
  | "definitions_not_single"
  /** The definition is not one this train can record: wrong source, name or digest. */
  | "definition_invalid"
  /** The claims module did not answer for a pin. */
  | "pin_unavailable"
  /** The decisions module did not answer for a claim. */
  | "requirements_unavailable"
  /** The merge port did not answer. */
  | "merge_unavailable"
  /** The check port did not accept the attempt. */
  | "checks_unavailable"
  /** The authorization port did not answer. */
  | "authorization_unavailable"
  /** The main writer did not answer, or left the intent unsettled. */
  | "publish_pending";

/** Where the train stands after a drive. */
export type DriveOutcome =
  /** Nothing is waiting and no batch is active. */
  | { kind: "idle" }
  /** The active batch waits for its runner's report. */
  | { kind: "checking"; batchId: number; attemptId: string }
  /** The train cannot move until a port answers; the next call tries again. */
  | { kind: "blocked"; batchId: number | null; reason: BlockReason; code: PortErrorCode | null }
  /** The drive used its step budget, which a correct queue never reaches; the next call continues. */
  | { kind: "yielded" };

/** The train port, with the scheduler's own reads. */
export interface Train extends TrainPort {
  /** Moves the train as far as it can go now. */
  drive(): Promise<DriveOutcome>;
  /** Up to `limit` batches with their diagnostics, newest first. */
  batches(limit: number): BatchRecord[];
  /** Up to `limit` queue entries in any state, most recently changed first. */
  entries(limit: number): QueueEntry[];
}

type Step = { kind: "continue" } | { kind: "stop"; outcome: DriveOutcome };

const CONTINUE: Step = { kind: "continue" };

/** Builds the train of one repository over its own tables. */
export function createTrain(context: RepoContext, ports: () => RepoPorts, deps: TrainDeps): Train {
  migrateTrain(context.storage);
  const { log, clock } = context;
  const sql = context.storage.sql;
  let running: Promise<DriveOutcome> | null = null;
  let again = false;

  function drive(): Promise<DriveOutcome> {
    if (running !== null) {
      again = true;
      return running;
    }
    const current = (async () => {
      try {
        let outcome: DriveOutcome;
        // A call that arrives while a drive runs asks for one more pass, never an unbounded chain.
        let passes = 0;
        do {
          again = false;
          outcome = await pass();
          passes += 1;
        } while (again && passes < 2);
        return outcome;
      } finally {
        running = null;
      }
    })();
    running = current;
    return current;
  }

  async function pass(): Promise<DriveOutcome> {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const batch = activeBatch(sql);
      const next = batch === null ? await form() : await advance(batch);
      if (next.kind === "stop") return next.outcome;
    }
    return { kind: "yielded" };
  }

  async function form(): Promise<Step> {
    const waiting = waitingEntries(sql, MAX_BATCH);
    const first = waiting[0];
    if (first === undefined) return stop({ kind: "idle" });
    const members = first.isolate ? [first] : takeWhile(waiting, (entry) => !entry.isolate);

    const stale: QueueEntry[] = [];
    for (const entry of members) {
      const current = await ports().claims.pin(entry.pin.claimId);
      if (!current.ok) {
        if (isTransient(current.code)) return blocked(null, "pin_unavailable", current.code);
        stale.push(entry);
      } else if (!samePin(current.value, entry.pin)) {
        stale.push(entry);
      }
    }
    if (stale.length > 0) {
      dropEntries(stale, "pin_changed");
      return CONTINUE;
    }

    const main = await deps.mainHead();
    if (!main.ok) return blocked(null, "main_unavailable", main.code);
    const definitions = await deps.checkDefinitions(main.value);
    if (!definitions.ok) return blocked(null, "definitions_unavailable", definitions.code);
    const [definition, ...others] = definitions.value;
    if (definition === undefined || others.length > 0) {
      return blocked(null, "definitions_not_single", null);
    }
    if (!isCommitSha(main.value) || !validDefinition(definition, main.value)) {
      return blocked(null, "definition_invalid", null);
    }

    const required: DecisionRef[] = [];
    const refused: QueueEntry[] = [];
    for (const entry of members) {
      const result = await ports().decisions.requirements(entry.pin.claimId);
      if (!result.ok) {
        if (isTransient(result.code)) return blocked(null, "requirements_unavailable", result.code);
        refused.push(entry);
      } else {
        required.push(...result.value);
      }
    }
    if (refused.length > 0) {
      dropEntries(refused, "requirements_refused");
      return CONTINUE;
    }

    const pins = members.map((entry) => entry.pin);
    const now = clock();
    context.storage.transactionSync(() => {
      // An enqueue during the reads above may have settled an entry; form again from storage.
      const unchanged = pins.every(
        (pin) => readEntry(sql, pin.claimId, pin.generation)?.state === "queued",
      );
      if (!unchanged || activeBatch(sql) !== null) return;
      insertBatch(
        sql,
        { expectedMain: main.value, pins, decisions: uniqueDecisions(required), definition },
        now,
      );
    });
    return CONTINUE;
  }

  async function advance(batch: BatchRecord): Promise<Step> {
    switch (batch.state) {
      case "composing":
        return compose(batch);
      case "checking":
        return startCheck(batch);
      case "passed":
        return land(batch);
      case "landed":
      case "failed":
        throw new Error("a settled batch is marked active");
      default:
        return unreachable(batch.state);
    }
  }

  async function compose(batch: BatchRecord): Promise<Step> {
    const result = await ports().merge.compose(batch.expectedMain, batch.pins);
    if (!result.ok) return blocked(batch.batchId, "merge_unavailable", result.code);
    const outcome = result.value;
    switch (outcome.kind) {
      case "clean": {
        if (!isCommitSha(outcome.candidate)) {
          failBatch(batch, "compose_unsupported");
          return CONTINUE;
        }
        const attemptId = `chk_${crypto.randomUUID().replaceAll("-", "")}`;
        context.storage.transactionSync(() => {
          recordCandidate(sql, batch.batchId, outcome.candidate, attemptId, clock());
        });
        return CONTINUE;
      }
      case "conflict":
        routeConflict(batch, outcome);
        return CONTINUE;
      case "error":
        failBatch(batch, composeFailure(outcome.reason));
        return CONTINUE;
      default:
        return unreachable(outcome);
    }
  }

  async function startCheck(batch: BatchRecord): Promise<Step> {
    const attempt = attemptOf(batch);
    if (!batch.checkStarted) {
      const started = await ports().checks.start(attempt);
      if (!started.ok) return blocked(batch.batchId, "checks_unavailable", started.code);
      if (started.value.attemptId !== attempt.attemptId) {
        throw new Error("the check port acknowledged another attempt");
      }
      context.storage.transactionSync(() => markCheckStarted(sql, batch.batchId, clock()));
    }
    return stop({ kind: "checking", batchId: batch.batchId, attemptId: attempt.attemptId });
  }

  async function land(batch: BatchRecord): Promise<Step> {
    const attemptId = batch.attemptId;
    if (attemptId === null || batch.candidate === null) {
      throw new Error("a passed batch has no attempt");
    }
    let intentId = batch.intentId;
    if (intentId === null) {
      const authorized = await ports().authorization.authorize(attemptId);
      if (!authorized.ok) {
        if (isTransient(authorized.code)) {
          return blocked(batch.batchId, "authorization_unavailable", authorized.code);
        }
        failBatch(batch, "authorization_refused");
        return CONTINUE;
      }
      const { value } = authorized;
      if (value.checkAttemptId !== attemptId || value.candidate !== batch.candidate) {
        throw new Error("authorization returned an intent for another attempt");
      }
      intentId = value.intentId;
      const recorded = intentId;
      context.storage.transactionSync(() => recordIntent(sql, batch.batchId, recorded, clock()));
    }
    const published = await ports().mainWriter.publish(intentId);
    if (!published.ok) {
      if (published.code === "main_moved") {
        failBatch(batch, "main_rejected");
        return CONTINUE;
      }
      if (isTransient(published.code)) {
        return blocked(batch.batchId, "publish_pending", published.code);
      }
      failBatch(batch, "publish_refused");
      return CONTINUE;
    }
    return settlePublished(batch, published.value);
  }

  function settlePublished(batch: BatchRecord, record: MergeIntentRecord): Step {
    switch (record.status) {
      case "updated":
        landBatch(batch);
        return CONTINUE;
      case "reconciled":
        if (record.main === batch.candidate) landBatch(batch);
        else failBatch(batch, "main_rejected");
        return CONTINUE;
      case "rejected":
        failBatch(batch, "main_rejected");
        return CONTINUE;
      case "authorized":
        return blocked(batch.batchId, "publish_pending", null);
      default:
        return unreachable(record.status);
    }
  }

  function landBatch(batch: BatchRecord): void {
    const now = clock();
    context.storage.transactionSync(() => {
      for (const pin of batch.pins) settleEntry(sql, pin, "landed", null, now);
      settleBatch(sql, batch.batchId, { state: "landed" }, now);
    });
  }

  /** Settles a failed batch and sends each pin back, isolated, retried or dropped. */
  function failBatch(batch: BatchRecord, failure: BatchFailure): void {
    context.storage.transactionSync(() => failBatchIn(batch, failure, clock()));
  }

  /** `failBatch` inside a transaction the caller holds. */
  function failBatchIn(batch: BatchRecord, failure: BatchFailure, now: number): void {
    const entries = orderAsBatch(batch, batchedEntries(sql));
    settleBatch(sql, batch.batchId, { state: "failed", failure }, now);
    const definitive = isDefinitive(failure);
    if (definitive && entries.length === 1) {
      for (const entry of entries) settleEntry(sql, entry.pin, "dropped", dropFor(failure), now);
      return;
    }
    if (definitive) {
      // A shared batch failed on the pins themselves: check each alone, never a subset's share.
      requeueFront(
        sql,
        entries.map((entry) => ({ pin: entry.pin, isolate: true, retries: entry.retries })),
        now,
      );
      return;
    }
    const retried = entries.map((entry) => ({ ...entry, retries: entry.retries + 1 }));
    for (const entry of retried) {
      if (entry.retries > MAX_RETRIES) {
        settleEntry(sql, entry.pin, "dropped", "retries_exhausted", now);
      }
    }
    requeueFront(
      sql,
      retried.filter((entry) => entry.retries <= MAX_RETRIES),
      now,
    );
  }

  /**
   * Parks a conflicting pair and asks a person: with no classifier installed, every conflict is
   * treated as a disagreement. The batch's other pins go back to the front unchanged.
   */
  function routeConflict(
    batch: BatchRecord,
    outcome: Extract<MergeOutcome, { kind: "conflict" }>,
  ): void {
    const [first, second] = outcome.pins;
    const path = outcome.paths.find(isRepoPath);
    const inBatch = (pin: ClaimPin) => batch.pins.some((member) => samePin(member, pin));
    if (
      path === undefined ||
      first.claimId === second.claimId ||
      !inBatch(first) ||
      !inBatch(second)
    ) {
      failBatch(batch, "compose_unsupported");
      return;
    }
    const now = clock();
    log.transaction((tx) => {
      const entries = orderAsBatch(batch, batchedEntries(sql));
      settleBatch(sql, batch.batchId, { state: "failed", failure: "conflict" }, now);
      const parked = (entry: QueueEntry) => samePin(entry.pin, first) || samePin(entry.pin, second);
      for (const entry of entries.filter(parked)) {
        settleEntry(sql, entry.pin, "parked", "conflict", now);
      }
      requeueFront(
        sql,
        entries.filter((entry) => !parked(entry)),
        now,
      );
      tx.append(TRAIN_ACTOR, {
        type: "train.conflict",
        data: {
          claims: [first.claimId, second.claimId],
          path,
          class: "contradictory",
          probability: 0,
          route: "question",
        },
      });
    });
  }

  function dropEntries(entries: readonly QueueEntry[], reason: DropReason): void {
    const now = clock();
    context.storage.transactionSync(() => {
      for (const entry of entries) {
        if (readEntry(sql, entry.pin.claimId, entry.pin.generation)?.state === "queued") {
          settleEntry(sql, entry.pin, "dropped", reason, now);
        }
      }
    });
  }

  /**
   * Drives after a call committed its write, so a port that rejects or a broken invariant cannot
   * turn that committed result into a thrown error. The error is logged by name only, never with
   * its message, which may carry a port's text.
   */
  async function driveAfterCommit(): Promise<void> {
    try {
      await drive();
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      console.error(
        JSON.stringify({ event: "train.drive_failed", repo: context.repoId, error: name }),
      );
    }
  }

  async function enqueue(pin: ClaimPin): Promise<PortResult<{ queued: boolean }>> {
    if (!validPin(pin)) {
      return fail("invalid_request", "The pin needs a claim, a positive generation and a commit.");
    }
    const now = clock();
    const result = context.storage.transactionSync((): PortResult<{ queued: boolean }> => {
      const existing = readEntry(sql, pin.claimId, pin.generation);
      if (existing !== null) {
        if (existing.pin.commit !== pin.commit) {
          return fail("after_ready", "This generation was queued with another commit.");
        }
        return ok({ queued: false });
      }
      if (highestGeneration(sql, pin.claimId) > pin.generation) {
        return fail("stale_generation", "A newer generation of this claim is queued.");
      }
      if (countPending(sql) >= MAX_QUEUE) {
        return fail("busy", "The train's queue is full.");
      }
      insertEntry(sql, pin, now);
      return ok({ queued: true });
    });
    if (!result.ok) return result;
    await driveAfterCommit();
    return result;
  }

  async function recordCheck(report: CheckReport): Promise<PortResult<CheckAttempt>> {
    if (!validReport(report)) {
      return fail("invalid_request", "The report needs an attempt, a candidate and a result.");
    }
    const result = log.transaction((tx): PortResult<CheckAttempt> => {
      const batch = batchByAttempt(sql, report.attemptId);
      if (batch === null || batch.candidate !== report.candidate) {
        return fail("check_mismatch", "No attempt on that candidate is waiting for a report.");
      }
      const attempt = attemptOf(batch);
      if (batch.checkResult !== null) {
        return batch.checkResult === report.result && batch.logDigest === report.logDigest
          ? ok(attempt)
          : fail("check_mismatch", "This attempt already has another result.");
      }
      if (batch.state !== "checking") {
        return fail("check_mismatch", "This attempt is no longer waiting for a report.");
      }
      const now = clock();
      recordCheckResult(sql, batch.batchId, report.result, report.logDigest, now);
      if (report.result !== "pass") {
        failBatchIn(batch, report.result === "fail" ? "check_fail" : "check_error", now);
      }
      tx.append(TRAIN_ACTOR, {
        type: "train.check",
        data: {
          checkRunId: attempt.attemptId,
          candidate: attempt.candidate,
          check: attempt.definition.name,
          result: report.result,
          acceptance: attempt.definition.acceptance,
        },
      });
      return ok(attempt);
    });
    const { value } = result;
    if (!value.ok) return value;
    await driveAfterCommit();
    return value;
  }

  return {
    enqueue,
    recordCheck,
    drive,
    batches: (limit) => recentBatches(sql, boundLimit(limit)),
    entries: (limit) => recentEntries(sql, boundLimit(limit)),
  };
}

function attemptOf(batch: BatchRecord): CheckAttempt {
  if (batch.attemptId === null || batch.candidate === null || batch.attemptAt === null) {
    throw new Error("the batch has no check attempt");
  }
  return {
    attemptId: batch.attemptId,
    expectedMain: batch.expectedMain,
    candidate: batch.candidate,
    pins: batch.pins,
    definition: batch.definition,
    decisions: batch.decisions,
    createdAt: batch.attemptAt,
  };
}

/** The batched entries in the batch's merge order. */
function orderAsBatch(batch: BatchRecord, entries: QueueEntry[]): QueueEntry[] {
  return batch.pins.flatMap((pin) => entries.filter((entry) => samePin(entry.pin, pin)));
}

function isDefinitive(failure: BatchFailure): boolean {
  switch (failure) {
    case "check_fail":
    case "compose_missing_commit":
    case "compose_unsupported":
      return true;
    case "conflict":
    case "compose_timeout":
    case "compose_infrastructure":
    case "check_error":
    case "authorization_refused":
    case "main_rejected":
    case "publish_refused":
      return false;
    default:
      return unreachable(failure);
  }
}

function dropFor(failure: BatchFailure): DropReason {
  return failure === "check_fail" ? "check_failed" : "compose_failed";
}

function composeFailure(reason: Extract<MergeOutcome, { kind: "error" }>["reason"]): BatchFailure {
  switch (reason) {
    case "missing_commit":
      return "compose_missing_commit";
    case "timeout":
      return "compose_timeout";
    case "unsupported":
      return "compose_unsupported";
    case "infrastructure":
      return "compose_infrastructure";
    default:
      return unreachable(reason);
  }
}

/** Refusals that say the port could not answer now, not that the request is wrong. */
function isTransient(code: PortErrorCode): boolean {
  return (
    code === "unavailable" ||
    code === "internal" ||
    code === "busy" ||
    code === "rate_limited" ||
    code === "quota_exceeded"
  );
}

function samePin(left: ClaimPin, right: ClaimPin): boolean {
  return (
    left.claimId === right.claimId &&
    left.generation === right.generation &&
    left.commit === right.commit
  );
}

function validPin(pin: ClaimPin): boolean {
  return (
    isId("claim", pin.claimId) &&
    Number.isSafeInteger(pin.generation) &&
    pin.generation > 0 &&
    isCommitSha(pin.commit)
  );
}

const DIGEST = /^[0-9a-f]{64}$/;

function validReport(report: CheckReport): boolean {
  return (
    isId("checkRun", report.attemptId) &&
    isCommitSha(report.candidate) &&
    (report.result === "pass" || report.result === "fail" || report.result === "error") &&
    (report.logDigest === null || DIGEST.test(report.logDigest)) &&
    Number.isSafeInteger(report.finishedAt) &&
    report.finishedAt >= 0
  );
}

function validDefinition(definition: CheckDefinition, main: CommitSha): boolean {
  const name = definition.name;
  return (
    definition.source === main &&
    DIGEST.test(definition.digest) &&
    name.trim() !== "" &&
    name.length <= MAX_CHECK_NAME_LENGTH
  );
}

/** The `requirePath` rule of `validateEvent`, so a conflict event is never refused at append. */
function isRepoPath(path: string): boolean {
  if (path === "" || path.length > MAX_PATH_LENGTH || path.startsWith("/")) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function uniqueDecisions(refs: readonly DecisionRef[]): DecisionRef[] {
  const seen = new Map<string, DecisionRef>();
  for (const ref of refs) seen.set(`${ref.decisionId}@${ref.version}`, ref);
  return [...seen.values()].toSorted(
    (a, b) => a.decisionId.localeCompare(b.decisionId) || a.version - b.version,
  );
}

function takeWhile<T>(items: readonly T[], keep: (item: T) => boolean): T[] {
  const index = items.findIndex((item) => !keep(item));
  return index === -1 ? [...items] : items.slice(0, index);
}

function boundLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) return 1;
  return Math.min(limit, MAX_DIAGNOSTIC_ROWS);
}

function blocked(batchId: number | null, reason: BlockReason, code: PortErrorCode | null): Step {
  return stop({ kind: "blocked", batchId, reason, code });
}

function stop(outcome: DriveOutcome): Step {
  return { kind: "stop", outcome };
}

function unreachable(value: never): never {
  throw new Error(`unhandled train state: ${String(value)}`);
}
