// Agent inboxes. Each item belongs to one agent, is numbered per agent from 1 and is never reused or
// deleted. An item moves from queued to delivered to acknowledged, each step recorded once, in the
// same transaction as its event:
//
// - `queue` runs inside the caller's transaction and appends `inbox.queued`.
// - `pending` and `digest` return the oldest unacknowledged items and append `inbox.delivered` for
//   each one returned for the first time. Both stop at a byte budget as well as an item count, so
//   an inbox page and the digest piggybacked on it stay within `MAX_AGENT_RESPONSE_BYTES`; the
//   rest wait, still pending, for the next call. A repeat, after a lost response or a reconnect,
//   returns the same items again and appends nothing. Delivery is not acknowledgement.
// - `ack` records the agent's plan for an item it was delivered and appends `inbox.acked` with the
//   agent as actor. A repeat returns the first acknowledgement and appends nothing.
//
// `readyGate` reads the unacknowledged items of one claim at one generation. It has no default: an
// empty answer means the store holds no unacknowledged item for that claim and generation.
//
// Every item must fit the smaller budget on its own, so the oldest item always fits and the agent
// can acknowledge its way through the inbox. `queue` refuses a larger one.
//
// Plans and decision text are untrusted. They are stored and returned as bounded data, never logged.

import {
  MAX_AGENT_RESPONSE_BYTES,
  MAX_INBOX_PAGE,
  MAX_PIGGYBACK_ITEMS,
  type AckResult,
  type DecisionView,
  type InboxDigest,
  type InboxItem,
  type InboxResult,
} from "@railhead/shared/agent-api";
import {
  isId,
  MAX_LIST_LENGTH,
  MAX_OPTION_LABEL_LENGTH,
  MAX_PATH_LENGTH,
  MAX_PLAN_LENGTH,
  MAX_QUESTION_LENGTH,
  type Actor,
  type AgentId,
  type InboxEntry,
  type QuestionOption,
} from "@railhead/shared/events";
import type { InboxPort, InboxTarget, QueuedItem, ReadyGate } from "../../contracts/inbox";
import type { AgentPrincipal } from "../../contracts/principals";
import { fail, ok, type PortResult } from "../../contracts/result";
import type { RepoContext } from "../../repo/composeRepo";
import type { EventTransaction } from "../../repo/eventLog";
import { migrate } from "../../repo/storage";

/** The migration owner name of the inbox's tables. */
export const INBOX_OWNER = "inbox";

/** Released schema steps of the inbox. Append a step to change the schema; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE inbox_items (
    agent_id TEXT NOT NULL,
    item INTEGER NOT NULL CHECK (item > 0),
    claim_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    entry TEXT NOT NULL,
    decision TEXT,
    queued_at INTEGER NOT NULL,
    delivered_at INTEGER,
    acked_at INTEGER,
    plan TEXT,
    PRIMARY KEY (agent_id, item),
    CHECK ((acked_at IS NULL) = (plan IS NULL)),
    CHECK (acked_at IS NULL OR delivered_at IS NOT NULL)
  ) STRICT`,
  "CREATE INDEX inbox_unacked ON inbox_items (agent_id, item) WHERE acked_at IS NULL",
  "CREATE INDEX inbox_claim_unacked ON inbox_items (claim_id, generation, item) WHERE acked_at IS NULL",
];

/** The actor of the system facts the inbox records. */
const INBOX_ACTOR: Actor = { kind: "system", id: "sys_inbox" };

/** Most item numbers a blocked ready gate lists. */
export const MAX_GATE_ITEMS = MAX_LIST_LENGTH;

/** Longest option key a decision view may carry. */
const MAX_OPTION_KEY_LENGTH = 32;

/** Most UTF-8 bytes of serialized items one `pending` page carries. */
export const MAX_INBOX_PAGE_BYTES = MAX_AGENT_RESPONSE_BYTES / 2;

/**
 * Most UTF-8 bytes of serialized items the digest on a command result carries. With a full page
 * beside it, a quarter of the response remains for the envelope.
 */
export const MAX_DIGEST_BYTES = MAX_AGENT_RESPONSE_BYTES / 4;

/**
 * Largest serialized item `queue` accepts, in UTF-8 bytes. It fits either budget alone, so the
 * oldest item is always returned.
 */
export const MAX_INBOX_ITEM_BYTES = MAX_DIGEST_BYTES;

interface ItemRow extends Record<string, SqlStorageValue> {
  item: number;
  claim_id: string;
  entry: string;
  decision: string | null;
  queued_at: number;
  delivered_at: number | null;
}

interface AckRow extends Record<string, SqlStorageValue> {
  claim_id: string;
  delivered_at: number | null;
  acked_at: number | null;
  plan: string | null;
}

/** Builds the inbox of one repository, creating or migrating its tables first. */
export function createInbox(context: RepoContext): InboxPort {
  const { storage, log, clock, repoId } = context;
  migrate(storage, INBOX_OWNER, MIGRATIONS);
  const sql = storage.sql;

  function foreign(agent: AgentPrincipal): boolean {
    return agent.kind !== "agent" || agent.repoId !== repoId || !isId("agent", agent.agentId);
  }

  function pendingCount(agentId: AgentId): number {
    const row = sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM inbox_items WHERE agent_id = ? AND acked_at IS NULL",
        agentId,
      )
      .toArray()[0];
    return row?.n ?? 0;
  }

  // Returns the oldest unacknowledged items, at most `limit` of them and at most `budget` serialized
  // bytes, and records first deliveries, in one transaction. Items past either bound are left
  // undelivered.
  function deliver(agentId: AgentId, limit: number, budget: number): InboxResult {
    return log.transaction((tx) => {
      const rows = tx.sql
        .exec<ItemRow>(
          `SELECT item, claim_id, entry, decision, queued_at, delivered_at FROM inbox_items
           WHERE agent_id = ? AND acked_at IS NULL ORDER BY item LIMIT ?`,
          agentId,
          limit,
        )
        .toArray();
      const selected: Array<{ row: ItemRow; item: InboxItem }> = [];
      let used = 0;
      for (const row of rows) {
        const item = readItem(row);
        // One more byte for the comma between array elements.
        const size = serializedBytes(item) + 1;
        // `queue` keeps every item within the budget, so the oldest is always selected.
        if (selected.length > 0 && used + size > budget) break;
        used += size;
        selected.push({ row, item });
      }
      const now = clock();
      for (const { row } of selected) {
        if (row.delivered_at !== null) continue;
        tx.sql.exec(
          "UPDATE inbox_items SET delivered_at = ? WHERE agent_id = ? AND item = ?",
          now,
          agentId,
          row.item,
        );
        tx.append(INBOX_ACTOR, {
          type: "inbox.delivered",
          data: { agentId, claimId: row.claim_id, item: row.item },
        });
      }
      return { items: selected.map(({ item }) => item), pending: pendingCount(agentId) };
    }).value;
  }

  return {
    async pending(agent, limit) {
      if (foreign(agent)) return notForThisRepo();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INBOX_PAGE) {
        return fail(
          "invalid_request",
          `The limit must be a whole number from 1 to ${MAX_INBOX_PAGE}.`,
        );
      }
      return ok(deliver(agent.agentId, limit, MAX_INBOX_PAGE_BYTES));
    },

    async digest(agent): Promise<PortResult<InboxDigest>> {
      if (foreign(agent)) return notForThisRepo();
      return ok(deliver(agent.agentId, MAX_PIGGYBACK_ITEMS, MAX_DIGEST_BYTES));
    },

    async ack(agent, item, plan): Promise<PortResult<AckResult>> {
      if (foreign(agent)) return notForThisRepo();
      if (!Number.isSafeInteger(item) || item < 1) {
        return fail("invalid_request", "The item must be a whole number from 1.");
      }
      if (plan.trim() === "" || plan.length > MAX_PLAN_LENGTH) {
        return fail(
          "invalid_request",
          `The plan must be non-blank and at most ${MAX_PLAN_LENGTH} characters.`,
        );
      }
      const { agentId } = agent;
      return log.transaction((tx): PortResult<AckResult> => {
        // Keyed by the caller's own agent id: another agent's item number names nothing here.
        const row = tx.sql
          .exec<AckRow>(
            `SELECT claim_id, delivered_at, acked_at, plan FROM inbox_items
             WHERE agent_id = ? AND item = ?`,
            agentId,
            item,
          )
          .toArray()[0];
        if (row === undefined) return fail("not_found", `You have no inbox item ${item}.`);
        if (row.acked_at !== null && row.plan !== null) {
          return ok({ item, plan: row.plan, ackedAt: row.acked_at, repeated: true });
        }
        if (row.delivered_at === null) {
          return fail("invalid_request", `Item ${item} has not been delivered; sync first.`);
        }
        const ackedAt = clock();
        tx.sql.exec(
          "UPDATE inbox_items SET acked_at = ?, plan = ? WHERE agent_id = ? AND item = ?",
          ackedAt,
          plan,
          agentId,
          item,
        );
        tx.append(
          { kind: "agent", id: agentId },
          { type: "inbox.acked", data: { agentId, claimId: row.claim_id, item, plan } },
        );
        return ok({ item, plan, ackedAt, repeated: false });
      }).value;
    },

    queue(tx: EventTransaction, target: InboxTarget, queued: QueuedItem): number {
      requireTarget(target);
      requireQueuedItem(queued);
      const { agentId, claimId, generation } = target;
      const last = tx.sql
        .exec<{ last: number | null }>(
          "SELECT MAX(item) AS last FROM inbox_items WHERE agent_id = ?",
          agentId,
        )
        .toArray()[0];
      const item = (last?.last ?? 0) + 1;
      const queuedAt = clock();
      const size = serializedBytes({
        item,
        claimId,
        queuedAt,
        entry: queued.entry,
        decision: queued.decision,
      });
      if (size > MAX_INBOX_ITEM_BYTES) {
        throw new InboxQueueError(
          `the item serializes to ${size} bytes, more than ${MAX_INBOX_ITEM_BYTES}`,
        );
      }
      tx.sql.exec(
        `INSERT INTO inbox_items (agent_id, item, claim_id, generation, entry, decision, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        agentId,
        item,
        claimId,
        generation,
        JSON.stringify(queued.entry),
        queued.decision === null ? null : JSON.stringify(queued.decision),
        queuedAt,
      );
      // validateEvent checks the entry; a refusal throws and rolls the caller's transaction back.
      tx.append(INBOX_ACTOR, {
        type: "inbox.queued",
        data: { agentId, claimId, item, entry: queued.entry },
      });
      return item;
    },

    async readyGate(claimId, generation): Promise<PortResult<ReadyGate>> {
      if (!isId("claim", claimId)) {
        return fail("invalid_request", "The claim is not a claim identifier.");
      }
      if (!Number.isSafeInteger(generation) || generation < 1) {
        return fail("invalid_request", "The generation must be a whole number from 1.");
      }
      const items = sql
        .exec<{ item: number }>(
          `SELECT item FROM inbox_items
           WHERE claim_id = ? AND generation = ? AND acked_at IS NULL ORDER BY item LIMIT ?`,
          claimId,
          generation,
          MAX_GATE_ITEMS,
        )
        .toArray()
        .map((row) => row.item);
      return ok(items.length === 0 ? { kind: "clear" } : { kind: "blocked", items });
    },
  };
}

function notForThisRepo(): PortResult<never> {
  return fail("unauthenticated", "The session is not for this repository.");
}

/**
 * Reads one stored row. Rows are written only by `queue`, after validation, so the stored JSON is
 * trusted as what was written.
 */
function readItem(row: ItemRow): InboxItem {
  const entry: InboxEntry = JSON.parse(row.entry);
  const decision: DecisionView | null = row.decision === null ? null : JSON.parse(row.decision);
  return { item: row.item, claimId: row.claim_id, queuedAt: row.queued_at, entry, decision };
}

const encoder = new TextEncoder();

/** The UTF-8 length of an item as a response serializes it. */
function serializedBytes(item: InboxItem): number {
  return encoder.encode(JSON.stringify(item)).byteLength;
}

/** A refused `queue` call. It throws inside the caller's transaction, which then rolls back. */
export class InboxQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxQueueError";
  }
}

function requireTarget(target: InboxTarget): void {
  if (!isId("agent", target.agentId)) throw new InboxQueueError("agentId is not an agent id");
  if (!isId("claim", target.claimId)) throw new InboxQueueError("claimId is not a claim id");
  if (!Number.isSafeInteger(target.generation) || target.generation < 1) {
    throw new InboxQueueError("generation is not a whole number from 1");
  }
}

function requireQueuedItem(queued: QueuedItem): void {
  switch (queued.entry.kind) {
    case "decision":
    case "rework": {
      const view = queued.decision;
      if (view === null)
        throw new InboxQueueError(`a ${queued.entry.kind} item needs its decision`);
      const ref = queued.entry.decision;
      if (view.decisionId !== ref.decisionId || view.version !== ref.version) {
        throw new InboxQueueError("the decision view is not the version the entry names");
      }
      requireDecisionView(view);
      return;
    }
    case "conflict":
      if (queued.decision !== null) throw new InboxQueueError("a conflict item has no decision");
      return;
    default:
      return unreachable(queued.entry);
  }
}

function requireDecisionView(view: DecisionView): void {
  if (!isId("decision", view.decisionId)) throw new InboxQueueError("decisionId is invalid");
  if (!isId("question", view.questionId)) throw new InboxQueueError("questionId is invalid");
  if (!isId("user", view.decidedBy)) throw new InboxQueueError("decidedBy is invalid");
  if (!Number.isSafeInteger(view.version) || view.version < 1) {
    throw new InboxQueueError("version is not a whole number from 1");
  }
  const expected = view.version === 1 ? null : view.version - 1;
  if (view.supersedes !== expected)
    throw new InboxQueueError("supersedes is not the prior version");
  if ((view.previous === null) !== (view.version === 1)) {
    throw new InboxQueueError("previous must be set exactly when a version is superseded");
  }
  if (!Number.isSafeInteger(view.decidedAt) || view.decidedAt < 1) {
    throw new InboxQueueError("decidedAt is not a time");
  }
  requireText(view.question, MAX_QUESTION_LENGTH, "question");
  requireOption(view.option, "option");
  if (view.previous !== null) requireOption(view.previous, "previous");
  if (view.scope.length > MAX_LIST_LENGTH) throw new InboxQueueError("scope is too long");
  for (const path of view.scope) requireText(path, MAX_PATH_LENGTH, "scope");
}

function requireOption(option: QuestionOption, field: string): void {
  requireText(option.key, MAX_OPTION_KEY_LENGTH, `${field}.key`);
  requireText(option.label, MAX_OPTION_LABEL_LENGTH, `${field}.label`);
}

function requireText(value: string, max: number, field: string): void {
  if (value.trim() === "" || value.length > max) {
    throw new InboxQueueError(`${field} must be non-blank and at most ${max} characters`);
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled inbox entry: ${String(value)}`);
}
