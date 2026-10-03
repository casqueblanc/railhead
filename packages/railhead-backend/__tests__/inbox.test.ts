import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_RESPONSE_BYTES,
  MAX_INBOX_PAGE,
  MAX_PIGGYBACK_ITEMS,
  type DecisionView,
} from "@railhead/shared/agent-api";
import {
  MAX_LIST_LENGTH,
  MAX_PATH_LENGTH,
  MAX_PLAN_LENGTH,
  type RailheadEvent,
} from "@railhead/shared/events";
import type { InboxPort, InboxTarget, QueuedItem } from "../src/contracts/inbox";
import type { AgentPrincipal } from "../src/contracts/principals";
import { ok } from "../src/contracts/result";
import { UnavailableError, unavailableInbox } from "../src/contracts/unavailable";
import { parseAgentResponse } from "../src/contracts/wireShape";
import { dispatchAgent, type AgentCommand, type AgentReply } from "../src/gateway/agentDispatch";
import {
  createInbox,
  InboxQueueError,
  MAX_GATE_ITEMS,
  MAX_INBOX_ITEM_BYTES,
} from "../src/modules/inbox/inbox";
import { composeRepo } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName, type Repo, type RepoSummary } from "../src/repo/RepoObject";

const NOW = 1_790_000_000_000;
const CLAIM = "clm_claim001";
const OTHER_CLAIM = "clm_claim002";

const VIEW: DecisionView = {
  decisionId: "dec_decision1",
  version: 2,
  supersedes: 1,
  questionId: "qst_question1",
  question: "Should uploads above 10 MB be chunked?",
  option: { key: "chunk", label: "Chunk them" },
  previous: { key: "reject", label: "Reject them" },
  scope: ["src/upload"],
  decidedBy: "usr_lemarier",
  decidedAt: NOW - 1000,
};

const DECISION: QueuedItem = {
  entry: { kind: "decision", decision: { decisionId: VIEW.decisionId, version: VIEW.version } },
  decision: VIEW,
};

const CONFLICT: QueuedItem = {
  entry: { kind: "conflict", otherClaimId: OTHER_CLAIM, path: "src/upload/index.ts" },
  decision: null,
};

interface Harness {
  inbox: InboxPort;
  log: EventLog;
  repoId: string;
  agent(id?: string): AgentPrincipal;
  /** Queues `item` for `agentId` on `CLAIM`, in its own transaction. */
  queue(item?: QueuedItem, target?: Partial<InboxTarget>): number;
  /** Every event in the log. */
  events(): RailheadEvent[];
  /** Advances the clock by `ms`. */
  tick(ms: number): void;
  /**
   * Dispatches `command` as the composed Repo would for an authenticated `agent()`, with this
   * inbox, and returns the reply and its serialized UTF-8 length.
   */
  dispatch(command: AgentCommand): Promise<{ reply: AgentReply; bytes: number }>;
}

async function freshRepo(): Promise<{ stub: DurableObjectStub<Repo>; summary: RepoSummary }> {
  const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const stub = env.REPO.getByName(repoObjectName("acme", name));
  const summary = await stub.initialize("acme", name);
  if (!summary.ok) throw new Error(summary.code);
  return { stub, summary: summary.value };
}

/** Runs `body` against a fresh repository's inbox with a controllable clock. */
async function withInbox<R>(
  body: (harness: Harness) => Promise<R>,
  repo?: { stub: DurableObjectStub<Repo>; summary: RepoSummary },
): Promise<R> {
  const { stub, summary } = repo ?? (await freshRepo());
  const { repoId } = summary;
  return runInDurableObject(stub, async (_instance, state) => {
    let now = NOW;
    const clock = () => now;
    const log = EventLog.open(state.storage, repoId, clock);
    const context = { repoId, storage: state.storage, log, clock, env, wake: () => {} };
    const inbox = createInbox(context);
    const agent = (id = "agt_atlas01"): AgentPrincipal => ({
      kind: "agent",
      agentId: id,
      ownerId: "usr_lemarier",
      repoId,
    });
    const real = composeRepo(context);
    const ports = {
      ...real,
      sessions: { ...real.sessions, authenticate: async () => ok(agent()) },
      inbox,
    };
    const harness: Harness = {
      inbox,
      log,
      repoId,
      agent,
      queue: (item = DECISION, target = {}) =>
        log.transaction((tx) =>
          inbox.queue(
            tx,
            { agentId: "agt_atlas01", claimId: CLAIM, generation: 1, ...target },
            item,
          ),
        ).value,
      events: () => log.replay(0, 256).events,
      tick: (ms) => {
        now += ms;
      },
      dispatch: async (command) => {
        const reply = await dispatchAgent(
          { ...summary, ports },
          { command, token: "aaaa.bbbb.cccc", origin: "https://railhead.invalid" },
        );
        // What `respond` in agentHttp.ts writes.
        const serialized = JSON.stringify(reply);
        return { reply, bytes: new TextEncoder().encode(serialized).byteLength };
      },
    };
    return body(harness);
  });
}

function types(events: RailheadEvent[]): string[] {
  return events.map((event) => event.type);
}

/** `DECISION` with another scope. */
function scopedDecision(scope: string[]): QueuedItem {
  return {
    entry: { kind: "decision", decision: { decisionId: VIEW.decisionId, version: VIEW.version } },
    decision: { ...VIEW, scope },
  };
}

/** A decision whose scope holds the most paths, each `char` repeated to the longest path. */
function wideDecision(char: string): QueuedItem {
  const path = char.repeat(MAX_PATH_LENGTH / char.length);
  return scopedDecision(Array.from({ length: MAX_LIST_LENGTH }, () => path));
}

/** A decision whose scope holds `scopeChars` control characters, each a six-byte JSON escape. */
function escapedDecision(scopeChars: number): QueuedItem {
  const scope: string[] = [];
  for (let rest = scopeChars; rest > 0; rest -= MAX_PATH_LENGTH) {
    scope.push("\u0007".repeat(Math.min(rest, MAX_PATH_LENGTH)));
  }
  return scopedDecision(scope);
}

/** The UTF-8 length of `queued` as the first item of an inbox, queued at `NOW`. */
function firstItemBytes(queued: QueuedItem): number {
  const item = { item: 1, claimId: CLAIM, queuedAt: NOW, ...queued };
  return new TextEncoder().encode(JSON.stringify(item)).byteLength;
}

/** Item numbers with an `inbox.delivered` fact. */
function deliveredItems(events: RailheadEvent[]): number[] {
  return events.flatMap((event) => (event.type === "inbox.delivered" ? [event.data.item] : []));
}

/** One `inbox` sync through the agent dispatch, read back as the CLI parses it. */
async function sync(h: Harness, limit: number) {
  const { reply, bytes } = await h.dispatch({ route: "inbox", limit });
  const pair = parseAgentResponse("inbox", JSON.parse(JSON.stringify(reply)));
  if (pair.route !== "inbox" || !pair.response.ok || pair.response.inbox === null) {
    throw new Error("the inbox sync failed");
  }
  return { page: pair.response.data, digest: pair.response.inbox, bytes };
}

describe("queue", () => {
  it("numbers items per agent from 1 and records inbox.queued", async () => {
    await withInbox(async (h) => {
      expect(h.queue()).toBe(1);
      expect(h.queue(CONFLICT)).toBe(2);
      expect(h.queue(DECISION, { agentId: "agt_boreas1" })).toBe(1);
      const events = h.events();
      expect(types(events)).toEqual(["inbox.queued", "inbox.queued", "inbox.queued"]);
      expect(events[0]).toMatchObject({
        actor: { kind: "system", id: "sys_inbox" },
        data: { agentId: "agt_atlas01", claimId: CLAIM, item: 1, entry: DECISION.entry },
      });
    });
  });

  it("rolls the caller's transaction back on an invalid item and queues nothing", async () => {
    await withInbox(async (h) => {
      const invalid: Array<[QueuedItem, Partial<InboxTarget>]> = [
        [{ ...DECISION, decision: { ...VIEW, version: 3, supersedes: 2 } }, {}],
        [{ ...DECISION, decision: { ...VIEW, question: "   " } }, {}],
        [{ ...DECISION, decision: { ...VIEW, previous: null } }, {}],
        // A conflict carrying a decision, which the type forbids but a caller could still send.
        [JSON.parse(JSON.stringify({ ...CONFLICT, decision: VIEW })), {}],
        [DECISION, { generation: 0 }],
        [DECISION, { generation: 1.5 }],
        [DECISION, { agentId: "usr_lemarier" }],
        [DECISION, { claimId: "iss_issue001" }],
      ];
      for (const [item, target] of invalid) {
        expect(() =>
          h.log.transaction((tx) => {
            tx.append(
              { kind: "human", id: "usr_lemarier" },
              {
                type: "issue.filed",
                data: { issueId: "iss_issue001", title: "Upload", body: "" },
              },
            );
            return h.inbox.queue(
              tx,
              { agentId: "agt_atlas01", claimId: CLAIM, generation: 1, ...target },
              item,
            );
          }),
        ).toThrow(InboxQueueError);
      }
      expect(h.events()).toEqual([]);
      // Numbering is untouched by the refused calls.
      expect(h.queue()).toBe(1);
    });
  });

  it("rolls back when the event log refuses the entry", async () => {
    await withInbox(async (h) => {
      const badPath: QueuedItem = { ...CONFLICT, entry: { ...CONFLICT.entry, path: "" } };
      expect(() => h.queue(badPath)).toThrow();
      expect(await h.inbox.pending(h.agent(), MAX_INBOX_PAGE)).toEqual({
        ok: true,
        value: { items: [], pending: 0 },
      });
      expect(h.events()).toEqual([]);
    });
  });
});

describe("item size", () => {
  it("accepts the widest ASCII and multibyte scopes and refuses an item no response can carry", async () => {
    await withInbox(async (h) => {
      expect(h.queue(wideDecision("a"))).toBe(1);
      // Three UTF-8 bytes per character: about 197 KB of scope.
      expect(h.queue(wideDecision("界"))).toBe(2);
      // Four bytes per surrogate pair.
      expect(h.queue(wideDecision("😀"))).toBe(3);

      // A control character serializes as a six-byte escape: about 393 KB of scope.
      const escaped = wideDecision("\u0007");
      expect(() =>
        h.log.transaction((tx) => {
          tx.append(
            { kind: "human", id: "usr_lemarier" },
            { type: "issue.filed", data: { issueId: "iss_issue001", title: "Upload", body: "" } },
          );
          return h.inbox.queue(
            tx,
            { agentId: "agt_atlas01", claimId: CLAIM, generation: 1 },
            escaped,
          );
        }),
      ).toThrow(InboxQueueError);
      expect(types(h.events())).toEqual(["inbox.queued", "inbox.queued", "inbox.queued"]);
      expect(h.queue()).toBe(4);
    });
  });

  it("returns an item of exactly the largest size the queue accepts", async () => {
    await withInbox(async (h) => {
      // The most escaped scope characters (six bytes each) that still fit, by bisection.
      let chars = 0;
      let over = MAX_INBOX_ITEM_BYTES;
      while (over - chars > 1) {
        const mid = Math.floor((chars + over) / 2);
        if (firstItemBytes(escapedDecision(mid)) <= MAX_INBOX_ITEM_BYTES) chars = mid;
        else over = mid;
      }
      const largest = escapedDecision(chars);
      const slack = MAX_INBOX_ITEM_BYTES - firstItemBytes(largest);
      expect(slack).toBeGreaterThanOrEqual(0);
      expect(slack).toBeLessThan(10);

      expect(() => h.queue(escapedDecision(chars + 1))).toThrow(InboxQueueError);
      expect(h.queue(largest)).toBe(1);
      const { page, digest, bytes } = await sync(h, 1);
      expect(page.items.map((i) => i.item)).toEqual([1]);
      expect(digest.items.map((i) => i.item)).toEqual([1]);
      expect(bytes).toBeLessThanOrEqual(MAX_AGENT_RESPONSE_BYTES);
    });
  });
});

describe("delivery", () => {
  it("returns items oldest first and records each first delivery once", async () => {
    await withInbox(async (h) => {
      h.queue();
      h.queue(CONFLICT);
      h.tick(500);
      const first = await h.inbox.pending(h.agent(), MAX_INBOX_PAGE);
      expect(first).toEqual({
        ok: true,
        value: {
          items: [
            { item: 1, claimId: CLAIM, queuedAt: NOW, entry: DECISION.entry, decision: VIEW },
            { item: 2, claimId: CLAIM, queuedAt: NOW, entry: CONFLICT.entry, decision: null },
          ],
          pending: 2,
        },
      });
      expect(types(h.events())).toEqual([
        "inbox.queued",
        "inbox.queued",
        "inbox.delivered",
        "inbox.delivered",
      ]);

      // A lost response or a reconnect: the same items again, no second delivery fact.
      const again = await h.inbox.pending(h.agent(), MAX_INBOX_PAGE);
      expect(again).toEqual(first);
      expect(await h.inbox.digest(h.agent())).toEqual(first);
      expect(h.events()).toHaveLength(4);
    });
  });

  it("does not treat delivery as acknowledgement", async () => {
    await withInbox(async (h) => {
      h.queue();
      await h.inbox.pending(h.agent(), 1);
      expect(await h.inbox.readyGate(CLAIM, 1)).toEqual({
        ok: true,
        value: { kind: "blocked", items: [1] },
      });
      expect(types(h.events())).not.toContain("inbox.acked");
    });
  });

  it("bounds a page by its limit and the digest by MAX_PIGGYBACK_ITEMS", async () => {
    await withInbox(async (h) => {
      for (let n = 0; n < MAX_INBOX_PAGE + 1; n += 1) h.queue(CONFLICT);
      const one = await h.inbox.pending(h.agent(), 1);
      expect(one.ok && one.value.items.map((i) => i.item)).toEqual([1]);
      expect(one.ok && one.value.pending).toBe(MAX_INBOX_PAGE + 1);

      const digest = await h.inbox.digest(h.agent());
      expect(digest.ok && digest.value.items).toHaveLength(MAX_PIGGYBACK_ITEMS);

      const page = await h.inbox.pending(h.agent(), MAX_INBOX_PAGE);
      expect(page.ok && page.value.items).toHaveLength(MAX_INBOX_PAGE);
      // Item 65 was never returned, so it is the only one without a delivery fact.
      const delivered = h.events().filter((event) => event.type === "inbox.delivered");
      expect(delivered).toHaveLength(MAX_INBOX_PAGE);
    });
  });

  it("keeps every response within MAX_AGENT_RESPONSE_BYTES while an agent drains wide items", async () => {
    await withInbox(async (h) => {
      const count = 24;
      for (let n = 0; n < count; n += 1) h.queue(wideDecision(n % 2 === 0 ? "界" : "a"));
      // Every item number a response has carried, in its page or its digest.
      const carried = new Set<number>();
      const carry = (items: Array<{ item: number }>) => {
        for (const { item } of items) carried.add(item);
      };

      // A one-item sync with a large backlog: the digest beside it is cut by bytes, not count.
      const first = await sync(h, 1);
      expect(first.bytes).toBeLessThanOrEqual(MAX_AGENT_RESPONSE_BYTES);
      expect(first.page.items.map((i) => i.item)).toEqual([1]);
      expect(first.page.pending).toBe(count);
      expect(first.digest.pending).toBe(count);
      const digested = first.digest.items.map((i) => i.item);
      expect(digested).toEqual(Array.from({ length: digested.length }, (_, n) => n + 1));
      expect(digested.length).toBeLessThan(MAX_PIGGYBACK_ITEMS);
      carry(first.page.items);
      carry(first.digest.items);
      // Only the items a response carried have a delivery fact.
      expect(deliveredItems(h.events())).toEqual([...carried]);

      let next = 1;
      for (let round = 0; round < count && next <= count; round += 1) {
        const { page, digest, bytes } = await sync(h, MAX_INBOX_PAGE);
        expect(bytes).toBeLessThanOrEqual(MAX_AGENT_RESPONSE_BYTES);
        const items = page.items.map((i) => i.item);
        // Oldest first from the oldest unacknowledged item, cut by bytes well short of the limit.
        expect(items).toEqual(Array.from({ length: items.length }, (_, n) => next + n));
        expect(items.length).toBeGreaterThan(0);
        expect(page.pending).toBe(count - next + 1);
        if (round === 0) expect(items.length).toBeLessThan(count);
        carry(page.items);
        carry(digest.items);
        for (const item of items) {
          const ack = await h.dispatch({ route: "ack", item, body: { plan: "Scope noted." } });
          expect(ack.bytes).toBeLessThanOrEqual(MAX_AGENT_RESPONSE_BYTES);
          if (!ack.reply.ok || ack.reply.inbox === null) throw new Error("the ack failed");
          expect(ack.reply.data).toMatchObject({ item, repeated: false });
          carry(ack.reply.inbox.items);
        }
        expect(new Set(deliveredItems(h.events()))).toEqual(carried);
        next += items.length;
      }
      expect(next).toBe(count + 1);
      expect(await h.inbox.pending(h.agent(), MAX_INBOX_PAGE)).toEqual({
        ok: true,
        value: { items: [], pending: 0 },
      });
    });
  });

  it("refuses a limit outside 1..MAX_INBOX_PAGE and records nothing", async () => {
    await withInbox(async (h) => {
      h.queue();
      for (const limit of [0, -1, MAX_INBOX_PAGE + 1, 1.5, Number.NaN]) {
        expect(await h.inbox.pending(h.agent(), limit)).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
      }
      expect(types(h.events())).toEqual(["inbox.queued"]);
    });
  });

  it("answers an empty inbox at once without recording anything", async () => {
    await withInbox(async (h) => {
      expect(await h.inbox.pending(h.agent(), MAX_INBOX_PAGE)).toEqual({
        ok: true,
        value: { items: [], pending: 0 },
      });
      expect(await h.inbox.digest(h.agent())).toEqual({
        ok: true,
        value: { items: [], pending: 0 },
      });
      expect(h.events()).toEqual([]);
    });
  });

  it("shows an agent only its own items", async () => {
    await withInbox(async (h) => {
      h.queue();
      const other = await h.inbox.pending(h.agent("agt_boreas1"), MAX_INBOX_PAGE);
      expect(other).toEqual({ ok: true, value: { items: [], pending: 0 } });
      expect(types(h.events())).toEqual(["inbox.queued"]);
    });
  });

  it("refuses a principal of another repository", async () => {
    await withInbox(async (h) => {
      h.queue();
      const foreign: AgentPrincipal = { ...h.agent(), repoId: "rep_other01" };
      for (const result of [
        await h.inbox.pending(foreign, 1),
        await h.inbox.digest(foreign),
        await h.inbox.ack(foreign, 1, "Chunk uploads."),
      ]) {
        expect(result).toMatchObject({ ok: false, code: "unauthenticated" });
      }
      expect(types(h.events())).toEqual(["inbox.queued"]);
    });
  });

  it("keeps items across eviction of the Repo", async () => {
    const repo = await freshRepo();
    await withInbox(async (h) => {
      h.queue();
      await h.inbox.pending(h.agent(), 1);
    }, repo);
    await evictDurableObject(repo.stub);
    await withInbox(async (h) => {
      const page = await h.inbox.pending(h.agent(), MAX_INBOX_PAGE);
      expect(page.ok && page.value.items.map((i) => i.item)).toEqual([1]);
      // Delivered before the eviction, so no second delivery fact.
      expect(types(h.events())).toEqual(["inbox.queued", "inbox.delivered"]);
      expect(await h.inbox.readyGate(CLAIM, 1)).toEqual({
        ok: true,
        value: { kind: "blocked", items: [1] },
      });
    }, repo);
  });
});

describe("ack", () => {
  it("records the agent's plan once, as the agent, and clears the gate", async () => {
    await withInbox(async (h) => {
      h.queue();
      await h.inbox.pending(h.agent(), 1);
      h.tick(2000);
      expect(await h.inbox.ack(h.agent(), 1, "Chunk uploads in 5 MB parts.")).toEqual({
        ok: true,
        value: {
          item: 1,
          plan: "Chunk uploads in 5 MB parts.",
          ackedAt: NOW + 2000,
          repeated: false,
        },
      });
      const acked = h.events().at(-1);
      expect(acked).toMatchObject({
        type: "inbox.acked",
        actor: { kind: "agent", id: "agt_atlas01" },
        data: {
          agentId: "agt_atlas01",
          claimId: CLAIM,
          item: 1,
          plan: "Chunk uploads in 5 MB parts.",
        },
      });
      expect(await h.inbox.readyGate(CLAIM, 1)).toEqual({ ok: true, value: { kind: "clear" } });
      expect(await h.inbox.pending(h.agent(), MAX_INBOX_PAGE)).toEqual({
        ok: true,
        value: { items: [], pending: 0 },
      });
    });
  });

  it("answers a replay with the first acknowledgement and records nothing", async () => {
    await withInbox(async (h) => {
      h.queue();
      await h.inbox.pending(h.agent(), 1);
      await h.inbox.ack(h.agent(), 1, "First plan.");
      const head = h.log.head();
      h.tick(60_000);
      expect(await h.inbox.ack(h.agent(), 1, "A different plan.")).toEqual({
        ok: true,
        value: { item: 1, plan: "First plan.", ackedAt: NOW, repeated: true },
      });
      expect(h.log.head()).toBe(head);
    });
  });

  it("refuses another agent's item as unknown and leaves the gate blocked", async () => {
    await withInbox(async (h) => {
      h.queue();
      await h.inbox.pending(h.agent(), 1);
      expect(await h.inbox.ack(h.agent("agt_boreas1"), 1, "Not mine.")).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(await h.inbox.ack(h.agent(), 2, "No such item.")).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(types(h.events())).not.toContain("inbox.acked");
      expect(await h.inbox.readyGate(CLAIM, 1)).toEqual({
        ok: true,
        value: { kind: "blocked", items: [1] },
      });
    });
  });

  it("refuses an item that was never delivered", async () => {
    await withInbox(async (h) => {
      h.queue();
      expect(await h.inbox.ack(h.agent(), 1, "Guessed the number.")).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(types(h.events())).toEqual(["inbox.queued"]);
    });
  });

  it("refuses a blank or oversized plan and an invalid item number", async () => {
    await withInbox(async (h) => {
      h.queue();
      await h.inbox.pending(h.agent(), 1);
      const head = h.log.head();
      for (const [item, plan] of [
        [1, ""],
        [1, " \n\t"],
        [1, "x".repeat(MAX_PLAN_LENGTH + 1)],
        [0, "Plan."],
        [-1, "Plan."],
        [1.5, "Plan."],
      ] as const) {
        expect(await h.inbox.ack(h.agent(), item, plan)).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
      }
      expect(h.log.head()).toBe(head);
      // The longest plan is accepted.
      const longest = "x".repeat(MAX_PLAN_LENGTH);
      expect(await h.inbox.ack(h.agent(), 1, longest)).toMatchObject({
        ok: true,
        value: { plan: longest },
      });
    });
  });
});

describe("ready gate", () => {
  it("is clear only for the claim and generation with nothing unacknowledged", async () => {
    await withInbox(async (h) => {
      h.queue(DECISION, { generation: 2 });
      h.queue(CONFLICT, { claimId: OTHER_CLAIM, agentId: "agt_boreas1" });
      expect(await h.inbox.readyGate(CLAIM, 2)).toEqual({
        ok: true,
        value: { kind: "blocked", items: [1] },
      });
      // An item queued for another generation or claim does not block this one.
      expect(await h.inbox.readyGate(CLAIM, 1)).toEqual({ ok: true, value: { kind: "clear" } });
      expect(await h.inbox.readyGate("clm_claim003", 1)).toEqual({
        ok: true,
        value: { kind: "clear" },
      });
    });
  });

  it("lists at most MAX_GATE_ITEMS blocking items", async () => {
    await withInbox(async (h) => {
      for (let n = 0; n < MAX_GATE_ITEMS + 1; n += 1) h.queue(CONFLICT);
      const gate = await h.inbox.readyGate(CLAIM, 1);
      expect(gate.ok && gate.value.kind === "blocked" && gate.value.items).toHaveLength(
        MAX_GATE_ITEMS,
      );
    });
  });

  it("refuses an invalid claim or generation", async () => {
    await withInbox(async (h) => {
      for (const [claimId, generation] of [
        ["iss_issue001", 1],
        ["clm_", 1],
        [CLAIM, 0],
        [CLAIM, 1.5],
      ] as const) {
        expect(await h.inbox.readyGate(claimId, generation)).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
      }
    });
  });
});

describe("unavailable inbox", () => {
  it("refuses every call, never clears the gate and rolls back a queue", async () => {
    await withInbox(async (h) => {
      const agent = h.agent();
      for (const result of [
        await unavailableInbox.pending(agent, 1),
        await unavailableInbox.digest(agent),
        await unavailableInbox.ack(agent, 1, "Plan."),
        await unavailableInbox.readyGate(CLAIM, 1),
      ]) {
        expect(result).toMatchObject({ ok: false, code: "unavailable" });
      }
      expect(() =>
        h.log.transaction((tx) => {
          tx.append(
            { kind: "human", id: "usr_lemarier" },
            {
              type: "issue.filed",
              data: { issueId: "iss_issue001", title: "Upload", body: "" },
            },
          );
          return unavailableInbox.queue(
            tx,
            { agentId: "agt_atlas01", claimId: CLAIM, generation: 1 },
            DECISION,
          );
        }),
      ).toThrow(UnavailableError);
      expect(h.events()).toEqual([]);
    });
  });
});
