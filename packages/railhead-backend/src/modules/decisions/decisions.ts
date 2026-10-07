// Questions and versioned decisions. An agent asks a question about the claim it holds; the owner
// answers it with a passkey proof bound to that answer, which records version 1 of the question's
// decision. Each step is one transaction:
//
// - `ask` records the question, the decision it will open and the asking claim as the decision's
//   first dependency, and appends `question.asked` with the agent as actor. A repeat with the same
//   `requestId` returns the same question and appends nothing. The claim's generation is read again
//   inside the transaction, so a claim released or taken over while it was being read records
//   nothing.
// - `record` takes a consumed human grant and records the next version: version 1 answers the
//   question, and a later one supersedes the current version. It appends `decision.recorded` with
//   the person as actor and records one obligation for each dependent claim, in the same
//   transaction. If any item cannot be queued, nothing is recorded and nothing is queued. A repeat
//   of the same grant returns the version it recorded; a stale `expectedVersion` records nothing,
//   so a person who answered against an older version never overwrites a newer one.
//
// - `askSystem` records a question a system module raises on its own authority, such as the train
//   when two claims conflict, inside the caller's transaction. Its asker is stored in place of an
//   agent, so no agent can read it with `question`, and every claim it names is a dependency of its
//   decision, so the answer reaches each holder and supersedes each ready pin. Recording a version
//   of a system question calls the train's `answered` in the same transaction, then awaits the
//   train's wake once it commits.
// - `withdraw` is called by the asker, inside its own transaction, when the work an open system
//   question asked about was replaced. The question keeps its row but loses its dependencies, and
//   `record` refuses any answer to it, so no version supersedes the replaced work.
//
// A decision's dependencies name the claim, and the agent and ownership generation an inbox item
// goes to. An obligation is queued as an item only when the claims module reports that generation
// as current, inside the transaction that records it. A merged claim keeps its holder, which gets
// the item, and `record` asks the claims module to reopen the merged work the version superseded. A
// dependency whose claim expired, is unknown or has moved to an owner it was not transferred to
// keeps a pending obligation and gets no item, so nothing reaches a former owner:
//
// - `transfer`, called inside a takeover's transaction, moves the claim's dependencies to the new
//   holder and queues it the current version of each decision, delivering what was pending.
// - `relied`, called inside the train's transaction that lands the claim's work, records the
//   versions that work relied on. A version recorded later, or one already newer, makes the
//   obligation `rework`: the work cannot follow it any more, so it must be redone. The rework goes
//   to whoever holds the claim's dependency now, which after a takeover is the successor, even when
//   the work was done under an earlier generation.
//
// One obligation exists per claim, version and kind, so a repeated or restarted fanout never
// queues an item twice, and a failed one leaves none.
//
// Question text and option labels are untrusted. They are stored and returned as bounded data,
// never logged.

import {
  MAX_LONG_POLL_MS,
  MAX_SCOPE_BYTES,
  isScopePath,
  isRequestId,
  scopeBytes,
  type AskRequest,
  type DecisionView,
  type QuestionResult,
} from "@railhead/shared/agent-api";
import {
  isId,
  MAX_LIST_LENGTH,
  MAX_OPTIONS,
  MAX_OPTION_LABEL_LENGTH,
  MAX_QUESTION_LENGTH,
  MIN_OPTIONS,
  type ClaimId,
  type DecisionId,
  type DecisionRef,
  type QuestionId,
  type QuestionOption,
} from "@railhead/shared/events";
import {
  MAX_SYSTEM_QUESTION_KEY_LENGTH,
  type DecisionObligation,
  type DecisionsPort,
  type SystemQuestion,
} from "../../contracts/decisions";
import type { InboxTarget } from "../../contracts/inbox";
import type { AgentPrincipal, GrantFor } from "../../contracts/principals";
import { fail, ok, unavailable, type PortResult } from "../../contracts/result";
import { UnavailableError } from "../../contracts/unavailable";
import type { RepoContext, RepoPorts } from "../../repo/composeRepo";
import type { EventTransaction } from "../../repo/eventLog";
import { migrate } from "../../repo/storage";

/** The migration owner name of the decisions' tables. */
const DECISIONS_OWNER = "decisions";

/** Released schema steps of the decisions. Append a step to change the schema; never edit one. */
const MIGRATIONS: readonly string[] = [
  // One question opens one decision. `request_id` is the asking agent's idempotency key.
  `CREATE TABLE questions (
    question_id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    text TEXT NOT NULL,
    options TEXT NOT NULL,
    scope TEXT NOT NULL,
    asked_at INTEGER NOT NULL,
    UNIQUE (agent_id, request_id)
  ) STRICT`,
  "CREATE INDEX questions_claim ON questions (claim_id)",
  // Every recorded version. `grant_id` is the consumed passkey proof that recorded it, so one proof
  // records at most one version.
  `CREATE TABLE decision_versions (
    decision_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    option TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    decided_at INTEGER NOT NULL,
    grant_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (decision_id, version)
  ) STRICT`,
  // The claims whose work depends on a decision, and whose inbox a new version goes to.
  `CREATE TABLE decision_claims (
    decision_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    PRIMARY KEY (decision_id, claim_id)
  ) STRICT`,
  "CREATE INDEX decision_claims_claim ON decision_claims (claim_id)",
  // The newest version the claim's merged work relied on, or `NULL` before any.
  "ALTER TABLE decision_claims ADD COLUMN relied INTEGER CHECK (relied IS NULL OR relied > 0)",
  // What each version asks of each dependent claim. `agent_id` and `item` name its latest delivery,
  // since item numbers are per agent, or are both `NULL` while no current holder could receive it.
  `CREATE TABLE decision_obligations (
    claim_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'rework')),
    agent_id TEXT,
    item INTEGER CHECK (item IS NULL OR item > 0),
    recorded_at INTEGER NOT NULL,
    CHECK ((agent_id IS NULL) = (item IS NULL)),
    PRIMARY KEY (claim_id, decision_id, version, kind)
  ) STRICT`,
  // When the asker withdrew a system question before any answer, or `NULL`. A withdrawn question
  // takes no answer, and its decision has no dependencies.
  "ALTER TABLE questions ADD COLUMN withdrawn_at INTEGER",
];

/**
 * Most questions one claim may ask. Each answered one is a requirement of the claim, and
 * `claim.ready` lists at most `MAX_LIST_LENGTH` of them.
 */
export const MAX_QUESTIONS_PER_CLAIM = MAX_LIST_LENGTH;

/** Most long polls the module holds open at once; beyond it, `question` answers at once. */
export const MAX_WAITERS = 256;

/** Longest option key a question may offer, as the event log's option key format allows. */
const OPTION_KEY = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * A system module's actor id. No agent id has this form, so a system question is never an agent's
 * question, whose rows are keyed by the agent that asked.
 */
const SYSTEM_ID = /^sys_[a-z0-9_]{1,32}$/;

interface QuestionRow extends Record<string, SqlStorageValue> {
  question_id: string;
  decision_id: string;
  agent_id: string;
  claim_id: string;
  generation: number;
  text: string;
  options: string;
  scope: string;
}

interface VersionRow extends Record<string, SqlStorageValue> {
  version: number;
  option: string;
  decided_by: string;
  decided_at: number;
}

interface DependencyRow extends Record<string, SqlStorageValue> {
  decision_id: string;
  claim_id: string;
  agent_id: string;
  generation: number;
  relied: number | null;
}

interface ObligationRow extends Record<string, SqlStorageValue> {
  claim_id: string;
  decision_id: string;
  version: number;
  kind: string;
  agent_id: string | null;
  item: number | null;
  recorded_at: number;
}

const SELECT_DEPENDENCY =
  "SELECT decision_id, claim_id, agent_id, generation, relied FROM decision_claims";

/** A `transfer` or `relied` call refused. It throws inside the caller's transaction, which rolls back. */
export class DecisionsWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionsWriteError";
  }
}

/** Builds the decisions of one repository, creating or migrating its tables first. */
export function createDecisions(context: RepoContext, ports: () => RepoPorts): DecisionsPort {
  const { storage, log, clock, repoId } = context;
  migrate(storage, DECISIONS_OWNER, MIGRATIONS);
  const sql = storage.sql;
  const waiters = new Map<DecisionId, Set<() => void>>();
  let waiting = 0;

  function questionOf(questionId: QuestionId): QuestionRow | undefined {
    return sql
      .exec<QuestionRow>(
        `SELECT question_id, decision_id, agent_id, claim_id, generation, text, options, scope
         FROM questions WHERE question_id = ?`,
        questionId,
      )
      .toArray()[0];
  }

  function questionOfDecision(decisionId: DecisionId): QuestionRow | undefined {
    return sql
      .exec<QuestionRow>(
        `SELECT question_id, decision_id, agent_id, claim_id, generation, text, options, scope
         FROM questions WHERE decision_id = ?`,
        decisionId,
      )
      .toArray()[0];
  }

  /** Whether the asker withdrew the question that opened `decisionId`. */
  function withdrawn(decisionId: DecisionId): boolean {
    const row = sql
      .exec<{ withdrawn_at: number | null }>(
        "SELECT withdrawn_at FROM questions WHERE decision_id = ?",
        decisionId,
      )
      .toArray()[0];
    return row !== undefined && row.withdrawn_at !== null;
  }

  function versionOf(decisionId: DecisionId, version: number): VersionRow | undefined {
    return sql
      .exec<VersionRow>(
        `SELECT version, option, decided_by, decided_at FROM decision_versions
         WHERE decision_id = ? AND version = ?`,
        decisionId,
        version,
      )
      .toArray()[0];
  }

  function currentVersion(decisionId: DecisionId): number {
    const row = sql
      .exec<{ current: number | null }>(
        "SELECT MAX(version) AS current FROM decision_versions WHERE decision_id = ?",
        decisionId,
      )
      .toArray()[0];
    return row?.current ?? 0;
  }

  // The decision's current version as an agent reads it, or `null` while the question is open.
  function view(question: QuestionRow): DecisionView | null {
    return viewAt(question, currentVersion(question.decision_id));
  }

  // One recorded version as an agent reads it, or `null` when it was never recorded.
  function viewAt(question: QuestionRow, version: number): DecisionView | null {
    const decisionId = question.decision_id;
    const row = versionOf(decisionId, version);
    if (row === undefined) return null;
    const options = readOptions(question.options);
    const previous = version === 1 ? undefined : versionOf(decisionId, version - 1);
    return {
      decisionId,
      version,
      supersedes: version === 1 ? null : version - 1,
      questionId: question.question_id,
      question: question.text,
      option: optionOf(options, row.option),
      previous: previous === undefined ? null : optionOf(options, previous.option),
      scope: readScope(question.scope),
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
    };
  }

  function result(question: QuestionRow): QuestionResult {
    const decision = view(question);
    return {
      questionId: question.question_id,
      decisionId: question.decision_id,
      state: decision === null ? "open" : "answered",
      decision,
    };
  }

  function foreign(agent: AgentPrincipal): boolean {
    return agent.kind !== "agent" || agent.repoId !== repoId || !isId("agent", agent.agentId);
  }

  // Resolves when `decisionId` records a version or `waitMs` passes, whichever is first.
  function waitFor(decisionId: DecisionId, waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      const set = waiters.get(decisionId) ?? new Set<() => void>();
      const done = (): void => {
        clearTimeout(timer);
        if (set.delete(done)) waiting -= 1;
        if (set.size === 0) waiters.delete(decisionId);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      set.add(done);
      waiters.set(decisionId, set);
      waiting += 1;
    });
  }

  function wake(decisionId: DecisionId): void {
    const set = waiters.get(decisionId);
    if (set === undefined) return;
    // Each waiter removes itself; a Set allows deleting the entry being visited.
    for (const done of set) done();
  }

  // The answer to a repeated `ask`, or `null` when the agent never used this `requestId`.
  function repeated(
    agent: AgentPrincipal,
    claimId: ClaimId,
    request: AskRequest,
  ): PortResult<QuestionResult> | null {
    const row = sql
      .exec<QuestionRow>(
        `SELECT question_id, decision_id, agent_id, claim_id, generation, text, options, scope
         FROM questions WHERE agent_id = ? AND request_id = ?`,
        agent.agentId,
        request.requestId,
      )
      .toArray()[0];
    if (row === undefined) return null;
    if (!sameAsk(row, claimId, request)) {
      return fail("idempotency_mismatch", "That requestId was used for another question.");
    }
    return ok(result(row));
  }

  function dependencies(claimId: ClaimId): DecisionRef[] {
    return sql
      .exec<{ decision_id: string; current: number }>(
        `SELECT d.decision_id AS decision_id, MAX(v.version) AS current
         FROM decision_claims d
         JOIN questions q ON q.decision_id = d.decision_id
         JOIN decision_versions v ON v.decision_id = d.decision_id
         WHERE d.claim_id = ?
         GROUP BY d.decision_id
         ORDER BY MIN(q.asked_at), d.decision_id`,
        claimId,
      )
      .toArray()
      .map((row) => ({ decisionId: row.decision_id, version: row.current }));
  }

  // Records what `ref` asks of the dependency's claim, once per claim, version and kind. It is
  // queued to the dependency's agent when that agent still holds the claim at the dependency's
  // generation. An inbox refusal throws and rolls back.
  function owe(
    tx: EventTransaction,
    dependency: DependencyRow,
    ref: DecisionRef,
    kind: DecisionObligation["kind"],
  ): void {
    const owed = tx.sql
      .exec(
        `SELECT 1 FROM decision_obligations
         WHERE claim_id = ? AND decision_id = ? AND version = ? AND kind = ?`,
        dependency.claim_id,
        ref.decisionId,
        ref.version,
        kind,
      )
      .toArray();
    if (owed.length > 0) return;
    const item =
      ports().claims.currentGeneration(dependency.claim_id) === dependency.generation
        ? ports().inbox.queue(
            tx,
            {
              agentId: dependency.agent_id,
              claimId: dependency.claim_id,
              generation: dependency.generation,
            },
            { entry: { kind, decision: ref }, decision: recordedView(ref) },
          )
        : null;
    tx.sql.exec(
      `INSERT INTO decision_obligations
         (claim_id, decision_id, version, kind, agent_id, item, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      dependency.claim_id,
      ref.decisionId,
      ref.version,
      kind,
      item === null ? null : dependency.agent_id,
      item,
      clock(),
    );
  }

  // A recorded version's view. Every caller names a version it read from storage in the same
  // transaction, so a missing one is a broken invariant.
  function recordedView(ref: DecisionRef): DecisionView {
    const question = questionOfDecision(ref.decisionId);
    const decision = question === undefined ? null : viewAt(question, ref.version);
    if (decision === null) throw new Error("a recorded decision version cannot be read back");
    return decision;
  }

  return {
    async ask(agent, claimId, sent): Promise<PortResult<QuestionResult>> {
      if (foreign(agent)) return notForThisRepo();
      if (!isId("claim", claimId)) {
        return fail("invalid_request", "The claim is not a claim identifier.");
      }
      const invalid = invalidAsk(sent);
      if (invalid !== null) return fail("invalid_request", invalid);
      const request = ownedAsk(sent);

      const repeat = repeated(agent, claimId, request);
      if (repeat !== null) return repeat;

      const active = await ports().claims.activeClaim(agent);
      if (!active.ok) return active;
      const claim = active.value;
      if (claim === null || claim.claimId !== claimId) {
        return fail("claim_closed", "You do not hold that claim.");
      }
      if (request.generation < claim.generation) {
        return fail("stale_generation", "The claim has a newer generation than the one you sent.");
      }
      if (request.generation > claim.generation) {
        return fail("invalid_request", "The generation is ahead of the claim's.");
      }
      if (claim.state !== "working") {
        return fail("claim_closed", "The claim is no longer being worked on.");
      }

      const { agentId } = agent;
      return log.transaction((tx): PortResult<QuestionResult> => {
        // Another call with this key may have recorded it while the claim was being read.
        const raced = repeated(agent, claimId, request);
        if (raced !== null) return raced;
        // The claim read above may have been released or taken over before this transaction began.
        const generation = ports().claims.currentGeneration(claimId);
        if (generation === null) return fail("claim_closed", "You do not hold that claim.");
        if (generation !== request.generation) {
          return fail(
            "stale_generation",
            "The claim has a newer generation than the one you sent.",
          );
        }
        // A system question adds a dependency to every claim it names but stores its question
        // under the first, so the quota counts dependencies, as `askSystem` does.
        const depends = tx.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM decision_claims WHERE claim_id = ?",
            claimId,
          )
          .toArray()[0];
        if ((depends?.n ?? 0) >= MAX_QUESTIONS_PER_CLAIM) {
          return fail(
            "quota_exceeded",
            `A claim may depend on at most ${MAX_QUESTIONS_PER_CLAIM} decisions.`,
          );
        }
        const questionId = newId("qst_");
        const decisionId = newId("dec_");
        tx.sql.exec(
          `INSERT INTO questions (question_id, decision_id, agent_id, request_id, claim_id,
             generation, text, options, scope, asked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          questionId,
          decisionId,
          agentId,
          request.requestId,
          claimId,
          request.generation,
          request.text,
          JSON.stringify(request.options),
          JSON.stringify(request.scope),
          clock(),
        );
        tx.sql.exec(
          `INSERT INTO decision_claims (decision_id, claim_id, agent_id, generation)
           VALUES (?, ?, ?, ?)`,
          decisionId,
          claimId,
          agentId,
          request.generation,
        );
        tx.append(
          { kind: "agent", id: agentId },
          {
            type: "question.asked",
            data: { questionId, claimId, decisionId, text: request.text, options: request.options },
          },
        );
        return ok({ questionId, decisionId, state: "open", decision: null });
      }).value;
    },

    askSystem(tx, sent) {
      const invalid = invalidSystemQuestion(sent);
      if (invalid !== null) return fail("invalid_request", invalid);
      const request = ownedSystemQuestion(sent);
      const { asker, key } = request;
      const existing = tx.sql
        .exec<QuestionRow>(
          `SELECT question_id, decision_id, agent_id, claim_id, generation, text, options, scope
           FROM questions WHERE agent_id = ? AND request_id = ?`,
          asker,
          key,
        )
        .toArray()[0];
      if (existing !== undefined) {
        if (!sameSystemQuestion(tx.sql, existing, request)) {
          return fail("invalid_request", "That key was used for another question.");
        }
        return ok({ questionId: existing.question_id, decisionId: existing.decision_id });
      }
      const holders: InboxTarget[] = [];
      for (const { claimId, generation } of request.claims) {
        const holder = ports().claims.holder(claimId);
        if (holder === null || holder.generation !== generation) {
          return fail("claim_closed", "A claim is not held at the generation the question names.");
        }
        const depends = tx.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM decision_claims WHERE claim_id = ?",
            claimId,
          )
          .toArray()[0];
        if ((depends?.n ?? 0) >= MAX_QUESTIONS_PER_CLAIM) {
          return fail(
            "quota_exceeded",
            `A claim may depend on at most ${MAX_QUESTIONS_PER_CLAIM} decisions.`,
          );
        }
        holders.push(holder);
      }
      const [first] = holders;
      if (first === undefined) throw new Error("a validated system question names no claim");
      const questionId = newId("qst_");
      const decisionId = newId("dec_");
      tx.sql.exec(
        `INSERT INTO questions (question_id, decision_id, agent_id, request_id, claim_id,
           generation, text, options, scope, asked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        questionId,
        decisionId,
        asker,
        key,
        first.claimId,
        first.generation,
        request.text,
        JSON.stringify(request.options),
        JSON.stringify(request.scope),
        clock(),
      );
      for (const holder of holders) {
        tx.sql.exec(
          `INSERT INTO decision_claims (decision_id, claim_id, agent_id, generation)
           VALUES (?, ?, ?, ?)`,
          decisionId,
          holder.claimId,
          holder.agentId,
          holder.generation,
        );
      }
      tx.append(
        { kind: "system", id: asker },
        {
          type: "question.asked",
          data: {
            questionId,
            claimId: first.claimId,
            decisionId,
            text: request.text,
            options: request.options,
            claimIds: holders.map((holder) => holder.claimId),
          },
        },
      );
      return ok({ questionId, decisionId });
    },

    withdraw(tx, asker, decisionId) {
      const question = tx.sql
        .exec<{ withdrawn_at: number | null }>(
          "SELECT withdrawn_at FROM questions WHERE decision_id = ? AND agent_id = ?",
          decisionId,
          asker,
        )
        .toArray()[0];
      if (question === undefined || question.withdrawn_at !== null) return false;
      // An answered decision is part of the work that relied on it, so only an open one goes.
      if (currentVersion(decisionId) !== 0) return false;
      tx.sql.exec(
        "UPDATE questions SET withdrawn_at = ? WHERE decision_id = ?",
        clock(),
        decisionId,
      );
      tx.sql.exec("DELETE FROM decision_claims WHERE decision_id = ?", decisionId);
      return true;
    },

    async question(agent, questionId, waitMs): Promise<PortResult<QuestionResult>> {
      if (foreign(agent)) return notForThisRepo();
      if (!isId("question", questionId)) {
        return fail("invalid_request", "The question is not a question identifier.");
      }
      if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_LONG_POLL_MS) {
        return fail(
          "invalid_request",
          `The wait must be a whole number of milliseconds from 0 to ${MAX_LONG_POLL_MS}.`,
        );
      }
      const question = questionOf(questionId);
      // Another agent's question is reported as unknown, so its existence is not disclosed.
      if (question === undefined || question.agent_id !== agent.agentId) {
        return fail("not_found", "You asked no such question.");
      }
      const now = result(question);
      if (now.state === "answered" || waitMs === 0 || waiting >= MAX_WAITERS) return ok(now);
      await waitFor(question.decision_id, waitMs);
      return ok(result(question));
    },

    async record(grant: GrantFor<"decision.record">) {
      const invalid = invalidGrant(grant, repoId);
      if (invalid !== null) return fail("invalid_request", invalid);
      const { action, grantId, userId } = grant;
      const { decisionId, option } = action;
      let committed;
      try {
        committed = log.transaction(
          (tx): PortResult<{ decisionId: DecisionId; version: number }> => {
            const used = tx.sql
              .exec<{ decision_id: string; version: number; option: string }>(
                "SELECT decision_id, version, option FROM decision_versions WHERE grant_id = ?",
                grantId,
              )
              .toArray()[0];
            if (used !== undefined) {
              if (used.decision_id !== decisionId || used.option !== option) {
                return fail("invalid_request", "That proof was used for another answer.");
              }
              return ok({ decisionId, version: used.version });
            }
            const question = questionOfDecision(decisionId);
            if (question === undefined)
              return fail("not_found", "No question opened that decision.");
            if (withdrawn(decisionId)) {
              return fail(
                "action_stale",
                "The question was withdrawn because the work it asked about changed.",
              );
            }
            const options = readOptions(question.options);
            if (!options.some((offered) => offered.key === option)) {
              return fail("invalid_request", "The question does not offer that option.");
            }
            const current = currentVersion(decisionId);
            if (current !== (action.expectedVersion ?? 0)) {
              return fail(
                "action_stale",
                "The decision has changed since this answer was prepared.",
              );
            }
            if (current !== 0 && versionOf(decisionId, current)?.option === option) {
              return fail("invalid_request", "The decision already chose that option.");
            }
            const version = current + 1;
            const decidedAt = clock();
            tx.sql.exec(
              `INSERT INTO decision_versions (decision_id, version, option, decided_by, decided_at,
                 grant_id)
               VALUES (?, ?, ?, ?, ?, ?)`,
              decisionId,
              version,
              option,
              userId,
              decidedAt,
              grantId,
            );
            const scope = readScope(question.scope);
            tx.append(
              { kind: "human", id: userId },
              {
                type: "decision.recorded",
                data: {
                  decisionId,
                  version,
                  questionId: question.question_id,
                  option,
                  supersedes: current === 0 ? null : current,
                  scope,
                },
              },
            );
            const targets = tx.sql
              .exec<DependencyRow>(
                `${SELECT_DEPENDENCY} WHERE decision_id = ? ORDER BY claim_id`,
                decisionId,
              )
              .toArray();
            // Any refusal throws and rolls back the version, its event and every item before it.
            for (const target of targets) {
              // Work that relied on an older version can no longer follow this one.
              const kind =
                target.relied !== null && target.relied < version ? "rework" : "decision";
              owe(tx, target, { decisionId, version }, kind);
            }
            // Merged work this version superseded is reopened for its holder, who has just been
            // queued the version, or waits until the holder's active claim closes.
            for (const { claim_id: claimId } of targets) {
              if (isId("claim", claimId)) ports().claims.reopenMerged(tx, claimId);
            }
            // The train returns the pair its question parked to the queue in this transaction, so
            // the answer and the drive the train owes for it commit together.
            if (SYSTEM_ID.test(question.agent_id)) ports().train.answered(tx, decisionId);
            return ok({ decisionId, version });
          },
        );
      } catch (error) {
        if (error instanceof UnavailableError) return unavailable(error.port);
        throw error;
      }
      if (committed.value.ok && committed.events.length > 0) wake(decisionId);
      // The answer is committed, so the train's wake is asked for. Its alarm write in the
      // transaction may have failed, and an answer reported as recorded must leave the drive it
      // owes scheduled, so a failed write refuses it, as `ready` does. A repeat of the same grant
      // finds the version it recorded and asks again; until then the stored wake is asked for by
      // the train's startup and by the next call that queues work.
      if (committed.value.ok && SYSTEM_ID.test(questionOfDecision(decisionId)?.agent_id ?? "")) {
        if (!(await ports().train.armWake())) return unavailable("train");
      }
      return committed.value;
    },

    async requirements(claimId) {
      if (!isId("claim", claimId)) {
        return fail("invalid_request", "The claim is not a claim identifier.");
      }
      return ok(dependencies(claimId));
    },

    currentVersions(claimId) {
      // This module cannot tell an unknown claim from one with no decisions; claims can.
      if (!isId("claim", claimId) || ports().claims.currentGeneration(claimId) === null)
        return null;
      return dependencies(claimId);
    },

    currentDecision(decisionId) {
      if (!isId("decision", decisionId)) return null;
      const current = currentVersion(decisionId);
      if (current === 0) return null;
      const row = versionOf(decisionId, current);
      return row === undefined ? null : { version: current, option: row.option };
    },

    transfer(tx, target) {
      const invalid = invalidTarget(target);
      if (invalid !== null) throw new DecisionsWriteError(invalid);
      const { agentId, claimId, generation } = target;
      if (ports().claims.currentGeneration(claimId) !== generation) {
        throw new DecisionsWriteError("the claim is not held at that generation");
      }
      const moving = tx.sql
        .exec<DependencyRow>(
          `${SELECT_DEPENDENCY} WHERE claim_id = ? ORDER BY decision_id`,
          claimId,
        )
        .toArray()
        // A repeat for the same holder moves and queues nothing.
        .filter((row) => row.agent_id !== agentId || row.generation !== generation);
      for (const row of moving) {
        if (row.generation > generation) {
          throw new DecisionsWriteError("a dependency is held at a newer generation");
        }
        tx.sql.exec(
          "UPDATE decision_claims SET agent_id = ?, generation = ? WHERE decision_id = ? AND claim_id = ?",
          agentId,
          generation,
          row.decision_id,
          claimId,
        );
        const current = currentVersion(row.decision_id);
        // Still open: recording its answer reaches the new holder through the moved row.
        if (current === 0) continue;
        const pendingRework = tx.sql
          .exec(
            `SELECT 1 FROM decision_obligations
             WHERE claim_id = ? AND decision_id = ? AND kind = 'rework' AND item IS NULL`,
            claimId,
            row.decision_id,
          )
          .toArray();
        const kind =
          pendingRework.length > 0 || (row.relied !== null && row.relied < current)
            ? "rework"
            : "decision";
        const decision = { decisionId: row.decision_id, version: current };
        const item = ports().inbox.queue(tx, target, {
          entry: { kind, decision },
          decision: recordedView(decision),
        });
        // The current version subsumes every older one still waiting for a holder.
        tx.sql.exec(
          `UPDATE decision_obligations SET agent_id = ?, item = ?
           WHERE claim_id = ? AND decision_id = ? AND item IS NULL`,
          agentId,
          item,
          claimId,
          row.decision_id,
        );
        tx.sql.exec(
          // The holder's delivery replaces the former holder's, whose item the event log keeps.
          `INSERT INTO decision_obligations
             (claim_id, decision_id, version, kind, agent_id, item, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (claim_id, decision_id, version, kind)
           DO UPDATE SET agent_id = excluded.agent_id, item = excluded.item`,
          claimId,
          row.decision_id,
          current,
          kind,
          agentId,
          item,
          clock(),
        );
      }
    },

    relied(tx, claimId, generation, refs) {
      const invalid = invalidReliance(claimId, generation, refs);
      if (invalid !== null) throw new DecisionsWriteError(invalid);
      // Work lands under the generation that held the claim or an earlier one, never a later one.
      // An expired claim has no current generation to compare against.
      const current = ports().claims.currentGeneration(claimId);
      if (current !== null && generation > current) {
        throw new DecisionsWriteError("the work names a generation newer than the claim's");
      }
      for (const ref of refs) {
        const dependency = tx.sql
          .exec<DependencyRow>(
            `${SELECT_DEPENDENCY} WHERE decision_id = ? AND claim_id = ?`,
            ref.decisionId,
            claimId,
          )
          .toArray()[0];
        // Another claim's decision in the same merge.
        if (dependency === undefined) continue;
        const latest = currentVersion(ref.decisionId);
        if (ref.version > latest) {
          throw new DecisionsWriteError("a relied version was never recorded");
        }
        if (dependency.relied === null || dependency.relied < ref.version) {
          tx.sql.exec(
            "UPDATE decision_claims SET relied = ? WHERE decision_id = ? AND claim_id = ?",
            ref.version,
            ref.decisionId,
            claimId,
          );
        }
        // The work relied on a version that was already replaced. Its rework goes to the
        // dependency's holder, who after a takeover is the successor, not the work's author.
        if (ref.version < latest) {
          owe(tx, dependency, { decisionId: ref.decisionId, version: latest }, "rework");
        }
      }
    },

    obligations(claimId) {
      if (!isId("claim", claimId)) return null;
      return sql
        .exec<ObligationRow>(
          `SELECT claim_id, decision_id, version, kind, agent_id, item, recorded_at
           FROM decision_obligations o
           WHERE claim_id = ? AND version = (
             SELECT MAX(version) FROM decision_obligations l
             WHERE l.claim_id = o.claim_id AND l.decision_id = o.decision_id AND l.kind = o.kind)
           ORDER BY rowid`,
          claimId,
        )
        .toArray()
        .map((row) => ({
          claimId: row.claim_id,
          decision: { decisionId: row.decision_id, version: row.version },
          kind: obligationKind(row.kind),
          delivery:
            row.agent_id === null || row.item === null
              ? null
              : { agentId: row.agent_id, item: row.item },
          recordedAt: row.recorded_at,
        }));
    },
  };
}

function invalidTarget(target: InboxTarget): string | null {
  if (!isId("agent", target.agentId)) return "the target is not an agent";
  if (!isId("claim", target.claimId)) return "the target names no claim";
  if (!Number.isSafeInteger(target.generation) || target.generation < 1) {
    return "the generation is not a whole number from 1";
  }
  return null;
}

function invalidReliance(claimId: ClaimId, generation: number, refs: DecisionRef[]): string | null {
  if (!isId("claim", claimId)) return "the claim is not a claim identifier";
  if (!Number.isSafeInteger(generation) || generation < 1) {
    return "the generation is not a whole number from 1";
  }
  if (refs.length > MAX_LIST_LENGTH) return `at most ${MAX_LIST_LENGTH} versions may be relied on`;
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!isId("decision", ref.decisionId)) return "a relied decision is not a decision identifier";
    if (!Number.isSafeInteger(ref.version) || ref.version < 1) {
      return "a relied version is not a whole number from 1";
    }
    if (seen.has(ref.decisionId)) return "a decision is relied on twice";
    seen.add(ref.decisionId);
  }
  return null;
}

/** Reads a stored kind. The table's CHECK admits only these two. */
function obligationKind(kind: string): DecisionObligation["kind"] {
  switch (kind) {
    case "decision":
    case "rework":
      return kind;
    default:
      throw new Error("decision_obligations holds an unknown kind");
  }
}

function notForThisRepo(): PortResult<never> {
  return fail("unauthenticated", "The session is not for this repository.");
}

// The Worker validated the request already; this repeats the checks a port must not trust it for.
function invalidAsk(request: AskRequest): string | null {
  if (!Number.isSafeInteger(request.generation) || request.generation < 1) {
    return "The generation must be a whole number from 1.";
  }
  if (!isRequestId(request.requestId)) return "The requestId is not an idempotency key.";
  return invalidContent(request);
}

function invalidSystemQuestion(question: SystemQuestion): string | null {
  if (!SYSTEM_ID.test(question.asker)) return "The asker is not a system module.";
  if (question.key === "" || question.key.length > MAX_SYSTEM_QUESTION_KEY_LENGTH) {
    return `The key must be non-empty and at most ${MAX_SYSTEM_QUESTION_KEY_LENGTH} characters.`;
  }
  const { claims } = question;
  if (claims.length === 0 || claims.length > MAX_OPTIONS) {
    return `A system question names from 1 to ${MAX_OPTIONS} claims.`;
  }
  const seen = new Set<string>();
  for (const { claimId, generation } of claims) {
    if (!isId("claim", claimId)) return "A claim is not a claim identifier.";
    if (!Number.isSafeInteger(generation) || generation < 1) {
      return "A generation is not a whole number from 1.";
    }
    if (seen.has(claimId)) return "A claim is named twice.";
    seen.add(claimId);
  }
  return invalidContent(question);
}

/** Checks the text, options and scope every question shares. */
function invalidContent(request: Pick<AskRequest, "text" | "options" | "scope">): string | null {
  if (request.text.trim() === "" || request.text.length > MAX_QUESTION_LENGTH) {
    return `The question must be non-blank and at most ${MAX_QUESTION_LENGTH} characters.`;
  }
  const { options } = request;
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    return `A question offers from ${MIN_OPTIONS} to ${MAX_OPTIONS} options.`;
  }
  const keys = new Set<string>();
  for (const option of options) {
    if (!OPTION_KEY.test(option.key)) return "An option key is not a valid option key.";
    if (keys.has(option.key)) return "Two options share a key.";
    keys.add(option.key);
    if (option.label.trim() === "" || option.label.length > MAX_OPTION_LABEL_LENGTH) {
      return `An option label must be non-blank and at most ${MAX_OPTION_LABEL_LENGTH} characters.`;
    }
  }
  const { scope } = request;
  if (scope.length === 0 || scope.length > MAX_LIST_LENGTH) {
    return `The scope names from 1 to ${MAX_LIST_LENGTH} repository paths.`;
  }
  if (!scope.every(isScopePath)) return "A scope entry is not a repository path.";
  if (scopeBytes(scope) > MAX_SCOPE_BYTES) {
    return `The scope may take at most ${MAX_SCOPE_BYTES} bytes.`;
  }
  return null;
}

/**
 * Keeps only the fields a question owns, in a fixed order, so a retry whose option objects list
 * `key` and `label` in another order, or carry extra properties, is the same request.
 */
function ownedAsk(request: AskRequest): AskRequest {
  return {
    generation: request.generation,
    requestId: request.requestId,
    text: request.text,
    options: request.options.map(({ key, label }) => ({ key, label })),
    scope: [...request.scope],
  };
}

/** `ownedAsk` for a system question. */
function ownedSystemQuestion(question: SystemQuestion): SystemQuestion {
  return {
    asker: question.asker,
    key: question.key,
    claims: question.claims.map(({ claimId, generation }) => ({ claimId, generation })),
    text: question.text,
    options: question.options.map(({ key, label }) => ({ key, label })),
    scope: [...question.scope],
  };
}

/** Whether a stored system question was asked with exactly `request`'s content and claims. */
function sameSystemQuestion(sql: SqlStorage, row: QuestionRow, request: SystemQuestion): boolean {
  const [first] = request.claims;
  if (
    first === undefined ||
    row.claim_id !== first.claimId ||
    row.generation !== first.generation ||
    row.text !== request.text ||
    row.options !== JSON.stringify(request.options) ||
    row.scope !== JSON.stringify(request.scope)
  ) {
    return false;
  }
  // A takeover may have moved a dependency since, so only the claims are compared.
  const claims = sql
    .exec<{ claim_id: string }>(
      "SELECT claim_id FROM decision_claims WHERE decision_id = ? ORDER BY claim_id",
      row.decision_id,
    )
    .toArray()
    .map((dependency) => dependency.claim_id);
  const asked = request.claims.map(({ claimId }) => claimId).toSorted();
  return claims.length === asked.length && claims.every((claimId, i) => claimId === asked[i]);
}

function sameAsk(row: QuestionRow, claimId: ClaimId, request: AskRequest): boolean {
  return (
    row.claim_id === claimId &&
    row.generation === request.generation &&
    row.text === request.text &&
    row.options === JSON.stringify(request.options) &&
    row.scope === JSON.stringify(request.scope)
  );
}

// Only the owner module builds a grant, after consuming one passkey proof; these checks keep a
// grant for another repository, person or action from recording anything here.
function invalidGrant(grant: GrantFor<"decision.record">, repoId: string): string | null {
  if (grant.kind !== "human" || grant.repoId !== repoId) {
    return "The proof is not a person's proof for this repository.";
  }
  if (!isId("user", grant.userId)) return "The proof does not name a person.";
  if (grant.grantId === "") return "The proof is not a consumed challenge.";
  const { action } = grant;
  if (action.kind !== "decision.record") return "The proof is for another action.";
  if (!isId("decision", action.decisionId)) return "The decision is not a decision identifier.";
  if (!OPTION_KEY.test(action.option)) return "The option is not a valid option key.";
  const expected = action.expectedVersion;
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1)) {
    return "The expected version must be a whole number from 1, or none.";
  }
  return null;
}

/**
 * Reads stored options. Rows are written only by `ask`, after validation, so the stored JSON is
 * trusted as what was written.
 */
function readOptions(json: string): QuestionOption[] {
  const options: QuestionOption[] = JSON.parse(json);
  return options;
}

function readScope(json: string): string[] {
  const scope: string[] = JSON.parse(json);
  return scope;
}

function optionOf(options: QuestionOption[], key: string): QuestionOption {
  const option = options.find((offered) => offered.key === key);
  if (option === undefined)
    throw new Error("a recorded option is not among its question's options");
  return option;
}

function newId(prefix: "qst_" | "dec_"): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
}
