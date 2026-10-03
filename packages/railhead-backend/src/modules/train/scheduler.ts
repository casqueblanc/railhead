// The train's scheduler: one batch at a time, composed from the queue's exact pins on main,
// checked on exactly its candidate, then authorized and published.
//
// Every step is a durable state change made before the next external call, so a restarted `Repo`
// resumes from storage: a batch left composing is composed again from the same main and pins, and
// an attempt the check port never acknowledged is started again under the same id. Nothing here
// records a pass the runner did not report, and a failed batch's pins are composed and checked
// again rather than inheriting any part of its result.
//
// A pin is queued only inside the transaction that records `ready`, and the Repo's alarm drives
// the train once it commits; each `recordCheck` drives it at once. A drive runs until the train
// waits for a check report or a port, or the queue is empty. Whenever storage holds work the train
// owes (an active batch or a queued pin), it also holds a wake row and the Repo's alarm is set for
// it. `recordDebt` is the only writer of that row, and it writes inside the transaction that
// creates or restarts the debt: accepting work records it due now with the alarm due now, and
// starting a drive records it with the alarm `DRIVE_LEASE_MS` later, so the work is resumed even if
// the object stops before or during the drive and nothing else wakes it. When a drive ends, the
// train settles that debt from storage: it asks the alarm to drive again at once when work arrived
// too late for the drive, waits for the active attempt's deadline while a runner's report is due,
// backs off when a port refused or the drive threw, up to `MAX_WAKE_FAILURES` drives in a row, and
// otherwise clears it. After the last of those drives the
// row stays but is marked exhausted, and no alarm is asked for it; the next drive any call starts
// restores it with a fresh count. Neither a backoff nor exhaustion outlasts a requested attempt's
// deadline: the wake stays due by then, so the attempt expires even when no port answers again.
// A thrown drive error does not undo the call's committed write: the call still returns its result.
// A restarted train asks again for the wake it owes.
//
// The claims module queues a pin inside the transaction that records `ready`, so a pin and its
// queue entry commit together and a repeated `ready` queues nothing. Each such call is a new ready
// episode: a claim reopened by a superseded decision keeps its generation, so its next pin replaces
// the commit of its waiting entry or queues its settled entry again, and a batched entry takes the
// new commit once its batch settles. A batch formed for the earlier episode cannot land it, since
// the decision versions it was scheduled under are no longer current.
// Each entry records the episode it was queued for, and a drive settles or batches a waiting entry
// only while that episode and its commit are the ones it read, so a claim re-readied with the same
// commit during the drive's reads stays queued for the next pass. A batched entry re-readied with
// its batched commit is a newer episode than the batch was formed for: the batch's failure, conflict
// or landing never drops, parks or fails it, and it returns to the front of the queue as fresh work.
// A landing settles it as landed only when the claim's current decision versions are among the
// batch's, so a commit is never marked landed for an episode whose versions were not checked.
//
// Every port call is bounded by `PORT_TIMEOUT_MS`; a call that does not answer in time stops the
// drive as if the port were unavailable, and the alarm retries it under the same attempt or intent.
// Each drive also takes a new generation in storage with a lease of `DRIVE_LEASE_MS`. An alarm that
// finds the drive still running asks it for another pass and does not wait on it; once the lease has
// ended, the alarm starts a drive of the next generation instead. Every write a drive makes checks,
// inside its transaction, that the drive still holds the latest generation, so the earlier drive's
// late port answers change nothing.
//
// The deadline of a check attempt is recorded before the check port is asked to start it. An
// attempt the runner never reports, whether or not the port acknowledged it, expires at that
// deadline: the batch fails with `check_timeout`, its pins return to the queue as after a check
// error, and a report arriving at or after the deadline is refused, so a late pass can never
// authorize a landing. An attempt the check port holds for a person (`check_held`: the candidate
// edits protected check paths) is not an outage: the train records it, asks the port nothing more,
// waits for the deadline without backing off, and then fails the batch with `check_held`, counting
// no retry, so a held pin is never dropped for waiting. A shared batch goes back split into isolated
// pins, so the pins that do not edit those paths go on alone; a pin held alone is parked out of the
// queue, so it cannot hold the pins behind it.

import {
  isCommitSha,
  isId,
  MAX_CHECK_NAME_LENGTH,
  MAX_PATH_LENGTH,
  type Actor,
  type CommitSha,
  type CheckRunId,
  type DecisionRef,
} from "@railhead/shared/events";
import type { ClaimPin } from "../../contracts/claims";
import {
  fail,
  ok,
  type PortErrorCode,
  type PortName,
  type PortResult,
} from "../../contracts/result";
import type {
  AttemptOutcome,
  CheckAttempt,
  CheckDefinition,
  CheckReport,
  MergeIntentRecord,
  MergeOutcome,
  TrainPort,
} from "../../contracts/train";
import type { RepoContext, RepoPorts } from "../../repo/composeRepo";
import type { EventTransaction } from "../../repo/eventLog";
import {
  activeBatch,
  batchByAttempt,
  batchedEntries,
  clearWake,
  countPending,
  deferCommit,
  hasMovableWork,
  highestGeneration,
  insertBatch,
  insertEntry,
  markCheckHeld,
  markCheckStarted,
  migrateTrain,
  owesWork,
  promoteDeferred,
  readDrive,
  readEntry,
  readWake,
  recentBatches,
  recentEntries,
  recordCandidate,
  recordCheckResult,
  recordIntent,
  requeueEntry,
  requeueFront,
  requestCheck,
  settleBatch,
  settleEntry,
  waitingEntries,
  writeDrive,
  writeWake,
  type BatchFailure,
  type BatchRecord,
  type DropReason,
  type PendingWake,
  type QueueEntry,
} from "./store";

/** Most pins waiting or batched at once. `queue` refuses with `busy` beyond it. */
export const MAX_QUEUE = 256;

/** Most pins one batch composes. */
export const MAX_BATCH = 8;

/** How many batches may fail for reasons outside a pin before the pin is dropped. */
export const MAX_RETRIES = 3;

/** The first delay after a drive stops on a port or throws. Each failure in a row doubles it. */
export const WAKE_BASE_MS = 1_000;

/** The longest delay between drives that fail. */
export const WAKE_MAX_MS = 5 * 60_000;

/**
 * How long a drive holds the train before the Repo's alarm may take over, in case the drive never
 * settles. A drive that settles first moves or keeps the alarm as its outcome needs.
 */
export const DRIVE_LEASE_MS = 60_000;

/** Longest wait for one port call. It is shorter than the lease, so one hung call never outlives it. */
export const PORT_TIMEOUT_MS = 20_000;

/**
 * How long a check attempt waits for its runner's report, from when its start is first requested,
 * before it expires. The trusted check definition carries no limit yet, so every attempt gets this
 * one.
 */
export const CHECK_DEADLINE_MS = 60 * 60_000;

/**
 * Most drives in a row the alarm runs after a port refused or a drive threw, about 85 minutes in
 * all. After that the train stops asking and logs `train.wake_exhausted`; its work stays in storage
 * with a wake row marked `EXHAUSTED_FAILURES`, and the next `queue` or `recordCheck` drives it
 * again. A requested check attempt keeps one wake at its deadline, which expires it without a port.
 */
export const MAX_WAKE_FAILURES = 24;

/** The failure count of a wake row whose retries ran out: it is kept, but no alarm is asked for. */
export const EXHAUSTED_FAILURES = MAX_WAKE_FAILURES + 1;

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
  /**
   * The check port held the attempt for a person: the candidate edits protected check paths. Not
   * an outage: the train waits for the attempt's deadline without backing off.
   */
  | "check_held"
  /** The authorization port did not answer. */
  | "authorization_unavailable"
  /** The main writer did not answer, or left the intent unsettled. */
  | "publish_pending";

/** Where the train stands after a drive. */
export type DriveOutcome =
  /** Nothing is waiting and no batch is active. */
  | { kind: "idle" }
  /** The active batch waits for its runner's report until `deadline`. */
  | { kind: "checking"; batchId: number; attemptId: string; deadline: number }
  /** The train cannot move until a port answers; the alarm tries again after a delay. */
  | { kind: "blocked"; batchId: number | null; reason: BlockReason; code: PortErrorCode | null }
  /** The drive used its step budget, which a correct queue never reaches; the alarm continues. */
  | { kind: "yielded" }
  /** A drive of a later generation took over after this one's lease ended; it wrote nothing since. */
  | { kind: "superseded" };

/** The train port, with the scheduler's own reads. */
export interface Train extends TrainPort {
  /** Moves the train as far as it can go now, then settles the drive it owes. */
  drive(): Promise<DriveOutcome>;
  /** Up to `limit` batches with their diagnostics, newest first. */
  batches(limit: number): BatchRecord[];
  /** Up to `limit` queue entries in any state, most recently changed first. */
  entries(limit: number): QueueEntry[];
}

type Step = { kind: "continue" } | { kind: "stop"; outcome: DriveOutcome };

/** Why `recordDebt` writes the wake row. */
type Debt =
  /**
   * A call accepted work or a drive starts: stored work is due now, and the alarm at `alarmAt`
   * resumes it if the drive never settles.
   */
  | { kind: "start"; alarmAt: number }
  /** A drive ran clean. */
  | { kind: "clean" }
  /** A drive stopped on a port, threw or was superseded. */
  | { kind: "failed" };

const CONTINUE: Step = { kind: "continue" };

/** One drive of this instance. */
interface Drive {
  /** The generation it took in storage. */
  readonly generation: number;
  /** Whether a call arrived during the drive and asked for one more pass. */
  again: boolean;
}

/** The drive this instance is running. */
interface Running {
  readonly drive: Drive;
  /** Settles when the drive ends. */
  readonly promise: Promise<DriveOutcome>;
}

/** Thrown inside a drive's write once a later generation has taken over; nothing is written. */
class DriveSuperseded extends Error {
  constructor() {
    super("a later drive took over the train");
    this.name = "DriveSuperseded";
  }
}

/**
 * Builds the train of one repository over its own tables. `portTimeoutMs` bounds each port call;
 * only tests pass anything but `PORT_TIMEOUT_MS`.
 */
export function createTrain(
  context: RepoContext,
  ports: () => RepoPorts,
  portTimeoutMs = PORT_TIMEOUT_MS,
): Train {
  migrateTrain(context.storage);
  const { log, clock } = context;
  const sql = context.storage.sql;
  let running: Running | null = null;

  // A restarted train asks again for the wake it owes: the alarm may never have been set.
  const owed = readWake(sql);
  if (owed !== null && !isExhausted(owed)) context.wake(owed.dueAt);

  function drive(): Promise<DriveOutcome> {
    if (running !== null) {
      running.drive.again = true;
      return running.promise;
    }
    return startDrive();
  }

  /**
   * Takes the next generation with a fresh lease and drives under it. The lease and the debt for
   * the stored work commit together before any port is called, so a drive that restarts exhausted
   * work is resumed by the alarm even when the object stops before the drive settles.
   */
  function startDrive(): Promise<DriveOutcome> {
    const now = clock();
    const generation = context.storage.transactionSync((): number => {
      const next = (readDrive(sql)?.generation ?? 0) + 1;
      const leaseUntil = now + DRIVE_LEASE_MS;
      writeDrive(sql, { generation: next, leaseUntil });
      recordDebt(now, { kind: "start", alarmAt: leaseUntil });
      return next;
    });
    const current: Drive = { generation, again: false };
    const promise = run(current);
    running = { drive: current, promise };
    return promise;
  }

  async function run(current: Drive): Promise<DriveOutcome> {
    const { generation } = current;
    let outcome: DriveOutcome | null = null;
    try {
      // A call that arrives while a drive runs asks for one more pass, never an unbounded chain.
      // Work it leaves behind is found in storage by `settleWake`, which the alarm then drives.
      let passes = 0;
      do {
        current.again = false;
        outcome = await pass(generation);
        passes += 1;
      } while (current.again && passes < 2);
      return outcome;
    } catch (error) {
      if (!(error instanceof DriveSuperseded)) throw error;
      outcome = { kind: "superseded" };
      return outcome;
    } finally {
      // Nothing awaits between the last pass and here, so no call can commit work unseen. A
      // superseded drive leaves both to the drive that took over.
      if (running?.drive === current) {
        running = null;
        settleWake(generation, outcome);
      }
    }
  }

  /** Whether the drive of `generation` still holds the train. */
  function holds(generation: number): boolean {
    return readDrive(sql)?.generation === generation;
  }

  /** Runs `write` in a transaction, only while the drive of `generation` still holds the train. */
  function fenced<T>(generation: number, write: () => T): T {
    return context.storage.transactionSync((): T => {
      if (!holds(generation)) throw new DriveSuperseded();
      return write();
    });
  }

  /**
   * Calls a port for the drive of `generation`, never after a later drive took over, and waits at
   * most `portTimeoutMs`. A call that does not answer in time fails as `unavailable`; it may still
   * have taken effect, so the drive retries it under the same attempt or intent.
   */
  async function bounded<T>(
    generation: number,
    port: PortName,
    call: () => Promise<PortResult<T>>,
  ): Promise<PortResult<T>> {
    if (!holds(generation)) throw new DriveSuperseded();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PortResult<T>>((resolve) => {
      timer = setTimeout(() => {
        console.error(JSON.stringify({ event: "train.port_timeout", repo: context.repoId, port }));
        resolve(fail("unavailable", `The ${port} module did not answer in time.`));
      }, portTimeoutMs);
    });
    try {
      return await Promise.race([call(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Settles the drive the train owes after the drive of `generation` ended with `outcome`, or threw
   * (`null`). A failure in a row doubles the delay; a drive that ran clean clears the count. A drive
   * that no longer holds the train settles nothing.
   */
  function settleWake(generation: number, outcome: DriveOutcome | null): void {
    const now = clock();
    // A held attempt is not a failure: it waits for its deadline without backing off.
    const failed =
      outcome === null ||
      (outcome.kind === "blocked" && outcome.reason !== "check_held") ||
      outcome.kind === "yielded" ||
      outcome.kind === "superseded";
    const exhausted = context.storage.transactionSync(
      (): boolean => holds(generation) && recordDebt(now, { kind: failed ? "failed" : "clean" }),
    );
    if (exhausted) {
      console.error(
        JSON.stringify({
          event: "train.wake_exhausted",
          repo: context.repoId,
          failures: MAX_WAKE_FAILURES,
        }),
      );
    }
  }

  /**
   * Writes the wake row the stored work requires after `debt`, inside the caller's transaction, and
   * asks the Repo's alarm for it; the row and the alarm commit together. Every path that accepts
   * work or starts, retries, exhausts or ends a drive goes through here. Returns whether this write
   * exhausted the retries.
   */
  function recordDebt(now: number, debt: Debt): boolean {
    const wake = readWake(sql);
    switch (debt.kind) {
      case "start": {
        if (!owesWork(sql)) return false;
        // Restarting exhausted work grants a fresh count; any other start keeps the count so far.
        const failures = wake === null || isExhausted(wake) ? 0 : wake.failures;
        writeWake(sql, { dueAt: now, failures });
        context.wake(debt.alarmAt);
        return false;
      }
      case "clean": {
        const deadline = pendingDeadline();
        if (hasMovableWork(sql)) writeWakeIn({ dueAt: now, failures: 0 });
        else if (deadline !== null) writeWakeIn({ dueAt: deadline, failures: 0 });
        else clearWake(sql);
        return false;
      }
      case "failed": {
        const failures = (wake?.failures ?? 0) + 1;
        // Expiring a requested attempt needs no port, so neither backoff nor exhaustion may wait
        // past its deadline.
        const deadline = pendingDeadline();
        if (failures > MAX_WAKE_FAILURES) {
          if (deadline !== null) writeWakeIn({ dueAt: deadline, failures: MAX_WAKE_FAILURES });
          else if (owesWork(sql)) writeWake(sql, { dueAt: now, failures: EXHAUSTED_FAILURES });
          else clearWake(sql);
          return true;
        }
        const retryAt = now + wakeDelay(failures);
        writeWakeIn({ dueAt: deadline === null ? retryAt : Math.min(retryAt, deadline), failures });
        return false;
      }
      default:
        return unreachable(debt);
    }
  }

  /** Records a wake due at `dueAt` and asks the Repo's alarm for it, inside one transaction. */
  function writeWakeIn(wake: PendingWake): void {
    writeWake(sql, wake);
    context.wake(wake.dueAt);
  }

  /** The deadline of the active batch's started attempt, or `null`. */
  function pendingDeadline(): number | null {
    const batch = activeBatch(sql);
    return batch?.state === "checking" ? batch.checkDeadline : null;
  }

  async function pass(generation: number): Promise<DriveOutcome> {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const batch = activeBatch(sql);
      const next = batch === null ? await form(generation) : await advance(generation, batch);
      if (next.kind === "stop") return next.outcome;
    }
    return { kind: "yielded" };
  }

  async function form(generation: number): Promise<Step> {
    const waiting = waitingEntries(sql, MAX_BATCH);
    const first = waiting[0];
    if (first === undefined) return stop({ kind: "idle" });
    const members = first.isolate ? [first] : takeWhile(waiting, (entry) => !entry.isolate);

    const stale: QueueEntry[] = [];
    for (const entry of members) {
      const current = await bounded(generation, "claims", () =>
        ports().claims.pin(entry.pin.claimId),
      );
      if (!current.ok) {
        if (isTransient(current.code)) return blocked(null, "pin_unavailable", current.code);
        stale.push(entry);
      } else if (!samePin(current.value, entry.pin)) {
        stale.push(entry);
      }
    }
    if (stale.length > 0) {
      dropEntries(generation, stale, "pin_changed");
      return CONTINUE;
    }

    const main = await bounded(generation, "mainWriter", () => ports().mainWriter.head());
    if (!main.ok) return blocked(null, "main_unavailable", main.code);
    const definitions = await bounded(generation, "checks", () =>
      ports().checks.definitions(main.value),
    );
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
      const result = await bounded(generation, "decisions", () =>
        ports().decisions.requirements(entry.pin.claimId),
      );
      if (!result.ok) {
        if (isTransient(result.code)) return blocked(null, "requirements_unavailable", result.code);
        refused.push(entry);
      } else {
        required.push(...result.value);
      }
    }
    if (refused.length > 0) {
      dropEntries(generation, refused, "requirements_refused");
      return CONTINUE;
    }

    const pins = members.map((entry) => entry.pin);
    const now = clock();
    fenced(generation, () => {
      // A pin queued during the reads above may have changed an entry; form again from storage.
      const unchanged = members.every((entry) => stillObserved(entry));
      if (!unchanged || activeBatch(sql) !== null) return;
      insertBatch(
        sql,
        { expectedMain: main.value, pins, decisions: uniqueDecisions(required), definition },
        now,
      );
    });
    return CONTINUE;
  }

  async function advance(generation: number, batch: BatchRecord): Promise<Step> {
    switch (batch.state) {
      case "composing":
        return compose(generation, batch);
      case "checking":
        return startCheck(generation, batch);
      case "passed":
        return land(generation, batch);
      case "landed":
      case "failed":
        throw new Error("a settled batch is marked active");
      default:
        return unreachable(batch.state);
    }
  }

  async function compose(generation: number, batch: BatchRecord): Promise<Step> {
    const result = await bounded(generation, "merge", () =>
      ports().merge.compose(batch.expectedMain, batch.pins),
    );
    if (!result.ok) return blocked(batch.batchId, "merge_unavailable", result.code);
    const outcome = result.value;
    switch (outcome.kind) {
      case "clean": {
        if (!isCommitSha(outcome.candidate)) {
          failBatch(generation, batch, "compose_unsupported");
          return CONTINUE;
        }
        const attemptId = `chk_${crypto.randomUUID().replaceAll("-", "")}`;
        fenced(generation, () => {
          recordCandidate(sql, batch.batchId, outcome.candidate, attemptId, clock());
        });
        return CONTINUE;
      }
      case "conflict":
        routeConflict(generation, batch, outcome);
        return CONTINUE;
      case "error":
        failBatch(generation, batch, composeFailure(outcome.reason));
        return CONTINUE;
      default:
        return unreachable(outcome);
    }
  }

  async function startCheck(generation: number, batch: BatchRecord): Promise<Step> {
    const attempt = attemptOf(batch);
    if (batch.checkDeadline !== null && clock() >= batch.checkDeadline) {
      expireCheck(generation, batch);
      return CONTINUE;
    }
    // The deadline commits before the port is asked, so an attempt whose start never answers
    // still expires.
    const deadline = batch.checkDeadline ?? requestDeadline(generation, batch);
    if (batch.checkHeld) return blocked(batch.batchId, "check_held", "check_held");
    if (!batch.checkStarted) {
      const started = await bounded(generation, "checks", () => ports().checks.start(attempt));
      if (!started.ok && started.code === "check_held") {
        fenced(generation, () => markCheckHeld(sql, batch.batchId, clock()));
        return blocked(batch.batchId, "check_held", "check_held");
      }
      if (!started.ok) return blocked(batch.batchId, "checks_unavailable", started.code);
      if (started.value.attemptId !== attempt.attemptId) {
        throw new Error("the check port acknowledged another attempt");
      }
      fenced(generation, () => markCheckStarted(sql, batch.batchId, clock()));
    }
    return stop({
      kind: "checking",
      batchId: batch.batchId,
      attemptId: attempt.attemptId,
      deadline,
    });
  }

  /** Records when the batch's attempt expires, before its start is first requested. */
  function requestDeadline(generation: number, batch: BatchRecord): number {
    const now = clock();
    const deadline = now + CHECK_DEADLINE_MS;
    fenced(generation, () => requestCheck(sql, batch.batchId, deadline, now));
    return deadline;
  }

  /** Fails an attempt whose runner did not report by its deadline. */
  function expireCheck(generation: number, batch: BatchRecord): void {
    const now = clock();
    const expired = fenced(generation, () => {
      const current = activeBatch(sql);
      if (current?.batchId !== batch.batchId || current.checkResult !== null) return false;
      failBatchIn(current, current.checkHeld ? "check_held" : "check_timeout", now);
      return true;
    });
    if (expired) {
      console.error(
        JSON.stringify({
          event: "train.check_expired",
          repo: context.repoId,
          batch: batch.batchId,
          attempt: batch.attemptId,
        }),
      );
    }
  }

  async function land(generation: number, batch: BatchRecord): Promise<Step> {
    const attemptId = batch.attemptId;
    if (attemptId === null || batch.candidate === null) {
      throw new Error("a passed batch has no attempt");
    }
    let intentId = batch.intentId;
    if (intentId === null) {
      const authorized = await bounded(generation, "authorization", () =>
        ports().authorization.authorize(attemptId),
      );
      if (!authorized.ok) {
        if (isTransient(authorized.code)) {
          return blocked(batch.batchId, "authorization_unavailable", authorized.code);
        }
        failBatch(generation, batch, "authorization_refused");
        return CONTINUE;
      }
      const { value } = authorized;
      if (value.checkAttemptId !== attemptId || value.candidate !== batch.candidate) {
        throw new Error("authorization returned an intent for another attempt");
      }
      intentId = value.intentId;
      const recorded = intentId;
      fenced(generation, () => recordIntent(sql, batch.batchId, recorded, clock()));
    }
    const publishing = intentId;
    const published = await bounded(generation, "mainWriter", () =>
      ports().mainWriter.publish(publishing),
    );
    if (!published.ok) {
      if (published.code === "main_moved") {
        failBatch(generation, batch, "main_rejected");
        return CONTINUE;
      }
      if (isTransient(published.code)) {
        return blocked(batch.batchId, "publish_pending", published.code);
      }
      failBatch(generation, batch, "publish_refused");
      return CONTINUE;
    }
    return settlePublished(generation, batch, published.value);
  }

  function settlePublished(
    generation: number,
    batch: BatchRecord,
    record: MergeIntentRecord,
  ): Step {
    switch (record.status) {
      case "updated":
        landBatch(generation, batch);
        return CONTINUE;
      case "reconciled":
        if (record.main === batch.candidate) landBatch(generation, batch);
        else failBatch(generation, batch, "main_rejected");
        return CONTINUE;
      case "rejected":
        failBatch(generation, batch, "main_rejected");
        return CONTINUE;
      case "authorized":
        return blocked(batch.batchId, "publish_pending", null);
      default:
        return unreachable(record.status);
    }
  }

  function landBatch(generation: number, batch: BatchRecord): void {
    const now = clock();
    fenced(generation, () => {
      const unchecked = orderAsBatch(batch, batchedEntries(sql)).filter(
        (entry) => renewed(entry) && !checkedUnder(batch, entry.pin.claimId),
      );
      for (const pin of batch.pins) {
        if (!unchecked.some((entry) => samePin(entry.pin, pin))) {
          settleEntry(sql, pin, "landed", null, now);
        }
      }
      requeueFront(sql, unchecked.map(asFreshWork), now);
      settleBatch(sql, batch.batchId, { state: "landed" }, now);
      promoteDeferred(sql, now);
    });
  }

  /** Whether the claim's current decision versions are all among those `batch` was checked under. */
  function checkedUnder(batch: BatchRecord, claimId: string): boolean {
    const current = ports().decisions.currentVersions(claimId);
    return (
      current !== null &&
      current.every((ref) =>
        batch.decisions.some(
          (checked) => checked.decisionId === ref.decisionId && checked.version === ref.version,
        ),
      )
    );
  }

  /** Settles a failed batch and sends each pin back, isolated, retried or dropped. */
  function failBatch(generation: number, batch: BatchRecord, failure: BatchFailure): void {
    fenced(generation, () => failBatchIn(batch, failure, clock()));
  }

  /** `failBatch` inside a transaction the caller holds. */
  function failBatchIn(batch: BatchRecord, failure: BatchFailure, now: number): void {
    requeueFailed(batch, failure, now);
    promoteDeferred(sql, now);
  }

  /** Settles a failed batch's entries, before any newer commit they held is queued. */
  function requeueFailed(batch: BatchRecord, failure: BatchFailure, now: number): void {
    const entries = orderAsBatch(batch, batchedEntries(sql));
    settleBatch(sql, batch.batchId, { state: "failed", failure }, now);
    const held = failure === "check_held";
    const definitive = isDefinitive(failure);
    const returned: Returned[] = [];
    for (const entry of entries) {
      if (renewed(entry)) {
        returned.push(asFreshWork(entry));
      } else if (held && entries.length === 1) {
        // Held alone, the pin is the one that edits a protected path. It is parked, keeping its
        // pin, so the queue behind it moves. A new push enqueues the claim's next generation as a
        // new entry. The approval action (#174) is the other way back: it will requeue this entry.
        settleEntry(sql, entry.pin, "parked", "check_held", now);
      } else if (held) {
        // Waiting for a person is no fault of the pins: no retry is counted and none is dropped.
        returned.push({ pin: entry.pin, isolate: true, retries: entry.retries });
      } else if (definitive && entries.length === 1) {
        settleEntry(sql, entry.pin, "dropped", dropFor(failure), now);
      } else if (definitive) {
        // A shared batch failed on the pins themselves: check each alone, never a subset's share.
        returned.push({ pin: entry.pin, isolate: true, retries: entry.retries });
      } else if (entry.retries + 1 > MAX_RETRIES) {
        settleEntry(sql, entry.pin, "dropped", "retries_exhausted", now);
      } else {
        returned.push({ pin: entry.pin, isolate: entry.isolate, retries: entry.retries + 1 });
      }
    }
    requeueFront(sql, returned, now);
  }

  /**
   * Parks a conflicting pair and records `train.conflict`, which the board shows with both claims
   * and the path. With no classifier installed, every conflict is treated as a disagreement and
   * given `route: "question"`, but no question is created and nothing unparks the pair: no port
   * lets the train ask yet (#118). The batch's other pins go back to the front unchanged.
   */
  function routeConflict(
    generation: number,
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
      failBatch(generation, batch, "compose_unsupported");
      return;
    }
    const now = clock();
    log.transaction((tx) => {
      if (!holds(generation)) throw new DriveSuperseded();
      const entries = orderAsBatch(batch, batchedEntries(sql));
      settleBatch(sql, batch.batchId, { state: "failed", failure: "conflict" }, now);
      const parked = (entry: QueueEntry) =>
        !renewed(entry) && (samePin(entry.pin, first) || samePin(entry.pin, second));
      for (const entry of entries.filter(parked)) {
        settleEntry(sql, entry.pin, "parked", "conflict", now);
      }
      requeueFront(
        sql,
        entries
          .filter((entry) => !parked(entry))
          .map((entry) => (renewed(entry) ? asFreshWork(entry) : entry)),
        now,
      );
      promoteDeferred(sql, now);
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

  function dropEntries(
    generation: number,
    entries: readonly QueueEntry[],
    reason: DropReason,
  ): void {
    const now = clock();
    fenced(generation, () => {
      for (const entry of entries) {
        // A ready episode queued during the reads is newer than what they judged; keep it.
        if (stillObserved(entry)) settleEntry(sql, entry.pin, "dropped", reason, now);
      }
    });
  }

  /**
   * Whether the waiting entry `observed` is still the one stored: the same commit at the same ready
   * episode. A claim re-readied with the same commit is a new episode, which a judgement of the
   * earlier one must not settle.
   */
  function stillObserved(observed: QueueEntry): boolean {
    const stored = readEntry(sql, observed.pin.claimId, observed.pin.generation);
    return (
      stored?.state === "queued" &&
      stored.pin.commit === observed.pin.commit &&
      stored.episode === observed.episode
    );
  }

  /**
   * Drives without throwing, so a port that rejects or a broken invariant cannot turn a committed
   * result into a thrown error; the drive has already asked for its retry. The error is logged by
   * name only, never with its message, which may carry a port's text.
   */
  async function driveLogged(): Promise<void> {
    try {
      await drive();
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      console.error(
        JSON.stringify({ event: "train.drive_failed", repo: context.repoId, error: name }),
      );
    }
  }

  async function resume(): Promise<void> {
    const owedNow = readWake(sql);
    // Exhausted work waits for a call; an alarm another module asked for does not restart it.
    if (owedNow === null || isExhausted(owedNow)) return;
    const now = clock();
    // Another module's alarm may fire first; ask again for this train's own time.
    if (owedNow.dueAt > now) {
      context.wake(owedNow.dueAt);
      return;
    }
    const current = running?.drive ?? null;
    if (current !== null) {
      const lease = readDrive(sql);
      if (lease?.generation === current.generation && now < lease.leaseUntil) {
        // The drive is within its lease: ask it for another pass and come back when the lease
        // ends, without waiting on it here.
        current.again = true;
        context.wake(lease.leaseUntil);
        return;
      }
      // The drive outlived its lease, so it is waiting on something that will not answer in time.
      // The next generation takes over, and the earlier drive's writes are refused from here on.
      running = null;
      console.error(
        JSON.stringify({
          event: "train.drive_superseded",
          repo: context.repoId,
          generation: current.generation,
        }),
      );
    }
    await driveLogged();
  }

  function attemptOutcome(attemptId: CheckRunId): AttemptOutcome | null {
    const batch = batchByAttempt(sql, attemptId);
    if (batch === null) return null;
    const attempt = attemptOf(batch);
    if (batch.checkResult === null) return { attempt, report: null };
    if (batch.finishedAt === null) throw new Error("a recorded report has no finish time");
    return {
      attempt,
      report: {
        attemptId: attempt.attemptId,
        candidate: attempt.candidate,
        result: batch.checkResult,
        logDigest: batch.logDigest,
        finishedAt: batch.finishedAt,
      },
    };
  }

  function queue(
    _tx: EventTransaction,
    pin: ClaimPin,
    episode: number,
  ): PortResult<{ queued: boolean }> {
    const now = clock();
    if (!validPin(pin) || !Number.isSafeInteger(episode) || episode <= 0) {
      return fail(
        "invalid_request",
        "The pin needs a claim, a positive generation, a commit and a positive episode.",
      );
    }
    if (highestGeneration(sql, pin.claimId) > pin.generation) {
      return fail("stale_generation", "A newer generation of this claim is queued.");
    }
    const existing = readEntry(sql, pin.claimId, pin.generation);
    let queued = true;
    if (existing !== null) {
      switch (existing.state) {
        case "batched":
          // The active batch keeps the commit it was formed with; the newer one waits for it.
          deferCommit(sql, pin, episode, now);
          queued = false;
          break;
        case "queued":
          // A new episode is fresh work, even with the commit the entry already holds: retries
          // counted for the earlier episode must not drop this one. A drive reading the entry
          // judged the earlier episode, so it leaves the entry queued.
          requeueEntry(sql, pin, episode, now);
          queued = existing.pin.commit !== pin.commit;
          break;
        case "landed":
          // Main already holds this commit, merged under the decision versions of an earlier
          // episode. A new episode must bring a new commit, which is merged and checked under its
          // own versions.
          if (existing.pin.commit === pin.commit) {
            return fail(
              "decision_superseded",
              "This commit already landed; adapt it as a new one.",
            );
          }
          break;
        case "dropped":
        case "parked":
          break;
        default:
          return unreachable(existing.state);
      }
    }
    if (queued && existing?.state !== "queued") {
      if (countPending(sql) >= MAX_QUEUE) {
        return fail("busy", "The train's queue is full.");
      }
      if (existing === null) insertEntry(sql, pin, episode, now);
      else requeueEntry(sql, pin, episode, now);
    }
    // Every accepted episode is owed a drive, which also restarts a wake whose retries ran out,
    // so work it leaves runnable is never stranded. The Repo's alarm starts the drive once the
    // caller's transaction commits.
    recordDebt(now, { kind: "start", alarmAt: now });
    return ok({ queued });
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
      // The deadline is the cutoff even before a drive expires the attempt.
      if (batch.checkDeadline !== null && now >= batch.checkDeadline) {
        return fail("check_mismatch", "This attempt expired before its report arrived.");
      }
      recordCheckResult(
        sql,
        batch.batchId,
        report.result,
        report.logDigest,
        report.finishedAt,
        now,
      );
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
      recordDebt(now, { kind: "start", alarmAt: now + DRIVE_LEASE_MS });
      return ok(attempt);
    });
    const { value } = result;
    if (!value.ok) return value;
    await driveLogged();
    return value;
  }

  return {
    queue,
    recordCheck,
    attemptOutcome,
    resume,
    drive,
    batches: (limit) => recentBatches(sql, boundLimit(limit)),
    entries: (limit) => recentEntries(sql, boundLimit(limit)),
  };
}

/** Whether the wake's retries ran out, so only a call drives its work again. */
function isExhausted(wake: PendingWake): boolean {
  return wake.failures >= EXHAUSTED_FAILURES;
}

/** `WAKE_BASE_MS` doubled for each failure after the first, at most `WAKE_MAX_MS`. */
function wakeDelay(failures: number): number {
  return Math.min(WAKE_BASE_MS * 2 ** Math.min(failures - 1, 20), WAKE_MAX_MS);
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

/** An entry sent back to the queue's front, with the counters it keeps. */
type Returned = { pin: ClaimPin; isolate: boolean; retries: number };

/**
 * Whether a batched entry was readied again with its batched commit after its batch was formed, so
 * it holds a newer episode than the one the batch's result belongs to.
 */
function renewed(entry: QueueEntry): boolean {
  return entry.episode !== entry.batchedEpisode;
}

/** A renewed entry returned to the queue as fresh work for its newer episode. */
function asFreshWork(entry: QueueEntry): Returned {
  return { pin: entry.pin, isolate: false, retries: 0 };
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
    case "check_timeout":
    case "check_held":
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
