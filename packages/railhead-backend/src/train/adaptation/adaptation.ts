// Adaptation: whether landed work follows the current version of a decision.
//
// "Adapted" is never the agent's word. A claim is adapted to a decision only when all of these hold
// for one merge intent that landed it:
//
// - the intent landed: main moved to exactly its candidate (`updated`, or `reconciled` with main at
//   the candidate);
// - the check attempt the intent rests on passed on exactly that candidate, which is the landed
//   commit, so the check ran on the landed tree;
// - the attempt's trusted definition is an acceptance check for the decision;
// - the version it proves is the decision's current version, and the option it proves is the one
//   that version chose;
// - the claim depended on that version when it landed.
//
// The train calls `owe` inside the transaction that marks a batch landed, so the landing and its
// pending adaptation commit together: if `owe` throws, the landing rolls back and the train lands it
// again. `owe` also snapshots, in the same row, the decision versions and options each landed claim
// depends on, while the claims are still held. It then calls `recordLanding`, which settles the
// landing in its own nested transaction, so a refusal or a throw rolls back only the settlement and
// leaves the landing pending. A pending
// landing (its settlement threw, a reader reported unknown, or the intent has not settled) is
// retried with a doubling backoff by the Repo's alarm through `resume`, and by later landings, up
// to `MAX_SETTLE_TRIES` times. A landing that settled stays settled; `adapted` re-checks the decision's
// current version and option every time it is read, so a later supersession removes the adaptation
// without rewriting it.
//
// The decisions module answers a claim's requirements only while the claim is held, so a merged or
// expired claim's requirements cannot be read again later. Settlement therefore reads a landed
// claim's dependencies only from the snapshot `owe` took, never from the decisions module.
//
// No event is appended: the board derives the same verdict from `train.intent`, `train.check` and
// `train.main`. Nothing here reads repository content.

import {
  isId,
  type ClaimId,
  type CommitSha,
  type DecisionId,
  type DecisionRef,
  type IntentId,
} from "@railhead/shared/events";
import type { ClaimPin } from "../../contracts/claims";
import type { AttemptOutcome, MergeIntentRecord } from "../../contracts/train";
import { atomically, migrate, type RepoStorage } from "../../repo/storage";

/** The migration owner name of the adaptation tables. */
export const ADAPTATION_OWNER = "adaptation";

/** Most pending landings one `recordLanding` call settles, its own included. */
export const MAX_SETTLE_PER_CALL = 8;

/** How many times a pending landing is read before it is settled as `unknown`. */
export const MAX_SETTLE_TRIES = 16;

/** The delay before a pending landing is retried after its first try. Each try doubles it. */
export const RETRY_BASE_MS = 1_000;

/** The longest delay before a pending landing is retried. */
export const RETRY_MAX_MS = 5 * 60_000;

/** Released schema steps. Append a step to change the schema; never edit one. */
const MIGRATIONS: readonly string[] = [
  // One row per landed intent. `outcome` is `NULL` while the landing is pending, and `next_at` is
  // when a pending landing is next due. `claims` is the JSON snapshot of the claims the intent
  // merged and, for each, the decision versions and options it depended on when it landed, or
  // `null` when they could not be read; such a claim never adapts from this landing.
  `CREATE TABLE adaptation_landings (
    intent_id TEXT PRIMARY KEY,
    claims TEXT NOT NULL,
    outcome TEXT,
    tries INTEGER NOT NULL CHECK (tries >= 0),
    next_at INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  "CREATE INDEX adaptation_landings_pending ON adaptation_landings (next_at) WHERE outcome IS NULL",
  // One row per claim and decision version proven on a landed commit.
  `CREATE TABLE adaptations (
    claim_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    option TEXT NOT NULL,
    intent_id TEXT NOT NULL,
    candidate TEXT NOT NULL,
    check_attempt_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (claim_id, decision_id, version)
  ) STRICT`,
];

/** How a landing settled. */
export type LandingOutcome =
  /** Its acceptance check proved the current version and option; its dependent claims adapted. */
  | "adapted"
  /** Main did not move to the intent's candidate. */
  | "not_landed"
  /** The check the intent rests on is not an acceptance check. */
  | "no_acceptance"
  /** That check did not pass: it failed, or could not run. */
  | "check_not_passed"
  /** The check's attempt or report names another commit than the landed one. */
  | "wrong_candidate"
  /** The acceptance check proves a version that is no longer current. */
  | "obsolete_version"
  /** The acceptance check proves another option than the current version chose. */
  | "wrong_option"
  /** No claim of the landing depended on the proven version. */
  | "no_dependent_claim"
  /** Its facts could not be read after `MAX_SETTLE_TRIES` tries. */
  | "unknown";

const OUTCOMES: ReadonlySet<string> = new Set<LandingOutcome>([
  "adapted",
  "not_landed",
  "no_acceptance",
  "check_not_passed",
  "wrong_candidate",
  "obsolete_version",
  "wrong_option",
  "no_dependent_claim",
  "unknown",
]);

/** A decision version a claim depended on when it landed, and the option that version chose. */
export interface LandedDependency {
  /** The decision. */
  decisionId: DecisionId;
  /** The version the claim depended on. */
  version: number;
  /** The key of the option that version chose. */
  option: string;
}

/** One claim a landing merged. */
export interface LandedClaim {
  /** The claim. */
  claimId: ClaimId;
  /** What it depended on when it landed, or `null` when that was unknown. */
  decisions: LandedDependency[] | null;
}

/** What the adaptation module recorded about one landing. */
export interface LandingRecord {
  /** The merge intent. */
  intentId: IntentId;
  /** How it settled, or `null` while pending. */
  outcome: LandingOutcome | null;
  /** The claims it merged and what each depended on, snapshotted when the landing was owed. */
  claims: LandedClaim[];
  /** How many times it was read without settling. */
  tries: number;
}

/**
 * Adaptation of landed work to the current version of a decision.
 *
 * Every method is synchronous and touches only the Repo's storage. Call each inside the caller's
 * transaction when its answer decides a write.
 */
export interface AdaptationPort {
  /**
   * Records, inside the caller's transaction, that the intent landed `pins` and its adaptation is
   * owed, snapshots what each pinned claim depends on, and asks the Repo's alarm to settle it. Call
   * it while the claims are still held. A repeat records nothing more. Throws on an id that is not
   * an intent, or when a reader throws, so the caller's landing rolls back rather than landing
   * without it.
   */
  owe(intentId: IntentId, pins: readonly ClaimPin[]): void;
  /**
   * Owes the landing of the intent's pins as `owe` does unless it was owed already, then settles
   * it, together with up to `MAX_SETTLE_PER_CALL - 1` other pending landings that are due, least
   * recently due first. Returns the intent's record, or `null` for an id that is not an intent or
   * an intent neither owed nor recorded. A settlement that throws rolls back alone and stays
   * pending.
   */
  recordLanding(intentId: IntentId): LandingRecord | null;
  /**
   * Whether the claim's landed work is adapted to the decision's current version and option, or
   * `null` when the claim or decision id is invalid or the decision's current version is unknown.
   */
  adapted(claimId: ClaimId, decisionId: DecisionId): boolean | null;
  /** What was recorded about the intent's landing, or `null` when nothing was. */
  landing(intentId: IntentId): LandingRecord | null;
  /**
   * Called by the Repo's alarm. Settles up to `MAX_SETTLE_PER_CALL` pending landings that are due
   * and asks for the next wake while any stay pending. A throwing settlement stays pending.
   */
  resume(): Promise<void>;
}

/** The fence readers adaptation reads, each inside the transaction it settles in. */
export interface AdaptationReaders {
  /** The stored merge intent, or `null` when unknown. */
  intent(intentId: IntentId): MergeIntentRecord | null;
  /** The persisted check attempt and its report, or `null` when unknown. */
  attemptOutcome(attemptId: string): AttemptOutcome | null;
  /**
   * The decision versions the claim must satisfy now, or `null` when unknown. Read only when a
   * landing is owed: a merged claim reads as unknown.
   */
  currentVersions(claimId: ClaimId): DecisionRef[] | null;
  /** The decision's current version and chosen option, or `null` when unknown. */
  currentDecision(decisionId: DecisionId): { version: number; option: string } | null;
}

/** What the adaptation module needs. */
export interface AdaptationDeps {
  /** The Repo's storage; only the adaptation tables are written. */
  storage: RepoStorage;
  /** The other modules' readers. Called only while a request is handled. */
  readers: () => AdaptationReaders;
  /** The current time. */
  clock: () => number;
  /** Asks the Repo's alarm to run no later than `at`. */
  wake: (at: number) => void;
}

interface LandingRow extends Record<string, SqlStorageValue> {
  intent_id: string;
  claims: string;
  outcome: string | null;
  tries: number;
}

interface AdaptationRow extends Record<string, SqlStorageValue> {
  version: number;
  option: string;
}

/** A settlement that cannot be decided yet. */
const PENDING = null;

/** An `owe` call refused. It throws inside the caller's transaction, which rolls back. */
export class AdaptationWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdaptationWriteError";
  }
}

/** Builds the adaptation module, creating or migrating its tables first. */
export function createAdaptation(deps: AdaptationDeps): AdaptationPort {
  const { storage, readers, clock, wake } = deps;
  migrate(storage, ADAPTATION_OWNER, MIGRATIONS);
  const sql = storage.sql;

  function landingRow(intentId: IntentId): LandingRow | undefined {
    return sql
      .exec<LandingRow>(
        "SELECT intent_id, claims, outcome, tries FROM adaptation_landings WHERE intent_id = ?",
        intentId,
      )
      .toArray()[0];
  }

  function record(intentId: IntentId): LandingRecord | null {
    const row = landingRow(intentId);
    if (row === undefined) return null;
    return {
      intentId,
      outcome: row.outcome === null ? null : readOutcome(row.outcome),
      claims: readClaims(row.claims),
      tries: row.tries,
    };
  }

  // What each pinned claim depends on now. Called only while the landing is owed.
  function snapshot(pins: readonly ClaimPin[]): LandedClaim[] {
    return pins.map((pin) => ({
      claimId: pin.claimId,
      decisions: dependenciesOf(pin.claimId),
    }));
  }

  // The claim's current decision versions with the option each chose, or `null` when unknown.
  function dependenciesOf(claimId: ClaimId): LandedDependency[] | null {
    const refs = readers().currentVersions(claimId);
    if (refs === null) return null;
    const dependencies: LandedDependency[] = [];
    for (const { decisionId, version } of refs) {
      const current = readers().currentDecision(decisionId);
      if (current === null || current.version !== version) return null;
      dependencies.push({ decisionId, version, option: current.option });
    }
    return dependencies;
  }

  // Records the landing of `pins` as owed and due now with its snapshot, once.
  function insertOwed(intentId: IntentId, pins: readonly ClaimPin[]): void {
    const claims = JSON.stringify(snapshot(pins));
    const now = clock();
    sql.exec(
      `INSERT INTO adaptation_landings
         (intent_id, claims, outcome, tries, next_at, recorded_at, updated_at)
       VALUES (?, ?, NULL, 0, ?, ?, ?)`,
      intentId,
      claims,
      now,
      now,
      now,
    );
  }

  // Decides a landing from its snapshot, writing its adaptations. `PENDING` writes nothing.
  function decide(intentId: IntentId, claims: LandedClaim[]): LandingOutcome | typeof PENDING {
    const intent = readers().intent(intentId);
    if (intent === null || intent.intentId !== intentId) return PENDING;
    const landed = landedCommit(intent);
    if (landed === PENDING) return PENDING;
    if (landed === "not_landed") return "not_landed";

    const outcome = readers().attemptOutcome(intent.checkAttemptId);
    if (outcome === null) return PENDING;
    const { attempt, report } = outcome;
    if (attempt.attemptId !== intent.checkAttemptId || attempt.candidate !== landed) {
      return "wrong_candidate";
    }
    const acceptance = attempt.definition.acceptance;
    if (acceptance === null) return "no_acceptance";
    if (report === null || report.result !== "pass") return "check_not_passed";
    if (report.attemptId !== attempt.attemptId || report.candidate !== landed) {
      return "wrong_candidate";
    }
    const { decisionId, version } = acceptance.decision;
    const current = readers().currentDecision(decisionId);
    if (current === null) return PENDING;
    if (current.version !== version) return "obsolete_version";
    if (current.option !== acceptance.option) return "wrong_option";

    const dependent = claims.filter(
      (claim) =>
        claim.decisions?.some(
          (dependency) =>
            dependency.decisionId === decisionId &&
            dependency.version === version &&
            dependency.option === acceptance.option,
        ) === true,
    );
    if (dependent.length === 0) return "no_dependent_claim";
    const now = clock();
    for (const claim of dependent) {
      sql.exec(
        `INSERT OR IGNORE INTO adaptations
           (claim_id, decision_id, version, option, intent_id, candidate, check_attempt_id,
            recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        claim.claimId,
        decisionId,
        version,
        acceptance.option,
        intentId,
        landed,
        attempt.attemptId,
        now,
      );
    }
    return "adapted";
  }

  // Pending landings that are due, least recently due first, besides `except`.
  function due(limit: number, except: IntentId | null): IntentId[] {
    return sql
      .exec<{ intent_id: string }>(
        `SELECT intent_id FROM adaptation_landings
         WHERE outcome IS NULL AND next_at <= ? AND intent_id != ?
         ORDER BY next_at, intent_id LIMIT ?`,
        clock(),
        except ?? "",
        limit,
      )
      .toArray()
      .map((row) => row.intent_id);
  }

  // Asks the alarm for the earliest pending landing, if any. Call it as a transaction's last write.
  function requestWake(): void {
    const row = sql
      .exec<{ next: number | null }>(
        "SELECT MIN(next_at) AS next FROM adaptation_landings WHERE outcome IS NULL",
      )
      .toArray()[0];
    if (row?.next !== null && row?.next !== undefined) wake(row.next);
  }

  // Settles one pending landing in its own nested transaction. A throw rolls back what it wrote and
  // counts a try, like an unknown reader.
  function settle(intentId: IntentId): void {
    let outcome: LandingOutcome | typeof PENDING;
    try {
      outcome = atomically(storage, () => {
        const row = landingRow(intentId);
        if (row === undefined) return PENDING;
        const decided = decide(intentId, readClaims(row.claims));
        if (decided !== PENDING) {
          sql.exec(
            "UPDATE adaptation_landings SET outcome = ?, updated_at = ? WHERE intent_id = ?",
            decided,
            clock(),
            intentId,
          );
        }
        return decided;
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "adaptation.settle_failed",
          intent: intentId,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
      outcome = PENDING;
    }
    if (outcome !== PENDING) return;
    const tries = (landingRow(intentId)?.tries ?? 0) + 1;
    const now = clock();
    sql.exec(
      `UPDATE adaptation_landings
       SET tries = ?, next_at = ?, updated_at = ?,
           outcome = CASE WHEN ? >= ? THEN 'unknown' ELSE NULL END
       WHERE intent_id = ?`,
      tries,
      now + retryDelay(tries),
      now,
      tries,
      MAX_SETTLE_TRIES,
      intentId,
    );
  }

  return {
    owe(intentId, pins) {
      if (!isId("intent", intentId)) {
        throw new AdaptationWriteError("the landing does not name an intent");
      }
      if (landingRow(intentId) === undefined) insertOwed(intentId, pins);
      requestWake();
    },

    recordLanding(intentId) {
      if (!isId("intent", intentId)) return null;
      return atomically(storage, () => {
        if (landingRow(intentId) === undefined) {
          const intent = readers().intent(intentId);
          if (intent === null || intent.intentId !== intentId) return null;
          insertOwed(intentId, intent.pins);
        }
        const others = due(MAX_SETTLE_PER_CALL - 1, intentId);
        if (landingRow(intentId)?.outcome === null) settle(intentId);
        for (const other of others) settle(other);
        requestWake();
        return record(intentId);
      });
    },

    async resume() {
      atomically(storage, () => {
        for (const intentId of due(MAX_SETTLE_PER_CALL, null)) settle(intentId);
        requestWake();
      });
    },

    adapted(claimId, decisionId) {
      if (!isId("claim", claimId) || !isId("decision", decisionId)) return null;
      const current = readers().currentDecision(decisionId);
      if (current === null) return null;
      const row = sql
        .exec<AdaptationRow>(
          `SELECT version, option FROM adaptations
           WHERE claim_id = ? AND decision_id = ? AND version = ?`,
          claimId,
          decisionId,
          current.version,
        )
        .toArray()[0];
      return row !== undefined && row.option === current.option;
    },

    landing(intentId) {
      if (!isId("intent", intentId)) return null;
      return record(intentId);
    },
  };
}

// The commit an intent landed, `"not_landed"` when main settled elsewhere, or `PENDING` while the
// write has not settled.
function landedCommit(intent: MergeIntentRecord): CommitSha | "not_landed" | typeof PENDING {
  switch (intent.status) {
    case "authorized":
      return PENDING;
    case "updated":
    case "reconciled":
      return intent.main === intent.candidate ? intent.candidate : "not_landed";
    case "rejected":
      return "not_landed";
    default:
      return unreachable(intent.status);
  }
}

/** How long a landing waits after its `tries`-th unsettled try. */
function retryDelay(tries: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(tries - 1, 20));
}

function readOutcome(value: string): LandingOutcome {
  if (!isOutcome(value)) throw new Error("a stored landing outcome is not known");
  return value;
}

function isOutcome(value: string): value is LandingOutcome {
  return OUTCOMES.has(value);
}

function readClaims(json: string): LandedClaim[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error("a stored landing snapshot is not a list");
  return value.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("claimId" in item) ||
      !("decisions" in item) ||
      typeof item.claimId !== "string"
    ) {
      throw new Error("a stored landed claim is not a claim");
    }
    const { decisions } = item;
    if (decisions === null) return { claimId: item.claimId, decisions: null };
    if (!Array.isArray(decisions)) throw new Error("a stored landed claim has no decision list");
    return { claimId: item.claimId, decisions: decisions.map(readDependency) };
  });
}

function readDependency(item: unknown): LandedDependency {
  if (
    typeof item !== "object" ||
    item === null ||
    !("decisionId" in item) ||
    !("version" in item) ||
    !("option" in item) ||
    typeof item.decisionId !== "string" ||
    typeof item.version !== "number" ||
    typeof item.option !== "string"
  ) {
    throw new Error("a stored landed decision is not a decision version");
  }
  return { decisionId: item.decisionId, version: item.version, option: item.option };
}

function unreachable(value: never): never {
  throw new Error(`unhandled merge intent status: ${JSON.stringify(value)}`);
}
