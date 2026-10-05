// Merge authorization: the durable record a write to main rests on.
//
// `authorize` runs one Repo transaction. Inside it, it reads the persisted check attempt and its
// report, every pin's current claim generation, ready pin and inbox ready gate, and the current
// version of every decision the pins must satisfy, through synchronous readers the train, claims,
// inbox and decisions modules supply. If all still hold, it writes the `MergeIntentRecord` and appends `train.intent`
// in the same transaction, before anything tries to move main. If any reader's answer has moved,
// nothing is written.
//
// A repeat for the same attempt returns the record already written, without checking again: the
// authorization happened, and a caller that lost the first response must see the same intent rather
// than a second one or a refusal.

import {
  isCommitSha,
  isId,
  MAX_LIST_LENGTH,
  type Actor,
  type CheckRunId,
  type ClaimId,
  type DecisionRef,
  type IntentId,
} from "@railhead/shared/events";
import type { ClaimPin, EpisodePin, ReadyPin } from "../contracts/claims";
import type { ReadyGate } from "../contracts/inbox";
import { sameVersions } from "../modules/claims/module";
import { fail, ok, type PortFailure, type PortResult } from "../contracts/result";
import type {
  AuthorizationPort,
  CheckAttempt,
  CheckReport,
  MergeIntentRecord,
  MergeIntentStatus,
  MergeIntentWrite,
} from "../contracts/train";
import type { EventLog } from "../repo/eventLog";
import { migrate, type RepoStorage } from "../repo/storage";

/** The migration owner name of the merge intent table. */
export const AUTHORIZATION_OWNER = "authorization";

/** Released schema steps of the merge intent table. Append a step to change it; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE merge_intents (
    intent_id TEXT PRIMARY KEY,
    check_attempt_id TEXT NOT NULL UNIQUE,
    expected_main TEXT NOT NULL,
    candidate TEXT NOT NULL,
    pins TEXT NOT NULL,
    decisions TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('authorized', 'updated', 'rejected', 'reconciled')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    main TEXT,
    authorized_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
];

/** The actor `train.intent` events are recorded under. */
export const TRAIN_ACTOR: Actor = { kind: "system", id: "sys_train" };

/**
 * What authorization reads from other modules. Each reader is synchronous and is called only inside
 * the transaction that writes the intent, so its answer is current when the record is written.
 * `null` means unknown, including a module that is not installed, and never authorizes.
 */
export interface AuthorizationReaders {
  /** The persisted attempt and the report recorded against it, or `null` when there is none. */
  attemptOutcome(
    attemptId: CheckRunId,
  ): { attempt: CheckAttempt; report: CheckReport | null } | null;
  /** The claim's current ownership generation, or `null` when the claim is unknown or closed. */
  currentGeneration(claimId: ClaimId): number | null;
  /** The current version of every decision the claim's work must satisfy, or `null` when unknown. */
  currentVersions(claimId: ClaimId): DecisionRef[] | null;
  /** The ready claim's stored pin and the versions it was recorded under, or `null` when not ready. */
  readyPin(claimId: ClaimId): ReadyPin | null;
  /** The claim's inbox ready gate at a generation, or `null` when the inbox cannot answer. */
  readyGateNow(claimId: ClaimId, generation: number): ReadyGate | null;
}

/** What the authorization module needs from its Repo. */
export interface AuthorizationContext {
  /** The Repo's storage, for this module's own table. */
  readonly storage: RepoStorage;
  /** The event log, whose transaction the record and its event are written in. */
  readonly log: EventLog;
  /** The current time, in milliseconds since the Unix epoch. */
  readonly clock: () => number;
}

/** Builds the authorization port over the Repo's storage and the given readers. */
export function createAuthorization(
  context: AuthorizationContext,
  readers: AuthorizationReaders,
  newIntentId: () => IntentId = randomIntentId,
): AuthorizationPort {
  migrate(context.storage, AUTHORIZATION_OWNER, MIGRATIONS);
  return {
    authorize: async (attemptId) => authorize(context, readers, newIntentId, attemptId),
    intent: async (intentId) => {
      if (!isId("intent", intentId)) {
        return fail("invalid_request", "The intent id is not an intent identifier.");
      }
      const record = readIntent(context.storage, "intent_id", intentId);
      return record === null ? fail("not_found", "No such merge intent.") : ok(record);
    },
    record: (intentId) =>
      isId("intent", intentId) ? readIntent(context.storage, "intent_id", intentId) : null,
    unsettled: () =>
      context.storage.sql
        .exec<IntentRow>(
          `SELECT * FROM merge_intents WHERE status = 'authorized' AND attempts > 0
           ORDER BY authorized_at, intent_id`,
        )
        .toArray()
        .map(toRecord),
    recordWrite: (intentId, expectedAttempts, change) =>
      recordWrite(context, intentId, expectedAttempts, change),
  };
}

/**
 * Applies the main writer's change if the intent is still `authorized` at `expectedAttempts`. A
 * change that would lower the attempt count, or record main moved without an observed commit, is a
 * bug in the caller and is refused rather than stored.
 */
function recordWrite(
  context: AuthorizationContext,
  intentId: IntentId,
  expectedAttempts: number,
  change: MergeIntentWrite,
): MergeIntentRecord | null {
  if (!isId("intent", intentId)) return null;
  if (!Number.isSafeInteger(change.attempts) || change.attempts < expectedAttempts) return null;
  if (change.main !== null && !isCommitSha(change.main)) return null;
  if (change.status !== "authorized" && change.main === null) return null;
  const cursor = context.storage.sql.exec(
    `UPDATE merge_intents SET status = ?, attempts = ?, main = ?, updated_at = ?
     WHERE intent_id = ? AND status = 'authorized' AND attempts = ?`,
    change.status,
    change.attempts,
    change.main,
    context.clock(),
    intentId,
    expectedAttempts,
  );
  if (cursor.rowsWritten === 0) return null;
  return readIntent(context.storage, "intent_id", intentId);
}

function authorize(
  context: AuthorizationContext,
  readers: AuthorizationReaders,
  newIntentId: () => IntentId,
  attemptId: CheckRunId,
): PortResult<MergeIntentRecord> {
  if (!isId("checkRun", attemptId)) {
    return fail("invalid_request", "The attempt id is not a check run identifier.");
  }
  const { value } = context.log.transaction((tx): PortResult<MergeIntentRecord> => {
    const existing = readIntent(context.storage, "check_attempt_id", attemptId);
    if (existing !== null) return ok(existing);

    const verified = verify(readers, attemptId);
    if (!verified.ok) return verified;
    const { attempt, decisions } = verified.value;

    const now = context.clock();
    const record: MergeIntentRecord = {
      intentId: newIntentId(),
      expectedMain: attempt.expectedMain,
      candidate: attempt.candidate,
      pins: attempt.pins.map(({ claimId, generation, commit, episode }) => ({
        claimId,
        generation,
        commit,
        episode,
      })),
      decisions,
      checkAttemptId: attempt.attemptId,
      status: "authorized",
      attempts: 0,
      main: null,
      authorizedAt: now,
      updatedAt: now,
    };
    tx.sql.exec(
      `INSERT INTO merge_intents (intent_id, check_attempt_id, expected_main, candidate, pins,
         decisions, status, attempts, main, authorized_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.intentId,
      record.checkAttemptId,
      record.expectedMain,
      record.candidate,
      JSON.stringify(record.pins),
      JSON.stringify(record.decisions),
      record.status,
      record.attempts,
      record.main,
      record.authorizedAt,
      record.updatedAt,
    );
    tx.append(TRAIN_ACTOR, {
      type: "train.intent",
      data: {
        intentId: record.intentId,
        expectedMain: record.expectedMain,
        candidate: record.candidate,
        claims: record.pins.map((pin) => pin.claimId),
        decisions: record.decisions,
        checkRunId: record.checkAttemptId,
      },
    });
    return ok(record);
  });
  return value;
}

interface Verified {
  attempt: CheckAttempt;
  /** The decision versions current now, which the record stores. */
  decisions: DecisionRef[];
}

/** Checks, against current state, everything an intent rests on. Reads only. */
function verify(readers: AuthorizationReaders, attemptId: CheckRunId): PortResult<Verified> {
  const outcome = readers.attemptOutcome(attemptId);
  if (outcome === null) return fail("not_found", "No such check attempt.");
  const { attempt, report } = outcome;
  if (attempt.attemptId !== attemptId) {
    return mismatch("The stored attempt names another attempt.");
  }
  if (report === null) return fail("check_not_passed", "The check has not finished.");
  // A report counts only for the attempt and candidate it was persisted against.
  if (report.attemptId !== attempt.attemptId || report.candidate !== attempt.candidate) {
    return mismatch("The check report is for another attempt or candidate.");
  }
  if (report.finishedAt < attempt.createdAt) {
    return mismatch("The check report finished before its attempt was recorded.");
  }
  switch (report.result) {
    case "pass":
      break;
    case "fail":
      return fail("check_not_passed", "The check failed on this candidate.");
    case "error":
      return fail("check_not_passed", "The check could not run on this candidate.");
    default:
      return unreachable(report.result);
  }

  const pinsChecked = checkPins(attempt.pins);
  if (pinsChecked !== null) return pinsChecked;
  // Every decision the pins must satisfy now must be the version the check was scheduled under.
  const fenced = checkFence(
    readers,
    attempt.pins,
    attempt.decisions,
    attempt.definition.acceptance?.decision ?? null,
  );
  if (!fenced.ok) return fenced;
  const current = fenced.value;
  if (current.length > MAX_LIST_LENGTH) {
    return mismatch(`The pins must satisfy more than ${MAX_LIST_LENGTH} decisions.`);
  }
  return ok({ attempt, decisions: current });
}

/**
 * What a merge fence reads: each claim's generation, ready pin and inbox ready gate, and the
 * decisions its work must satisfy.
 */
export type FenceReaders = Pick<
  AuthorizationReaders,
  "currentGeneration" | "currentVersions" | "readyPin" | "readyGateNow"
>;

/**
 * The fence a merge rests on, shared by the train, authorization and the main writer so the rule
 * has one copy. Every pin's claim must still be at its pinned generation, with every inbox item
 * affecting it acknowledged, and still ready with exactly that commit in the pin's ready episode,
 * recorded under the decision versions current now; every decision the pins must satisfy now must
 * be at the version in `required`, with no two pins reporting different versions of one decision;
 * and `acceptance`, the decision a passing acceptance check proves, must be among them. A claim
 * reopened and readied again with the same commit is a new episode, so a check of the earlier one
 * never lets it through. Returns the decision versions current now. Reads only: call it inside
 * the transaction whose write relies on its answer.
 */
export function checkFence(
  readers: FenceReaders,
  pins: readonly EpisodePin[],
  required: readonly DecisionRef[],
  acceptance: DecisionRef | null,
): PortResult<DecisionRef[]> {
  for (const pin of pins) {
    if (readers.currentGeneration(pin.claimId) !== pin.generation) {
      return fail("stale_generation", "A claim changed owner since its pin was checked.");
    }
  }
  const expected = new Map(required.map((ref) => [ref.decisionId, ref.version]));
  const current = new Map<string, number>();
  for (const pin of pins) {
    const refs = readers.currentVersions(pin.claimId);
    if (refs === null) return superseded("The decisions this claim must satisfy are unknown.");
    const ready = readers.readyPin(pin.claimId);
    if (ready === null || ready.pin.commit !== pin.commit) {
      return superseded("A claim is no longer ready with this commit.");
    }
    if (ready.episode !== pin.episode) {
      return superseded("A claim was readied again since its pin was checked.");
    }
    if (!sameVersions(ready.decisions, refs)) {
      return superseded("A decision changed since the claim was marked ready.");
    }
    for (const ref of refs) {
      const seen = current.get(ref.decisionId);
      if (seen !== undefined && seen !== ref.version) {
        return superseded("Two claims report different versions of one decision.");
      }
      current.set(ref.decisionId, ref.version);
      if (expected.get(ref.decisionId) !== ref.version) {
        return superseded("A decision changed since the check was scheduled.");
      }
    }
    // An obligation queued after the batch formed, such as rework under the same decision
    // version, changes neither the pin nor its versions; only the gate shows it.
    const gate = readers.readyGateNow(pin.claimId, pin.generation);
    if (gate === null) return fail("unavailable", "The inbox cannot confirm acknowledgements.");
    if (gate.kind === "blocked") {
      return fail("unacked_decision", "An inbox item affecting a claim is not acknowledged.");
    }
  }
  if (acceptance !== null && current.get(acceptance.decisionId) !== acceptance.version) {
    return superseded("The decision this acceptance check proves is no longer current.");
  }
  return ok([...current].map(([decisionId, version]) => ({ decisionId, version })));
}

/** Refuses an attempt whose pins cannot be one merge: none, too many, or one claim twice. */
function checkPins(pins: readonly ClaimPin[]): PortFailure | null {
  if (pins.length === 0) return mismatch("The attempt composes no pins.");
  if (pins.length > MAX_LIST_LENGTH) {
    return mismatch(`The attempt composes more than ${MAX_LIST_LENGTH} pins.`);
  }
  if (new Set(pins.map((pin) => pin.claimId)).size !== pins.length) {
    return mismatch("The attempt composes one claim twice.");
  }
  return null;
}

function mismatch(message: string): PortFailure {
  return fail("check_mismatch", message);
}

function superseded(message: string): PortFailure {
  return fail("decision_superseded", message);
}

interface IntentRow extends Record<string, SqlStorageValue> {
  intent_id: string;
  check_attempt_id: string;
  expected_main: string;
  candidate: string;
  pins: string;
  decisions: string;
  status: string;
  attempts: number;
  main: string | null;
  authorized_at: number;
  updated_at: number;
}

function readIntent(
  storage: RepoStorage,
  column: "intent_id" | "check_attempt_id",
  id: string,
): MergeIntentRecord | null {
  const row = storage.sql
    .exec<IntentRow>(`SELECT * FROM merge_intents WHERE ${column} = ?`, id)
    .toArray()[0];
  return row === undefined ? null : toRecord(row);
}

/**
 * Reads one stored row. Rows are written only by `authorize` and `recordWrite`, so a row is trusted
 * as the record it was written as; these checks catch a row this code cannot read rather than
 * validate input.
 */
function toRecord(row: IntentRow): MergeIntentRecord {
  return {
    intentId: row.intent_id,
    expectedMain: row.expected_main,
    candidate: row.candidate,
    pins: parsePins(row.pins),
    decisions: parseDecisions(row.decisions),
    checkAttemptId: row.check_attempt_id,
    status: parseStatus(row.status),
    attempts: row.attempts,
    main: row.main,
    authorizedAt: row.authorized_at,
    updatedAt: row.updated_at,
  };
}

function parsePins(text: string): EpisodePin[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw corrupt("pins");
  return value.map((item: unknown) => {
    if (
      !isObject(item) ||
      typeof item.claimId !== "string" ||
      !isId("claim", item.claimId) ||
      typeof item.generation !== "number" ||
      typeof item.commit !== "string" ||
      !isCommitSha(item.commit) ||
      (item.episode !== undefined && typeof item.episode !== "number")
    ) {
      throw corrupt("pins");
    }
    // An intent authorized before pins carried their episode has none. Episodes start at 1, so 0
    // matches no claim and the fence refuses to publish it.
    const episode = typeof item.episode === "number" ? item.episode : 0;
    return { claimId: item.claimId, generation: item.generation, commit: item.commit, episode };
  });
}

function parseDecisions(text: string): DecisionRef[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw corrupt("decisions");
  return value.map((item: unknown) => {
    if (
      !isObject(item) ||
      typeof item.decisionId !== "string" ||
      !isId("decision", item.decisionId) ||
      typeof item.version !== "number"
    ) {
      throw corrupt("decisions");
    }
    return { decisionId: item.decisionId, version: item.version };
  });
}

function parseStatus(text: string): MergeIntentStatus {
  switch (text) {
    case "authorized":
    case "updated":
    case "rejected":
    case "reconciled":
      return text;
    default:
      throw corrupt("status");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function corrupt(field: string): Error {
  return new Error(`a stored merge intent has an unreadable ${field}`);
}

function randomIntentId(): IntentId {
  return `int_${crypto.randomUUID().replaceAll("-", "")}`;
}

function unreachable(value: never): never {
  throw new Error(`unhandled check result: ${String(value)}`);
}
