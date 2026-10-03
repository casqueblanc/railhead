// The train: merging exact pins, checking the exact candidate, authorizing a merge intent and
// moving main against an expected commit.
//
// The public `train.intent` and `train.main` events tell the board what happened. They are not the
// storage the safety argument rests on: `MergeIntentRecord` is, and it is written in the Repo
// transaction that authorizes the merge, before any write to main is attempted.

import type { CheckDetail } from "@railhead/shared/board-api";
import type {
  CheckResult,
  CheckRunId,
  CommitSha,
  DecisionRef,
  IntentId,
} from "@railhead/shared/events";
import type { ClaimPin } from "./claims";
import type { PortResult } from "./result";

/**
 * A check definition as read from main, never from the change being checked. A candidate that
 * edits its own definition is held for a person, not checked with the edited definition.
 */
export interface CheckDefinition {
  /** The check's name. */
  name: string;
  /** The main commit the definition was read from. */
  source: CommitSha;
  /** SHA-256 of the definition's bytes, 64 lowercase hexadecimal characters. */
  digest: string;
  /** For an acceptance check, the decision version and option it proves; otherwise `null`. */
  acceptance: { decision: DecisionRef; option: string } | null;
}

/**
 * One persisted attempt to check one candidate. A runner's report counts only if it names this
 * attempt and this candidate; nothing transfers a result to another composition.
 */
export interface CheckAttempt {
  /** The attempt. */
  attemptId: CheckRunId;
  /** The main commit the candidate was composed on. */
  expectedMain: CommitSha;
  /** The exact composed commit being checked. */
  candidate: CommitSha;
  /** The pins composed into it, each at its generation. */
  pins: ClaimPin[];
  /** The trusted definition the run uses. */
  definition: CheckDefinition;
  /** The decision versions required when the attempt was scheduled. */
  decisions: DecisionRef[];
  /** When it was recorded. */
  createdAt: number;
}

/** What a runner reports, from outside the sandbox. */
export interface CheckReport {
  /** The attempt it reports on. */
  attemptId: CheckRunId;
  /** The candidate it ran on. */
  candidate: CommitSha;
  /** The outcome. `error` means the check could not run; it is never a pass. */
  result: CheckResult;
  /** SHA-256 of the stored log, or `null` when there is none. */
  logDigest: string | null;
  /** When the run finished. */
  finishedAt: number;
}

/**
 * What the check workflow reports for one run, from outside the sandbox. The checks module accepts
 * it only for its own started attempt, on the same candidate and definition.
 */
export interface CheckRunReport {
  /** The attempt it reports on. */
  attemptId: CheckRunId;
  /** The candidate it ran on. */
  candidate: CommitSha;
  /** SHA-256 of the trusted definition the run used. */
  digest: string;
  /** The outcome: `fail` only when the check's own command failed, `error` when it could not run. */
  result: CheckResult;
  /** The run's output. Untrusted text: stored cut to its end, never logged. */
  log: string;
  /** When the run finished. */
  finishedAt: number;
}

/** The result of composing pins on main. */
export type MergeOutcome =
  /** Git merged every pin; `candidate` is the composed commit, published only for checking. */
  | { kind: "clean"; candidate: CommitSha }
  /** Two pins conflict on these paths. */
  | { kind: "conflict"; pins: [ClaimPin, ClaimPin]; paths: string[] }
  /** The merge could not run, such as a missing commit or a timeout. Not the agents' failure. */
  | { kind: "error"; reason: "missing_commit" | "timeout" | "unsupported" | "infrastructure" };

/** Where a merge intent stands. The settled states are the `MainOutcome` of its `train.main` event. */
export type MergeIntentStatus =
  /** Recorded and authorized; main has not been confirmed moved. A writer must reconcile first. */
  | "authorized"
  /** Main moved from `expectedMain` to `candidate`. */
  | "updated"
  /** Main was not at `expectedMain`; nothing changed. */
  | "rejected"
  /** An uncertain write was settled by reading main back; `main` says what was found. */
  | "reconciled";

/** The durable record a merge is authorized by. */
export interface MergeIntentRecord {
  /** The intent. */
  intentId: IntentId;
  /** The main commit the update is conditional on. */
  expectedMain: CommitSha;
  /** The commit main moves to. */
  candidate: CommitSha;
  /** The pins merged, each at the generation that was current when authorized. */
  pins: ClaimPin[];
  /** The decision versions that were current when authorized. */
  decisions: DecisionRef[];
  /** The passing check attempt on exactly `candidate`. */
  checkAttemptId: CheckRunId;
  /** Where it stands. */
  status: MergeIntentStatus;
  /** Write attempts made so far. */
  attempts: number;
  /** Main as last observed by the writer, or `null` before the first attempt. */
  main: CommitSha | null;
  /** When it was authorized. */
  authorizedAt: number;
  /** When it last changed; while `authorized` with attempts counted, when the last attempt began. */
  updatedAt: number;
}

/**
 * How long after `MergePort.compose` is called it may still publish under its attempt, in
 * milliseconds. An implementation never pushes later, so a discard after it is final.
 */
export const MERGE_PUSH_WINDOW_MS = 90_000;

/**
 * Composes pins into a candidate in a sandbox. It never writes main.
 *
 * Each compose publishes under the candidate prefix of one merge attempt, a `mrg_` ID the caller
 * chooses and records before calling, so it can discard that prefix whatever the compose's outcome.
 * A caller gives each compose a fresh attempt and never composes under one it has discarded.
 */
export interface MergePort {
  /** Merges `pins`, in order, onto `expectedMain`, publishing a clean result under `attempt`. */
  compose(
    expectedMain: CommitSha,
    pins: ClaimPin[],
    attempt: string,
  ): Promise<PortResult<MergeOutcome>>;
  /**
   * Deletes every ref under `attempt`'s candidate prefix and nothing else. Succeeds once none is
   * left, including when there was none, so a repeat is harmless; `removed` counts this call's
   * deletes. A compose under `attempt` may publish until `MERGE_PUSH_WINDOW_MS` after it was
   * called, so a caller discards an attempt only after that.
   */
  discard(attempt: string): Promise<PortResult<{ removed: number }>>;
}

/** Starts trusted check runs. Results arrive later through `TrainPort.recordCheck`. */
export interface CheckPort {
  /**
   * The check definitions stored in `main`, the main commit a candidate is composed on. Each one's
   * `source` is `main`; nothing is read from the candidate.
   */
  definitions(main: CommitSha): Promise<PortResult<CheckDefinition[]>>;
  /**
   * Starts the run for a persisted attempt. A repeat for the same attempt starts nothing new. A
   * candidate that edits the definition or a path it protects is refused with `check_held` and
   * never run.
   */
  start(attempt: CheckAttempt): Promise<PortResult<{ attemptId: CheckRunId }>>;
  /**
   * Records a run's report for its started attempt and passes it to `TrainPort.recordCheck`. A
   * report for an attempt it did not start, on another candidate or definition, or with another
   * result than one already recorded, is refused with `check_mismatch`.
   */
  report(run: CheckRunReport): Promise<PortResult<CheckAttempt>>;
  /**
   * What was recorded for an attempt this module held or started: its candidate, the command its
   * definition gave it and where it stands, with at most `MAX_CHECK_DETAIL_LOG_BYTES` of its output.
   * An attempt it never recorded, or no longer keeps, is `not_found`.
   */
  detail(attemptId: CheckRunId): Promise<PortResult<CheckDetail>>;
}

/** A persisted check attempt and the report recorded for it, if one has been. */
export interface AttemptOutcome {
  /** The attempt. */
  attempt: CheckAttempt;
  /** The report `recordCheck` accepted for it, or `null` while none has been. */
  report: CheckReport | null;
}

/**
 * The train's queue and its check bookkeeping.
 *
 * `attemptOutcome` is a fence reader: it is synchronous and reads only the Repo's storage, so a
 * caller calls it inside its own `log.transaction` or `atomically` body, and what it returns holds
 * until that transaction commits. Read outside a transaction, the result may already be stale.
 */
export interface TrainPort {
  /** Queues a ready pin. A repeat for the same claim and generation is a no-op. */
  enqueue(pin: ClaimPin): Promise<PortResult<{ queued: boolean }>>;
  /** Records a runner's report if it matches its persisted attempt; otherwise `check_mismatch`. */
  recordCheck(report: CheckReport): Promise<PortResult<CheckAttempt>>;
  /**
   * The persisted attempt and its recorded report, or `null` when the attempt is unknown or the
   * module is missing; `null` is a refusal. Call it only inside the caller's transaction; an `await`
   * between this read and the write that relies on it is not a fence.
   */
  attemptOutcome(attemptId: CheckRunId): AttemptOutcome | null;
  /**
   * Called by the Repo's alarm. Moves accepted work the train still owes, if it is due, and asks
   * for the next wake itself. It never throws for a port's failure.
   */
  resume(): Promise<void>;
}

/** What the main writer records about its progress on an intent. */
export interface MergeIntentWrite {
  /** Where the intent stands now. `authorized` records an attempt that has not settled. */
  status: MergeIntentStatus;
  /** Write attempts made so far, including one about to start. */
  attempts: number;
  /** Main as last observed by the writer, or `null` before it observed main. */
  main: CommitSha | null;
}

/**
 * Authorizes a merge. Inside one Repo transaction it checks that the attempt passed on exactly its
 * candidate, that every pin's generation and every required decision version is still current,
 * and records the `MergeIntentRecord`. A repeat for the same attempt returns the same record.
 *
 * `record`, `unsettled` and `recordWrite` are fence methods: they are synchronous and touch only
 * the Repo's storage. Called inside a caller's `log.transaction` body, what they read holds and what
 * they write commits or rolls back with that transaction. Read outside one, a result may already be
 * stale, so a caller re-reads inside the transaction whose write relies on it.
 */
export interface AuthorizationPort {
  /** Authorizes the merge of a passed attempt. */
  authorize(attemptId: CheckRunId): Promise<PortResult<MergeIntentRecord>>;
  /** Reads an intent. */
  intent(intentId: IntentId): Promise<PortResult<MergeIntentRecord>>;
  /**
   * The stored intent, or `null` when it is unknown or the module is missing; `null` is a refusal.
   * Read it inside the caller's transaction when the result decides a write.
   */
  record(intentId: IntentId): MergeIntentRecord | null;
  /**
   * Every intent still `authorized` with a write attempt counted, oldest first: the writes that may
   * have moved main unheard. Read it inside the caller's transaction when the result decides a
   * write.
   */
  unsettled(): MergeIntentRecord[];
  /**
   * Records the main writer's progress, only if the intent is still `authorized` with exactly
   * `expectedAttempts` attempts, and returns the updated record; otherwise changes nothing and
   * returns `null`. Only the main writer calls it, inside the transaction that appends the
   * `train.main` event when the intent settles.
   */
  recordWrite(
    intentId: IntentId,
    expectedAttempts: number,
    change: MergeIntentWrite,
  ): MergeIntentRecord | null;
}

/** The result of one conditional update of main. */
export type MainUpdate =
  /** Main moved to the new commit. */
  | { kind: "updated" }
  /** Main was at `actual`, not the expected commit; nothing changed. */
  | { kind: "rejected"; actual: CommitSha }
  /** The outcome is unknown; read main back before anything else. */
  | { kind: "uncertain" };

/**
 * Main's ref. Only the main-writer module receives this port; no other port can mint a token that
 * writes main. An implementation must give the writer sole control of the ref: nothing else moves
 * it, and it never returns to a commit it left. The writer's reconciliation depends on that, since
 * it reads main anywhere but an intent's expected commit or candidate as proof the intent did not
 * land. Neither call promises a deadline or cancellation, so the main writer bounds each one and
 * treats an update that does not answer in time as uncertain. An implementation must send an update
 * within `MAIN_REF_TIMEOUT_MS` of the call to `update`, including any time it holds the update in
 * a queue or between retries, or drop it unsent; and a sent update that has not applied within
 * `MAIN_UPDATE_LIFETIME_MS` of being sent must never apply. The writer measures both from the call:
 * past `MAIN_UPDATE_EXPIRY_MS`, it reads main at the expected commit as proof the update did not
 * land.
 */
export interface MainRefPort {
  /** Reads main's current commit. */
  read(): Promise<PortResult<CommitSha>>;
  /** Moves main from `expected` to `next`, only if it is still at `expected`. Never forces. */
  update(expected: CommitSha, next: CommitSha): Promise<PortResult<MainUpdate>>;
}

/** Publishes authorized intents to main, and reads main for the modules that do not hold its ref. */
export interface MainWriterPort {
  /**
   * Main's current commit. It only reads: main may move as soon as it returns, so a caller records
   * it as an expected commit that a later conditional update checks, never as main itself.
   */
  head(): Promise<PortResult<CommitSha>>;
  /**
   * Moves main for an authorized intent and records the outcome. Every intent left `authorized` by
   * an earlier attempt, this one or another, is reconciled by reading main before any new write.
   */
  publish(intentId: IntentId): Promise<PortResult<MergeIntentRecord>>;
}
