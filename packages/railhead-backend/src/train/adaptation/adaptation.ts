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
// The train calls `recordLanding` inside the transaction that marks a batch landed. Each landing is
// settled in its own nested transaction, so a refusal or a throw rolls back only the adaptation,
// never the landing. A landing whose facts cannot be read yet (a reader reports unknown, or the
// intent has not settled) stays pending and is settled again at the next `recordLanding`, up to
// `MAX_SETTLE_TRIES` times. A landing that settled stays settled; `adapted` re-checks the decision's
// current version and option every time it is read, so a later supersession removes the adaptation
// without rewriting it.
//
// The decisions module answers a claim's requirements only while the claim is held, so a merged
// claim's requirements cannot be read again later. The claims of a landing and the decision versions
// each one depended on are captured when the landing is first read and kept.
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
import type { AttemptOutcome, MergeIntentRecord } from "../../contracts/train";
import { atomically, migrate, type RepoStorage } from "../../repo/storage";

/** The migration owner name of the adaptation tables. */
export const ADAPTATION_OWNER = "adaptation";

/** Most pending landings one `recordLanding` call settles, its own included. */
export const MAX_SETTLE_PER_CALL = 8;

/** How many times a pending landing is read before it is settled as `unknown`. */
export const MAX_SETTLE_TRIES = 16;

/** Released schema steps. Append a step to change the schema; never edit one. */
const MIGRATIONS: readonly string[] = [
  // One row per landed intent. `outcome` is `NULL` while the landing is pending.
  `CREATE TABLE adaptation_landings (
    intent_id TEXT PRIMARY KEY,
    outcome TEXT,
    tries INTEGER NOT NULL CHECK (tries >= 0),
    recorded_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  "CREATE INDEX adaptation_landings_pending ON adaptation_landings (updated_at) WHERE outcome IS NULL",
  // The claims a landing merged, and the decision versions each depended on when it landed, as JSON.
  // `decisions` is `NULL` when they could not be read; such a claim never adapts from this landing.
  `CREATE TABLE adaptation_claims (
    intent_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    decisions TEXT,
    PRIMARY KEY (intent_id, claim_id)
  ) STRICT`,
  "CREATE INDEX adaptation_claims_claim ON adaptation_claims (claim_id)",
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

/** One claim a landing merged. */
export interface LandedClaim {
  /** The claim. */
  claimId: ClaimId;
  /** The decision versions it depended on when it landed, or `null` when they were unknown. */
  decisions: DecisionRef[] | null;
}

/** What the adaptation module recorded about one landing. */
export interface LandingRecord {
  /** The merge intent. */
  intentId: IntentId;
  /** How it settled, or `null` while pending. */
  outcome: LandingOutcome | null;
  /** The claims it merged, once its intent was read; empty before. */
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
   * Records that the intent landed and settles it, together with up to `MAX_SETTLE_PER_CALL - 1`
   * other pending landings, oldest attempt first. Returns the intent's record, or `null` for an
   * id that is not an intent. A settlement that throws rolls back alone and stays pending.
   */
  recordLanding(intentId: IntentId): LandingRecord | null;
  /**
   * Whether the claim's landed work is adapted to the decision's current version and option, or
   * `null` when the claim or decision id is invalid or the decision's current version is unknown.
   */
  adapted(claimId: ClaimId, decisionId: DecisionId): boolean | null;
  /** What was recorded about the intent's landing, or `null` when nothing was. */
  landing(intentId: IntentId): LandingRecord | null;
}

/** The fence readers adaptation reads, each inside the transaction it settles in. */
export interface AdaptationReaders {
  /** The stored merge intent, or `null` when unknown. */
  intent(intentId: IntentId): MergeIntentRecord | null;
  /** The persisted check attempt and its report, or `null` when unknown. */
  attemptOutcome(attemptId: string): AttemptOutcome | null;
  /** The decision versions the claim must satisfy now, or `null` when unknown. */
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
}

interface LandingRow extends Record<string, SqlStorageValue> {
  intent_id: string;
  outcome: string | null;
  tries: number;
}

interface ClaimRow extends Record<string, SqlStorageValue> {
  claim_id: string;
  decisions: string | null;
}

interface AdaptationRow extends Record<string, SqlStorageValue> {
  version: number;
  option: string;
}

/** A settlement that cannot be decided yet. */
const PENDING = null;

/** Builds the adaptation module, creating or migrating its tables first. */
export function createAdaptation(deps: AdaptationDeps): AdaptationPort {
  const { storage, readers, clock } = deps;
  migrate(storage, ADAPTATION_OWNER, MIGRATIONS);
  const sql = storage.sql;

  function landingRow(intentId: IntentId): LandingRow | undefined {
    return sql
      .exec<LandingRow>(
        "SELECT intent_id, outcome, tries FROM adaptation_landings WHERE intent_id = ?",
        intentId,
      )
      .toArray()[0];
  }

  function claimsOf(intentId: IntentId): LandedClaim[] {
    return sql
      .exec<ClaimRow>(
        "SELECT claim_id, decisions FROM adaptation_claims WHERE intent_id = ? ORDER BY rowid",
        intentId,
      )
      .toArray()
      .map((row) => ({
        claimId: row.claim_id,
        decisions: row.decisions === null ? null : readRefs(row.decisions),
      }));
  }

  function record(intentId: IntentId): LandingRecord | null {
    const row = landingRow(intentId);
    if (row === undefined) return null;
    return {
      intentId,
      outcome: row.outcome === null ? null : readOutcome(row.outcome),
      claims: claimsOf(intentId),
      tries: row.tries,
    };
  }

  // Captures the claims an intent merged and what each depended on, once.
  function capture(intent: MergeIntentRecord): void {
    const captured = sql
      .exec("SELECT 1 FROM adaptation_claims WHERE intent_id = ? LIMIT 1", intent.intentId)
      .toArray();
    if (captured.length > 0) return;
    for (const pin of intent.pins) {
      const refs = readers().currentVersions(pin.claimId);
      sql.exec(
        "INSERT INTO adaptation_claims (intent_id, claim_id, decisions) VALUES (?, ?, ?)",
        intent.intentId,
        pin.claimId,
        refs === null ? null : JSON.stringify(refs),
      );
    }
  }

  // Decides a landing, writing its claims and adaptations. `PENDING` writes only the capture.
  function decide(intentId: IntentId): LandingOutcome | typeof PENDING {
    const intent = readers().intent(intentId);
    if (intent === null || intent.intentId !== intentId) return PENDING;
    const landed = landedCommit(intent);
    if (landed === PENDING) return PENDING;
    if (landed === "not_landed") return "not_landed";
    capture(intent);

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

    const dependent = claimsOf(intentId).filter(
      (claim) =>
        claim.decisions?.some((ref) => ref.decisionId === decisionId && ref.version === version) ===
        true,
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

  // Settles one pending landing in its own nested transaction. A throw rolls back what it wrote and
  // counts a try, like an unknown reader.
  function settle(intentId: IntentId): void {
    let outcome: LandingOutcome | typeof PENDING;
    try {
      outcome = atomically(storage, () => {
        const decided = decide(intentId);
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
    sql.exec(
      `UPDATE adaptation_landings
       SET tries = tries + 1, updated_at = ?,
           outcome = CASE WHEN tries + 1 >= ? THEN 'unknown' ELSE NULL END
       WHERE intent_id = ?`,
      clock(),
      MAX_SETTLE_TRIES,
      intentId,
    );
  }

  return {
    recordLanding(intentId) {
      if (!isId("intent", intentId)) return null;
      return atomically(storage, () => {
        const now = clock();
        sql.exec(
          `INSERT OR IGNORE INTO adaptation_landings (intent_id, outcome, tries, recorded_at,
             updated_at)
           VALUES (?, NULL, 0, ?, ?)`,
          intentId,
          now,
          now,
        );
        const others = sql
          .exec<{ intent_id: string }>(
            `SELECT intent_id FROM adaptation_landings
             WHERE outcome IS NULL AND intent_id != ?
             ORDER BY updated_at, intent_id LIMIT ?`,
            intentId,
            MAX_SETTLE_PER_CALL - 1,
          )
          .toArray()
          .map((row) => row.intent_id);
        if (landingRow(intentId)?.outcome === null) settle(intentId);
        for (const other of others) settle(other);
        return record(intentId);
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

function readOutcome(value: string): LandingOutcome {
  if (!isOutcome(value)) throw new Error("a stored landing outcome is not known");
  return value;
}

function isOutcome(value: string): value is LandingOutcome {
  return OUTCOMES.has(value);
}

function readRefs(json: string): DecisionRef[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error("stored landed decisions are not a list");
  return value.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("decisionId" in item) ||
      !("version" in item) ||
      typeof item.decisionId !== "string" ||
      typeof item.version !== "number"
    ) {
      throw new Error("a stored landed decision is not a decision version");
    }
    return { decisionId: item.decisionId, version: item.version };
  });
}

function unreachable(value: never): never {
  throw new Error(`unhandled merge intent status: ${JSON.stringify(value)}`);
}
