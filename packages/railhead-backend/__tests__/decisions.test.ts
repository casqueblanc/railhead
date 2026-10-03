import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MAX_INBOX_PAGE,
  MAX_LONG_POLL_MS,
  type AskRequest,
  type ClaimView,
  type DecisionView,
} from "@railhead/shared/agent-api";
import type { OwnerAction } from "@railhead/shared/board-api";
import { MAX_LIST_LENGTH, type QuestionOption, type RailheadEvent } from "@railhead/shared/events";
import type { InboxPort } from "../src/contracts/inbox";
import type { AgentPrincipal, GrantFor } from "../src/contracts/principals";
import { fail, ok, unavailable, type PortResult } from "../src/contracts/result";
import { unavailableClaims, unavailableInbox } from "../src/contracts/unavailable";
import {
  createDecisions,
  MAX_QUESTIONS_PER_CLAIM,
  type Decisions,
} from "../src/modules/decisions/decisions";
import { createInbox } from "../src/modules/inbox/inbox";
import { composeRepo, type RepoPorts } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName, type Repo } from "../src/repo/RepoObject";

const NOW = 1_790_000_000_000;
const CLAIM = "clm_claim001";
const AGENT = "agt_atlas01";
const OWNER = "usr_lemarier";

const clock = (): number => NOW;

const ASK: AskRequest = {
  generation: 1,
  requestId: "req_upload0000000001",
  text: "Should uploads above 10 MB be rejected or chunked?",
  options: [
    { key: "reject", label: "Reject them" },
    { key: "chunk", label: "Upload them in chunks" },
  ],
  scope: ["src/upload.ts"],
};

function claimView(fields: Partial<ClaimView> = {}): ClaimView {
  return {
    claimId: CLAIM,
    issueId: "iss_issue001",
    generation: 1,
    base: "a".repeat(40),
    state: "working",
    readyCommit: null,
    originUrl: "https://railhead.test/acme/demo/claims/clm_claim001.git",
    upstreamUrl: "https://railhead.test/acme/demo.git",
    task: { title: "Upload", body: "" },
    ...fields,
  };
}

interface Harness {
  decisions: Decisions;
  inbox: InboxPort;
  log: EventLog;
  repoId: string;
  agent(id?: string): AgentPrincipal;
  /** A consumed human grant for `action`, as the owner module would build it. */
  grant(
    action: Omit<Extract<OwnerAction, { kind: "decision.record" }>, "kind">,
    grantId?: string,
  ): GrantFor<"decision.record">;
  /** Sets what the claims module answers for `activeClaim`. */
  holds(answer: PortResult<ClaimView | null>): void;
  /** Replaces the inbox the decisions module queues through. */
  useInbox(inbox: InboxPort): void;
  /** Asks `ASK` (with `fields`) as `AGENT` and returns the question's decision id. */
  ask(fields?: Partial<AskRequest>): Promise<{ questionId: string; decisionId: string }>;
  /** Every event in the log. */
  events(): RailheadEvent[];
  /** Counts rows of a decisions table. */
  count(table: "questions" | "decision_versions" | "decision_claims"): number;
}

async function freshRepo(): Promise<{ stub: DurableObjectStub<Repo>; repoId: string }> {
  const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const stub = env.REPO.getByName(repoObjectName("acme", name));
  const summary = await stub.initialize("acme", name);
  if (!summary.ok) throw new Error(summary.code);
  return { stub, repoId: summary.value.repoId };
}

/**
 * Runs `body` against a fresh repository's decisions module, with the real inbox and a claims
 * module whose `activeClaim` answer the test sets. Every other port is the composed one.
 */
async function withDecisions<R>(
  body: (harness: Harness) => Promise<R>,
  repo?: { stub: DurableObjectStub<Repo>; repoId: string },
): Promise<R> {
  const { stub, repoId } = repo ?? (await freshRepo());
  return runInDurableObject(stub, async (_instance, state) => {
    const log = EventLog.open(state.storage, repoId, clock);
    const context = { repoId, storage: state.storage, log, clock, env };
    const composed = composeRepo(context);
    const realInbox = createInbox(context);
    let active: PortResult<ClaimView | null> = ok(claimView());
    let inbox: InboxPort = realInbox;
    const ports = (): RepoPorts => ({
      ...composed,
      claims: { ...unavailableClaims, activeClaim: async () => active },
      inbox,
    });
    const decisions = createDecisions(context, ports);
    const agent = (id = AGENT): AgentPrincipal => ({
      kind: "agent",
      agentId: id,
      ownerId: OWNER,
      repoId,
    });
    const harness: Harness = {
      decisions,
      inbox: realInbox,
      log,
      repoId,
      agent,
      grant: (action, grantId = "chl_grant0001") => ({
        kind: "human",
        userId: OWNER,
        repoId,
        grantId,
        action: { kind: "decision.record", ...action },
      }),
      holds: (answer) => {
        active = answer;
      },
      useInbox: (replacement) => {
        inbox = replacement;
      },
      ask: async (fields = {}) => {
        const asked = await decisions.ask(agent(), CLAIM, { ...ASK, ...fields });
        if (!asked.ok) throw new Error(`ask failed: ${asked.code}`);
        return asked.value;
      },
      events: () => log.replay(0, 256).events,
      count: (table) =>
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0]
          ?.n ?? 0,
    };
    return body(harness);
  });
}

function types(events: RailheadEvent[]): string[] {
  return events.map((event) => event.type);
}

describe("ask", () => {
  it("records the question and the asking claim as the decision's dependency", async () => {
    await withDecisions(async (h) => {
      const asked = await h.decisions.ask(h.agent(), CLAIM, ASK);
      if (!asked.ok) throw new Error(asked.code);
      expect(asked.value).toMatchObject({ state: "open", decision: null });
      expect(asked.value.questionId).toMatch(/^qst_[0-9a-f]{32}$/);
      expect(asked.value.decisionId).toMatch(/^dec_[0-9a-f]{32}$/);

      const events = h.events();
      expect(types(events)).toEqual(["question.asked"]);
      expect(events[0]).toMatchObject({
        actor: { kind: "agent", id: AGENT },
        data: {
          questionId: asked.value.questionId,
          claimId: CLAIM,
          decisionId: asked.value.decisionId,
          text: ASK.text,
          options: ASK.options,
        },
      });
      expect(h.count("decision_claims")).toBe(1);
      // Unanswered, so the claim has nothing to satisfy yet.
      expect(await h.decisions.requirements(CLAIM)).toEqual(ok([]));
    });
  });

  it("answers a repeated requestId with the same question and records nothing more", async () => {
    await withDecisions(async (h) => {
      const first = await h.decisions.ask(h.agent(), CLAIM, ASK);
      // The claim moved on since, but a lost response must still be recoverable.
      h.holds(ok(null));
      const repeat = await h.decisions.ask(h.agent(), CLAIM, ASK);
      expect(repeat).toEqual(first);
      expect(types(h.events())).toEqual(["question.asked"]);

      const changed = await h.decisions.ask(h.agent(), CLAIM, { ...ASK, text: "Another?" });
      expect(changed).toMatchObject({ ok: false, code: "idempotency_mismatch" });
      // Keys are per agent: another agent's identical key is a new question, refused here only
      // because that agent holds no claim.
      expect(await h.decisions.ask(h.agent("agt_boreas1"), CLAIM, ASK)).toMatchObject({
        ok: false,
        code: "claim_closed",
      });
      expect(h.count("questions")).toBe(1);
    });
  });

  it("treats a retry with reordered or extra option fields as the same question", async () => {
    await withDecisions(async (h) => {
      // Field order and undeclared fields are the sender's serialization, not the question.
      const reordered: QuestionOption[] = ASK.options.map(({ key, label }) => {
        const option = { label, key, note: "not part of the question" };
        return option;
      });
      const first = await h.decisions.ask(h.agent(), CLAIM, { ...ASK, options: reordered });
      if (!first.ok) throw new Error(first.code);
      const repeat = await h.decisions.ask(h.agent(), CLAIM, ASK);
      expect(repeat).toEqual(first);
      expect(h.count("questions")).toBe(1);
      expect(h.count("decision_claims")).toBe(1);
      const events = h.events();
      expect(types(events)).toEqual(["question.asked"]);
      expect(events[0]).toMatchObject({ data: { options: ASK.options } });
      expect(events[0]?.type === "question.asked" && events[0].data.options).toEqual(ASK.options);

      // The options' order is part of the question.
      const reversed = await h.decisions.ask(h.agent(), CLAIM, {
        ...ASK,
        options: ASK.options.toReversed(),
      });
      expect(reversed).toMatchObject({ ok: false, code: "idempotency_mismatch" });
      expect(h.count("questions")).toBe(1);
    });
  });

  it("refuses invalid input and records nothing", async () => {
    await withDecisions(async (h) => {
      const [reject, chunk] = ASK.options;
      if (reject === undefined || chunk === undefined) throw new Error("fixture");
      const invalid: Array<[string, AskRequest]> = [
        [CLAIM, { ...ASK, options: [reject] }],
        [CLAIM, { ...ASK, options: [] }],
        [CLAIM, { ...ASK, options: [reject, reject] }],
        [CLAIM, { ...ASK, options: [{ key: "", label: "Empty" }, chunk] }],
        [CLAIM, { ...ASK, options: [{ key: "Reject", label: "Reject" }, chunk] }],
        [CLAIM, { ...ASK, options: [{ key: "reject", label: "  " }, chunk] }],
        [CLAIM, { ...ASK, text: "   " }],
        [CLAIM, { ...ASK, requestId: "upload" }],
        [CLAIM, { ...ASK, generation: 0 }],
        [CLAIM, { ...ASK, scope: [] }],
        [CLAIM, { ...ASK, scope: ["/src/upload.ts"] }],
        [CLAIM, { ...ASK, scope: ["src/../upload.ts"] }],
        // The inbox refuses blank scope text, so such a question could never be answered.
        [CLAIM, { ...ASK, scope: [" "] }],
        [CLAIM, { ...ASK, scope: ["src/upload.ts", "\t\uFEFF"] }],
        [CLAIM, { ...ASK, scope: Array.from({ length: 65 }, (_, i) => `src/f${i}.ts`) }],
        ["iss_issue001", ASK],
      ];
      for (const [claimId, request] of invalid) {
        expect(await h.decisions.ask(h.agent(), claimId, request)).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
      }
      expect(h.events()).toEqual([]);
      expect(h.count("questions")).toBe(0);
    });
  });

  it("refuses unless the caller holds the working claim at that generation", async () => {
    await withDecisions(async (h) => {
      const cases: Array<[PortResult<ClaimView | null>, AskRequest, string]> = [
        [ok(null), ASK, "claim_closed"],
        [ok(claimView({ claimId: "clm_claim002" })), ASK, "claim_closed"],
        [ok(claimView({ generation: 2 })), ASK, "stale_generation"],
        [ok(claimView()), { ...ASK, generation: 2 }, "invalid_request"],
        [ok(claimView({ state: "ready", readyCommit: "b".repeat(40) })), ASK, "claim_closed"],
        // A missing claims module is a refusal, never a pass.
        [unavailable("claims"), ASK, "unavailable"],
        [fail("internal", "Claims failed."), ASK, "internal"],
      ];
      for (const [answer, request, code] of cases) {
        h.holds(answer);
        expect(await h.decisions.ask(h.agent(), CLAIM, request)).toMatchObject({
          ok: false,
          code,
        });
      }
      const foreign = { ...h.agent(), repoId: "rep_elsewhere1" };
      expect(await h.decisions.ask(foreign, CLAIM, ASK)).toMatchObject({
        ok: false,
        code: "unauthenticated",
      });
      expect(h.events()).toEqual([]);
    });
  });

  it("allows MAX_QUESTIONS_PER_CLAIM questions per claim and refuses the next", async () => {
    expect(MAX_QUESTIONS_PER_CLAIM).toBe(MAX_LIST_LENGTH);
    await withDecisions(async (h) => {
      for (let i = 0; i < MAX_QUESTIONS_PER_CLAIM; i += 1) {
        await h.ask({ requestId: `req_upload${String(i).padStart(10, "0")}` });
      }
      const over = await h.decisions.ask(h.agent(), CLAIM, {
        ...ASK,
        requestId: "req_uploadover000001",
      });
      expect(over).toMatchObject({ ok: false, code: "quota_exceeded" });
      expect(h.count("questions")).toBe(MAX_QUESTIONS_PER_CLAIM);
      expect(h.events()).toHaveLength(MAX_QUESTIONS_PER_CLAIM);
    });
  });
});

describe("record", () => {
  it("records version 1 for a human grant and queues the asking agent's item atomically", async () => {
    await withDecisions(async (h) => {
      const { questionId, decisionId } = await h.ask();
      const recorded = await h.decisions.record(
        h.grant({ decisionId, option: "chunk", expectedVersion: null }),
      );
      expect(recorded).toEqual(ok({ decisionId, version: 1 }));

      const events = h.events();
      expect(types(events)).toEqual(["question.asked", "decision.recorded", "inbox.queued"]);
      expect(events[1]).toMatchObject({
        actor: { kind: "human", id: OWNER },
        data: {
          decisionId,
          version: 1,
          questionId,
          option: "chunk",
          supersedes: null,
          scope: ["src/upload.ts"],
        },
      });
      expect(events[2]).toMatchObject({
        data: {
          agentId: AGENT,
          claimId: CLAIM,
          entry: { kind: "decision", decision: { decisionId, version: 1 } },
        },
      });

      const expected: DecisionView = {
        decisionId,
        version: 1,
        supersedes: null,
        questionId,
        question: ASK.text,
        option: { key: "chunk", label: "Upload them in chunks" },
        previous: null,
        scope: ["src/upload.ts"],
        decidedBy: OWNER,
        decidedAt: NOW,
      };
      const page = await h.inbox.pending(h.agent(), MAX_INBOX_PAGE);
      expect(page.ok && page.value.items.map((item) => item.decision)).toEqual([expected]);
      // The item blocks the claim's ready gate until the agent acknowledges it.
      expect(await h.inbox.readyGate(CLAIM, 1)).toEqual(ok({ kind: "blocked", items: [1] }));
      expect(await h.decisions.question(h.agent(), questionId, 0)).toEqual(
        ok({ questionId, decisionId, state: "answered", decision: expected }),
      );
      expect(await h.decisions.requirements(CLAIM)).toEqual(ok([{ decisionId, version: 1 }]));
    });
  });

  it("delivers an answer whose scope path holds whitespace, as Git allows", async () => {
    await withDecisions(async (h) => {
      // Every scope `ask` accepts must reach the real inbox, or the question could never close.
      const scope = ["docs/ notes.md", " leading.ts"];
      const { decisionId } = await h.ask({ scope });
      const recorded = await h.decisions.record(
        h.grant({ decisionId, option: "reject", expectedVersion: null }),
      );
      expect(recorded).toEqual(ok({ decisionId, version: 1 }));
      const page = await h.inbox.pending(h.agent(), MAX_INBOX_PAGE);
      expect(page.ok && page.value.items.map((item) => item.decision?.scope)).toEqual([scope]);
    });
  });

  it("decides only with a person's grant for this repository and this action", async () => {
    await withDecisions(async (h) => {
      const { decisionId } = await h.ask();
      const valid = h.grant({ decisionId, option: "chunk", expectedVersion: null });
      // Shapes a caller could only produce by forging a grant; each must record nothing.
      const forged: unknown[] = [
        { ...valid, kind: "agent" },
        { ...valid, repoId: "rep_elsewhere1" },
        { ...valid, userId: AGENT },
        { ...valid, grantId: "" },
        { ...valid, action: { kind: "issue.file", title: "t", body: "" } },
        { ...valid, action: { ...valid.action, decisionId: "qst_question1" } },
        { ...valid, action: { ...valid.action, expectedVersion: 0 } },
      ];
      for (const grant of forged) {
        expect(await h.decisions.record(grant as GrantFor<"decision.record">)).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
      }
      expect(types(h.events())).toEqual(["question.asked"]);
      expect(h.count("decision_versions")).toBe(0);
    });
  });

  it("refuses an empty, malformed or unoffered option and records nothing", async () => {
    await withDecisions(async (h) => {
      const { decisionId } = await h.ask();
      for (const option of ["", "Chunk", "maybe"]) {
        expect(
          await h.decisions.record(h.grant({ decisionId, option, expectedVersion: null })),
        ).toMatchObject({ ok: false, code: "invalid_request" });
      }
      expect(
        await h.decisions.record(
          h.grant({ decisionId: "dec_unknown001", option: "chunk", expectedVersion: null }),
        ),
      ).toMatchObject({ ok: false, code: "not_found" });
      expect(types(h.events())).toEqual(["question.asked"]);
      expect(h.count("decision_versions")).toBe(0);
    });
  });

  it("never records a second version for a repeated or stale request", async () => {
    await withDecisions(async (h) => {
      const { decisionId } = await h.ask();
      const grant = h.grant({ decisionId, option: "chunk", expectedVersion: null });
      expect(await h.decisions.record(grant)).toEqual(ok({ decisionId, version: 1 }));
      // A lost response retried with the same proof returns the version it recorded.
      expect(await h.decisions.record(grant)).toEqual(ok({ decisionId, version: 1 }));
      // The same proof cannot be spent on another answer.
      expect(
        await h.decisions.record({ ...grant, action: { ...grant.action, option: "reject" } }),
      ).toMatchObject({ ok: false, code: "invalid_request" });
      // A second proof prepared against no answer, or a version that does not exist, is stale.
      for (const expectedVersion of [null, 2]) {
        expect(
          await h.decisions.record(
            h.grant({ decisionId, option: "reject", expectedVersion }, "chl_grant0002"),
          ),
        ).toMatchObject({ ok: false, code: "action_stale" });
      }
      // Replacing the current answer belongs to supersession, which is not installed.
      expect(
        await h.decisions.record(
          h.grant({ decisionId, option: "reject", expectedVersion: 1 }, "chl_grant0003"),
        ),
      ).toMatchObject({ ok: false, code: "unavailable" });

      expect(types(h.events())).toEqual(["question.asked", "decision.recorded", "inbox.queued"]);
      expect(h.count("decision_versions")).toBe(1);
    });
  });

  it("rolls back the version and every queued item when the fanout fails", async () => {
    await withDecisions(async (h) => {
      const { questionId, decisionId } = await h.ask();
      // Queues the real item, then fails, as a later target in the same fanout would.
      h.useInbox({
        ...h.inbox,
        queue: (tx, target, item) => {
          h.inbox.queue(tx, target, item);
          throw new Error("the next target is not valid");
        },
      });
      const grant = h.grant({ decisionId, option: "chunk", expectedVersion: null });
      await expect(h.decisions.record(grant)).rejects.toThrow("the next target is not valid");

      expect(types(h.events())).toEqual(["question.asked"]);
      expect(h.count("decision_versions")).toBe(0);
      expect(await h.inbox.pending(h.agent(), MAX_INBOX_PAGE)).toEqual(
        ok({ items: [], pending: 0 }),
      );
      expect(await h.decisions.question(h.agent(), questionId, 0)).toMatchObject({
        ok: true,
        value: { state: "open", decision: null },
      });

      // A missing inbox module refuses rather than recording a decision nobody receives.
      h.useInbox(unavailableInbox);
      expect(await h.decisions.record(grant)).toEqual(unavailable("inbox"));
      expect(h.count("decision_versions")).toBe(0);

      // Once the inbox works, the same proof records version 1 and its item together.
      h.useInbox(h.inbox);
      expect(await h.decisions.record(grant)).toEqual(ok({ decisionId, version: 1 }));
      expect(types(h.events())).toEqual(["question.asked", "decision.recorded", "inbox.queued"]);
    });
  });
});

describe("question", () => {
  it("wakes a long poll when the answer is recorded", async () => {
    await withDecisions(async (h) => {
      const { questionId, decisionId } = await h.ask();
      const started = Date.now();
      const polled = h.decisions.question(h.agent(), questionId, MAX_LONG_POLL_MS);
      await h.decisions.record(h.grant({ decisionId, option: "reject", expectedVersion: null }));
      const answered = await polled;
      expect(answered).toMatchObject({
        ok: true,
        value: { state: "answered", decision: { version: 1, option: { key: "reject" } } },
      });
      expect(Date.now() - started).toBeLessThan(MAX_LONG_POLL_MS);
    });
  });

  it("returns open when the wait passes without an answer", async () => {
    await withDecisions(async (h) => {
      const { questionId } = await h.ask();
      expect(await h.decisions.question(h.agent(), questionId, 20)).toMatchObject({
        ok: true,
        value: { questionId, state: "open", decision: null },
      });
    });
  });

  it("hides another agent's question and refuses an invalid wait or id", async () => {
    await withDecisions(async (h) => {
      const { questionId } = await h.ask();
      expect(await h.decisions.question(h.agent("agt_boreas1"), questionId, 0)).toMatchObject({
        ok: false,
        code: "not_found",
      });
      for (const [id, waitMs] of [
        [questionId, -1],
        [questionId, MAX_LONG_POLL_MS + 1],
        [questionId, 1.5],
        ["dec_question1", 0],
      ] as const) {
        expect(await h.decisions.question(h.agent(), id, waitMs)).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
      }
      expect(types(h.events())).toEqual(["question.asked"]);
    });
  });
});

describe("requirements and currentVersions", () => {
  it("read the current version inside a transaction and refuse a non-claim id", async () => {
    await withDecisions(async (h) => {
      const { decisionId } = await h.ask();
      expect(h.log.transaction(() => h.decisions.currentVersions(CLAIM)).value).toEqual([]);
      await h.decisions.record(h.grant({ decisionId, option: "chunk", expectedVersion: null }));
      expect(h.log.transaction(() => h.decisions.currentVersions(CLAIM)).value).toEqual([
        { decisionId, version: 1 },
      ]);
      expect(h.decisions.currentVersions("clm_claim002")).toEqual([]);
      expect(h.decisions.currentVersions("iss_issue001")).toBeNull();
      expect(await h.decisions.requirements("iss_issue001")).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
    });
  });

  it("keep questions and versions across eviction of the Repo", async () => {
    const repo = await freshRepo();
    const asked = await withDecisions(async (h) => h.ask(), repo);
    await evictDurableObject(repo.stub);
    await withDecisions(async (h) => {
      // The asking claim was recorded before the eviction, so the fanout still reaches it.
      h.holds(ok(null));
      expect(
        await h.decisions.record(
          h.grant({ decisionId: asked.decisionId, option: "chunk", expectedVersion: null }),
        ),
      ).toEqual(ok({ decisionId: asked.decisionId, version: 1 }));
      expect(await h.decisions.requirements(CLAIM)).toEqual(
        ok([{ decisionId: asked.decisionId, version: 1 }]),
      );
      expect(await h.inbox.readyGate(CLAIM, 1)).toEqual(ok({ kind: "blocked", items: [1] }));
    }, repo);
  });
});
