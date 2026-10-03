import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_INBOX_PAGE, type AskRequest, type ClaimView } from "@railhead/shared/agent-api";
import {
  MAX_LIST_LENGTH,
  type DecisionRef,
  type InboxEntry,
  type RailheadEvent,
} from "@railhead/shared/events";
import type { DecisionObligation } from "../src/contracts/decisions";
import type { InboxPort, InboxTarget } from "../src/contracts/inbox";
import type { AgentPrincipal, GrantFor } from "../src/contracts/principals";
import { ok, unavailable, type PortResult } from "../src/contracts/result";
import type { AuthorizationPort, CheckAttempt } from "../src/contracts/train";
import { unavailableClaims, unavailableInbox } from "../src/contracts/unavailable";
import {
  createDecisions,
  DecisionsWriteError,
  type Decisions,
} from "../src/modules/decisions/decisions";
import { createInbox } from "../src/modules/inbox/inbox";
import { composeRepo, type RepoPorts } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName, type Repo } from "../src/repo/RepoObject";
import { createAuthorization } from "../src/train/authorize";

const NOW = 1_790_000_000_000;
const CLAIM = "clm_claim001";
const ATLAS = "agt_atlas01";
const BOREAS = "agt_boreas1";
const OWNER = "usr_lemarier";
const COMMIT = "b".repeat(40);
const MAIN = "a".repeat(40);
const CANDIDATE = "c".repeat(40);

const clock = (): number => NOW;

const ASK: AskRequest = {
  generation: 1,
  requestId: "req_upload0000000001",
  text: "Should uploads above 10 MB be rejected or chunked?",
  options: [
    { key: "reject", label: "Reject them" },
    { key: "chunk", label: "Upload them in chunks" },
    { key: "stream", label: "Stream them" },
  ],
  scope: ["src/upload.ts"],
};

const WORKING: ClaimView = {
  claimId: CLAIM,
  issueId: "iss_issue001",
  generation: 1,
  base: MAIN,
  state: "working",
  readyCommit: null,
  originUrl: "",
  upstreamUrl: "",
  task: { title: "Upload", body: "" },
};

interface Harness {
  decisions: Decisions;
  inbox: InboxPort;
  log: EventLog;
  ports: () => RepoPorts;
  storage: DurableObjectStorage;
  agent(id?: string): AgentPrincipal;
  /** Records `option` as the next version of `decisionId`, expecting `expected` to be current. */
  record(
    decisionId: string,
    option: string,
    expected: number | null,
    grantId?: string,
  ): Promise<PortResult<{ decisionId: string; version: number }>>;
  /** Sets the claim's current generation as the claims module's fence reader reports it. */
  generation(current: number | null): void;
  /** Replaces the inbox the decisions module queues through. */
  useInbox(inbox: InboxPort): void;
  /** Asks `ASK` as ATLAS on CLAIM at generation 1 and returns the decision id. */
  ask(): Promise<string>;
  /** Runs `transfer` in its own transaction and returns the events it appended. */
  transfer(target: InboxTarget): RailheadEvent[];
  /** Runs `relied` in its own transaction and returns the events it appended. */
  relied(refs: DecisionRef[], generation?: number, claimId?: string): RailheadEvent[];
  /** Reads the obligations inside a transaction, as a caller must. */
  obligations(claimId?: string): DecisionObligation[] | null;
  /** The inbox entries an agent has pending, oldest first. */
  entries(agentId: string): Promise<{ item: number; entry: InboxEntry; version: number }[]>;
  events(): RailheadEvent[];
  count(table: "decision_versions" | "decision_obligations" | "inbox_items" | "landings"): number;
}

async function freshRepo(): Promise<{ stub: DurableObjectStub<Repo>; repoId: string }> {
  const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const stub = env.REPO.getByName(repoObjectName("acme", name));
  const summary = await stub.initialize("acme", name);
  if (!summary.ok) throw new Error(summary.code);
  return { stub, repoId: summary.value.repoId };
}

/**
 * Runs `body` against a repository's decisions module with the real inbox, and a claims module
 * where ATLAS holds CLAIM at generation 1 for `ask`, and whose fence reader the test moves.
 */
async function withDecisions<R>(
  body: (harness: Harness) => Promise<R>,
  repo?: { stub: DurableObjectStub<Repo>; repoId: string },
): Promise<R> {
  const { stub, repoId } = repo ?? (await freshRepo());
  return runInDurableObject(stub, async (_instance, state) => {
    const log = EventLog.open(state.storage, repoId, clock);
    const context = { repoId, storage: state.storage, log, clock, env, wake: async () => true };
    const composed = composeRepo(context);
    const realInbox = createInbox(context);
    let inbox: InboxPort = realInbox;
    let current: number | null = 1;
    const ports = (): RepoPorts => ({
      ...composed,
      claims: {
        ...unavailableClaims,
        activeClaim: async () => ok(WORKING),
        currentGeneration: (claimId) => (claimId === CLAIM ? current : null),
      },
      inbox,
    });
    const decisions = createDecisions(context, ports);
    const agent = (id = ATLAS): AgentPrincipal => ({
      kind: "agent",
      agentId: id,
      ownerId: OWNER,
      repoId,
    });
    const harness: Harness = {
      decisions,
      inbox: realInbox,
      log,
      ports,
      storage: state.storage,
      agent,
      record: (
        decisionId,
        option,
        expectedVersion,
        grantId = `chl_${option}${expectedVersion}`,
      ) => {
        const grant: GrantFor<"decision.record"> = {
          kind: "human",
          userId: OWNER,
          repoId,
          grantId,
          action: { kind: "decision.record", decisionId, option, expectedVersion },
        };
        return decisions.record(grant);
      },
      generation: (next) => {
        current = next;
      },
      useInbox: (replacement) => {
        inbox = replacement;
      },
      ask: async () => {
        const asked = await decisions.ask(agent(), CLAIM, ASK);
        if (!asked.ok) throw new Error(`ask failed: ${asked.code}`);
        return asked.value.decisionId;
      },
      transfer: (target) => log.transaction((tx) => decisions.transfer(tx, target)).events,
      relied: (refs, generation = 1, claimId = CLAIM) =>
        log.transaction((tx) => decisions.relied(tx, claimId, generation, refs)).events,
      obligations: (claimId = CLAIM) => log.transaction(() => decisions.obligations(claimId)).value,
      entries: async (agentId) => {
        const page = await realInbox.pending(agent(agentId), MAX_INBOX_PAGE);
        if (!page.ok) throw new Error(page.code);
        return page.value.items.map((item) => ({
          item: item.item,
          entry: item.entry,
          version: item.decision?.version ?? 0,
        }));
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

function entry(kind: "decision" | "rework", decisionId: string, version: number): InboxEntry {
  return { kind, decision: { decisionId, version } };
}

/** Asks, records version 1 and returns the decision id. ATLAS's item 1 carries version 1. */
async function answered(h: Harness, option = "chunk"): Promise<string> {
  const decisionId = await h.ask();
  expect(await h.record(decisionId, option, null)).toEqual(ok({ decisionId, version: 1 }));
  return decisionId;
}

describe("supersession", () => {
  it("records version 2 over version 1 and delivers it to the claim's holder", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      expect(await h.record(decisionId, "reject", 1)).toEqual(ok({ decisionId, version: 2 }));

      const events = h.events();
      expect(types(events)).toEqual([
        "question.asked",
        "decision.recorded",
        "inbox.queued",
        "decision.recorded",
        "inbox.queued",
      ]);
      expect(events[3]).toMatchObject({
        actor: { kind: "human", id: OWNER },
        data: { decisionId, version: 2, option: "reject", supersedes: 1 },
      });
      const page = await h.inbox.pending(h.agent(), MAX_INBOX_PAGE);
      expect(page.ok && page.value.items[1]).toMatchObject({
        item: 2,
        entry: entry("decision", decisionId, 2),
        decision: {
          version: 2,
          supersedes: 1,
          option: { key: "reject", label: "Reject them" },
          previous: { key: "chunk", label: "Upload them in chunks" },
        },
      });
      // The claim must satisfy version 2 now, and ready stays blocked until both are acknowledged.
      expect(await h.decisions.requirements(CLAIM)).toEqual(ok([{ decisionId, version: 2 }]));
      expect(await h.inbox.readyGate(CLAIM, 1)).toEqual(ok({ kind: "blocked", items: [1, 2] }));
      // Only the latest obligation of each kind is outstanding.
      expect(h.obligations()).toEqual([
        {
          claimId: CLAIM,
          decision: { decisionId, version: 2 },
          kind: "decision",
          delivery: { agentId: ATLAS, item: 2 },
          recordedAt: NOW,
        },
      ]);
    });
  });

  it("refuses a stale expected version or the option already chosen, recording nothing", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      for (const expected of [null, 2]) {
        expect(await h.record(decisionId, "reject", expected, "chl_stale0001")).toMatchObject({
          ok: false,
          code: "action_stale",
        });
      }
      expect(await h.record(decisionId, "chunk", 1)).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(await h.record(decisionId, "unoffered", 1)).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(h.count("decision_versions")).toBe(1);
      expect(h.count("decision_obligations")).toBe(1);
      expect(types(h.events())).toEqual(["question.asked", "decision.recorded", "inbox.queued"]);
    });
  });

  it("records each later version once, each superseding the one before", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      const grant = "chl_second0001";
      expect(await h.record(decisionId, "reject", 1, grant)).toEqual(
        ok({ decisionId, version: 2 }),
      );
      // A lost response retried with the same proof returns version 2 and queues nothing more.
      expect(await h.record(decisionId, "reject", 1, grant)).toEqual(
        ok({ decisionId, version: 2 }),
      );
      expect(await h.record(decisionId, "stream", 2)).toEqual(ok({ decisionId, version: 3 }));

      const recorded = h.events().filter((event) => event.type === "decision.recorded");
      expect(recorded.map((event) => event.data)).toMatchObject([
        { version: 1, supersedes: null },
        { version: 2, supersedes: 1 },
        { version: 3, supersedes: 2 },
      ]);
      expect((await h.entries(ATLAS)).map(({ item, version }) => [item, version])).toEqual([
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      expect(h.obligations()?.map((owed) => owed.decision.version)).toEqual([3]);
    });
  });

  it("rolls back the whole version when its fanout fails, and records it once on retry", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      h.useInbox({
        ...h.inbox,
        queue: (tx, target, item) => {
          h.inbox.queue(tx, target, item);
          throw new Error("the inbox refused the item");
        },
      });
      await expect(h.record(decisionId, "reject", 1)).rejects.toThrow("the inbox refused the item");
      h.useInbox(unavailableInbox);
      expect(await h.record(decisionId, "reject", 1)).toEqual(unavailable("inbox"));

      expect(h.count("decision_versions")).toBe(1);
      expect(h.count("decision_obligations")).toBe(1);
      expect(await h.entries(ATLAS)).toHaveLength(1);
      expect(await h.decisions.requirements(CLAIM)).toEqual(ok([{ decisionId, version: 1 }]));

      h.useInbox(h.inbox);
      expect(await h.record(decisionId, "reject", 1)).toEqual(ok({ decisionId, version: 2 }));
      expect((await h.entries(ATLAS)).map(({ version }) => version)).toEqual([1, 2]);
    });
  });
});

function attempt(decisions: DecisionRef[]): CheckAttempt {
  return {
    attemptId: "chk_attempt01",
    expectedMain: MAIN,
    candidate: CANDIDATE,
    pins: [{ claimId: CLAIM, generation: 1, commit: COMMIT, episode: 1 }],
    definition: { name: "upload", source: MAIN, digest: "d".repeat(64), acceptance: null },
    decisions,
    createdAt: NOW - 60_000,
  };
}

function authorizer(h: Harness, scheduled: CheckAttempt): AuthorizationPort {
  return createAuthorization(
    { storage: h.storage, log: h.log, clock },
    {
      attemptOutcome: (attemptId) =>
        attemptId === scheduled.attemptId
          ? {
              attempt: scheduled,
              report: {
                attemptId: scheduled.attemptId,
                candidate: scheduled.candidate,
                result: "pass",
                logDigest: null,
                finishedAt: NOW,
              },
            }
          : null,
      currentGeneration: (claimId) => h.ports().claims.currentGeneration(claimId),
      currentVersions: (claimId) => h.decisions.currentVersions(claimId),
      // Each pin is ready under the versions the check was scheduled under.
      readyPin: (claimId) => {
        const pin = scheduled.pins.find((scheduledPin) => scheduledPin.claimId === claimId);
        return pin === undefined ? null : { pin, episode: 1, decisions: scheduled.decisions };
      },
      // Each pin was marked ready once its holder had acknowledged, as `ready` requires.
      readyGateNow: () => ({ kind: "clear" }),
    },
    () => "int_intent01",
  );
}

describe("authorization across a change", () => {
  it("refuses to authorize a check scheduled under the version a change replaced", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      const port = authorizer(h, attempt([{ decisionId, version: 1 }]));
      // The person changes the answer while the check runs.
      expect(await h.record(decisionId, "reject", 1)).toEqual(ok({ decisionId, version: 2 }));
      const head = h.log.head();

      expect(await port.authorize("chk_attempt01")).toMatchObject({
        ok: false,
        code: "decision_superseded",
      });
      expect(h.log.head()).toBe(head);
      expect(await port.intent("int_intent01")).toMatchObject({ ok: false, code: "not_found" });
    });
  });

  it("makes work authorized under version 1 rework when version 2 is recorded", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      const port = authorizer(h, attempt([{ decisionId, version: 1 }]));
      const intent = await port.authorize("chk_attempt01");
      if (!intent.ok) throw new Error(intent.code);
      // The transaction that authorizes the merge records what the work relied on.
      expect(h.relied(intent.value.decisions)).toEqual([]);
      expect(h.obligations()?.map((owed) => owed.kind)).toEqual(["decision"]);

      expect(await h.record(decisionId, "reject", 1)).toEqual(ok({ decisionId, version: 2 }));
      expect((await h.entries(ATLAS)).map((item) => item.entry)).toEqual([
        entry("decision", decisionId, 1),
        entry("rework", decisionId, 2),
      ]);
      expect(h.obligations()).toMatchObject([
        {
          decision: { decisionId, version: 1 },
          kind: "decision",
          delivery: { agentId: ATLAS, item: 1 },
        },
        {
          decision: { decisionId, version: 2 },
          kind: "rework",
          delivery: { agentId: ATLAS, item: 2 },
        },
      ]);
    });
  });

  it("keeps rework of merged work pending when no one holds the claim, sending nothing", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      h.relied([{ decisionId, version: 1 }]);
      // The work merged: the claim has no holder.
      h.generation(null);
      expect(await h.record(decisionId, "reject", 1)).toEqual(ok({ decisionId, version: 2 }));

      expect(types(h.events()).slice(-1)).toEqual(["decision.recorded"]);
      expect(await h.entries(ATLAS)).toHaveLength(1);
      expect(h.obligations()).toMatchObject([
        {
          decision: { decisionId, version: 1 },
          kind: "decision",
          delivery: { agentId: ATLAS, item: 1 },
        },
        { decision: { decisionId, version: 2 }, kind: "rework", delivery: null },
      ]);
    });
  });
});

describe("relied", () => {
  it("records rework at once when the work landed under a version already replaced", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      expect(await h.record(decisionId, "reject", 1)).toEqual(ok({ decisionId, version: 2 }));
      // An intent authorized under version 1 lands after version 2 was recorded.
      const events = h.relied([{ decisionId, version: 1 }]);
      expect(types(events)).toEqual(["inbox.queued"]);
      expect(events[0]).toMatchObject({
        data: { agentId: ATLAS, entry: entry("rework", decisionId, 2) },
      });
      // A repeat, or relying on version 1 again on landing, owes nothing more.
      expect(h.relied([{ decisionId, version: 1 }])).toEqual([]);
      expect(h.count("decision_obligations")).toBe(3);
    });
  });

  it("owes nothing for the current version and ignores other claims' decisions", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      expect(
        h.relied([
          { decisionId, version: 1 },
          { decisionId: "dec_otherclaim", version: 7 },
        ]),
      ).toEqual([]);
      expect(h.relied([])).toEqual([]);
      expect(h.count("decision_obligations")).toBe(1);
      // A full list of decisions this claim does not depend on is accepted and records nothing.
      const refs = Array.from({ length: MAX_LIST_LENGTH }, (_, n) => ({
        decisionId: `dec_other${String(n).padStart(4, "0")}`,
        version: 1,
      }));
      expect(h.relied(refs)).toEqual([]);
    });
  });

  it("sends rework of work landed after a takeover to the successor, once", async () => {
    const repo = await freshRepo();
    const decisionId = await withDecisions(async (h) => {
      const id = await answered(h);
      // BOREAS takes the claim over at generation 2 before ATLAS's work lands.
      h.generation(2);
      h.transfer({ agentId: BOREAS, claimId: CLAIM, generation: 2 });
      expect(await h.record(id, "reject", 1)).toEqual(ok({ decisionId: id, version: 2 }));
      // Nothing was relied on yet, so BOREAS gets plain decisions and acknowledges both.
      expect(await h.entries(BOREAS)).toMatchObject([
        { item: 1, entry: entry("decision", id, 1) },
        { item: 2, entry: entry("decision", id, 2) },
      ]);
      for (const item of [1, 2]) {
        expect(await h.inbox.ack(h.agent(BOREAS), item, "Reject uploads.")).toMatchObject({
          ok: true,
        });
      }
      expect(await h.inbox.readyGate(CLAIM, 2)).toEqual(ok({ kind: "clear" }));

      // ATLAS's work, done under version 1 at generation 1, lands now.
      const events = h.relied([{ decisionId: id, version: 1 }], 1);
      expect(events.map((event) => event.data)).toMatchObject([
        { agentId: BOREAS, claimId: CLAIM, entry: entry("rework", id, 2) },
      ]);
      expect(await h.entries(BOREAS)).toMatchObject([{ item: 3, entry: entry("rework", id, 2) }]);
      expect(await h.entries(ATLAS)).toHaveLength(1);
      expect(await h.inbox.readyGate(CLAIM, 2)).toEqual(ok({ kind: "blocked", items: [3] }));
      expect(h.obligations()).toContainEqual(
        expect.objectContaining({ kind: "rework", delivery: { agentId: BOREAS, item: 3 } }),
      );
      // A retried landing owes nothing more.
      expect(h.relied([{ decisionId: id, version: 1 }], 1)).toEqual([]);
      return id;
    }, repo);
    await evictDurableObject(repo.stub);

    await withDecisions(async (h) => {
      h.generation(2);
      expect(h.relied([{ decisionId, version: 1 }], 1)).toEqual([]);
      expect(h.count("decision_obligations")).toBe(3);
      expect(await h.entries(BOREAS)).toMatchObject([
        { item: 3, entry: entry("rework", decisionId, 2) },
      ]);
      expect(await h.inbox.ack(h.agent(BOREAS), 3, "Redo it with rejects.")).toMatchObject({
        ok: true,
      });
      expect(await h.inbox.readyGate(CLAIM, 2)).toEqual(ok({ kind: "clear" }));
      expect(await h.entries(ATLAS)).toHaveLength(1);
    }, repo);
  });

  it("holds rework landed before the takeover moves the dependency, for transfer to send", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      // BOREAS holds generation 2, but the takeover has not moved the dependency yet.
      h.generation(2);
      expect(await h.record(decisionId, "reject", 1)).toEqual(ok({ decisionId, version: 2 }));
      expect(h.relied([{ decisionId, version: 1 }], 1)).toEqual([]);
      expect(h.obligations()).toContainEqual(
        expect.objectContaining({ kind: "rework", delivery: null }),
      );

      const events = h.transfer({ agentId: BOREAS, claimId: CLAIM, generation: 2 });
      expect(events.map((event) => event.data)).toMatchObject([
        { agentId: BOREAS, entry: entry("rework", decisionId, 2) },
      ]);
      expect(await h.entries(ATLAS)).toHaveLength(1);
    });
  });

  it("rolls back reliance with the caller's landing when rework fails, and owes it once on retry", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      expect(await h.record(decisionId, "reject", 1)).toEqual(ok({ decisionId, version: 2 }));
      // The caller's own state change, made in the same transaction as the landing.
      h.storage.sql.exec("CREATE TABLE landings (claim_id TEXT NOT NULL)");
      const land = (): RailheadEvent[] =>
        h.log.transaction((tx) => {
          tx.sql.exec("INSERT INTO landings (claim_id) VALUES (?)", CLAIM);
          h.decisions.relied(tx, CLAIM, 1, [{ decisionId, version: 1 }]);
        }).events;
      const relied = (): Array<{ relied: number | null }> =>
        h.storage.sql
          .exec<{ relied: number | null }>(
            "SELECT relied FROM decision_claims WHERE decision_id = ? AND claim_id = ?",
            decisionId,
            CLAIM,
          )
          .toArray();
      const head = h.log.head();
      const obligations = h.obligations();
      expect(relied()).toEqual([{ relied: null }]);
      expect(h.count("inbox_items")).toBe(2);
      expect(h.count("decision_obligations")).toBe(2);

      // The inbox writes the rework item, then fails.
      h.useInbox({
        ...h.inbox,
        queue: (tx, target, item) => {
          h.inbox.queue(tx, target, item);
          throw new Error("the inbox refused the item");
        },
      });
      expect(land).toThrow("the inbox refused the item");
      expect(h.count("landings")).toBe(0);
      expect(relied()).toEqual([{ relied: null }]);
      expect(h.obligations()).toEqual(obligations);
      expect(h.count("decision_obligations")).toBe(2);
      expect(h.count("inbox_items")).toBe(2);
      expect(h.log.head()).toBe(head);

      h.useInbox(h.inbox);
      expect(land().map((event) => event.data)).toMatchObject([
        { agentId: ATLAS, entry: entry("rework", decisionId, 2) },
      ]);
      expect(h.count("landings")).toBe(1);
      expect(relied()).toEqual([{ relied: 1 }]);
      expect(h.obligations()).toContainEqual(
        expect.objectContaining({
          decision: { decisionId, version: 2 },
          kind: "rework",
          delivery: { agentId: ATLAS, item: 3 },
        }),
      );
      // A repeated landing owes nothing more.
      expect(land()).toEqual([]);
      expect(h.count("decision_obligations")).toBe(3);
      expect((await h.entries(ATLAS)).map((item) => item.entry)).toEqual([
        entry("decision", decisionId, 1),
        entry("decision", decisionId, 2),
        entry("rework", decisionId, 2),
      ]);
    });
  });

  it("refuses invalid arguments and a version never recorded, writing nothing", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      const tooMany = Array.from({ length: MAX_LIST_LENGTH + 1 }, (_, n) => ({
        decisionId: `dec_other${String(n).padStart(4, "0")}`,
        version: 1,
      }));
      const cases: Array<[DecisionRef[], number, string]> = [
        [[{ decisionId, version: 1 }], 1, "iss_issue001"],
        [[{ decisionId, version: 1 }], 0, CLAIM],
        [[{ decisionId, version: 1 }], 1.5, CLAIM],
        [[{ decisionId: "qst_question1", version: 1 }], 1, CLAIM],
        [[{ decisionId, version: 0 }], 1, CLAIM],
        [
          [
            { decisionId, version: 1 },
            { decisionId, version: 1 },
          ],
          1,
          CLAIM,
        ],
        [tooMany, 1, CLAIM],
        // The claim is held at generation 1; work cannot land under generation 2.
        [[{ decisionId, version: 1 }], 2, CLAIM],
        // Version 2 was never recorded.
        [[{ decisionId, version: 2 }], 1, CLAIM],
      ];
      const head = h.log.head();
      for (const [refs, generation, claimId] of cases) {
        expect(() => h.relied(refs, generation, claimId)).toThrow(DecisionsWriteError);
      }
      expect(h.log.head()).toBe(head);
      // Nothing was relied on, so version 2 is a plain decision, not rework.
      expect(await h.record(decisionId, "reject", 1)).toEqual(ok({ decisionId, version: 2 }));
      expect((await h.entries(ATLAS)).map((item) => item.entry.kind)).toEqual([
        "decision",
        "decision",
      ]);
    });
  });
});

describe("transfer", () => {
  it("delivers a version recorded after takeover to the new holder, never the former one", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      // BOREAS took the claim over at generation 2; its dependency was not transferred yet.
      h.generation(2);
      expect(await h.record(decisionId, "reject", 1)).toEqual(ok({ decisionId, version: 2 }));
      expect(await h.entries(ATLAS)).toHaveLength(1);
      expect(h.obligations()).toMatchObject([
        { decision: { decisionId, version: 2 }, kind: "decision", delivery: null },
      ]);

      const events = h.transfer({ agentId: BOREAS, claimId: CLAIM, generation: 2 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "inbox.queued",
        data: { agentId: BOREAS, claimId: CLAIM, entry: entry("decision", decisionId, 2) },
      });
      expect(await h.entries(BOREAS)).toMatchObject([{ item: 1, version: 2 }]);
      expect(await h.inbox.readyGate(CLAIM, 2)).toEqual(ok({ kind: "blocked", items: [1] }));
      expect(h.obligations()).toMatchObject([
        {
          decision: { decisionId, version: 2 },
          kind: "decision",
          delivery: { agentId: BOREAS, item: 1 },
        },
      ]);
      // A repeated takeover call queues nothing, and the next version reaches BOREAS directly.
      expect(h.transfer({ agentId: BOREAS, claimId: CLAIM, generation: 2 })).toEqual([]);
      expect(await h.record(decisionId, "stream", 2)).toEqual(ok({ decisionId, version: 3 }));
      expect((await h.entries(BOREAS)).map(({ version }) => version)).toEqual([2, 3]);
      expect(await h.entries(ATLAS)).toHaveLength(1);
    });
  });

  it("gives the successor the current version even when nothing changed at takeover", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      h.generation(2);
      const events = h.transfer({ agentId: BOREAS, claimId: CLAIM, generation: 2 });
      expect(events.map((event) => event.data)).toMatchObject([
        { agentId: BOREAS, entry: entry("decision", decisionId, 1) },
      ]);
      expect(h.obligations()).toMatchObject([
        {
          decision: { decisionId, version: 1 },
          kind: "decision",
          delivery: { agentId: BOREAS, item: 1 },
        },
      ]);
      // ATLAS's earlier delivery of version 1 is replaced here, and kept by the event log.
      expect(
        h.events().filter((event) => event.type === "inbox.queued" && event.data.agentId === ATLAS),
      ).toHaveLength(1);
    });
  });

  it("hands pending rework of an absent owner's work to the successor as rework", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      h.relied([{ decisionId, version: 1 }]);
      // ATLAS's lease expired with the work authorized; nobody holds the claim.
      h.generation(null);
      expect(await h.record(decisionId, "reject", 1)).toEqual(ok({ decisionId, version: 2 }));
      expect(await h.record(decisionId, "stream", 2)).toEqual(ok({ decisionId, version: 3 }));

      h.generation(2);
      const events = h.transfer({ agentId: BOREAS, claimId: CLAIM, generation: 2 });
      expect(events.map((event) => event.data)).toMatchObject([
        { agentId: BOREAS, entry: entry("rework", decisionId, 3) },
      ]);
      // Version 3 subsumes version 2's pending rework: both are delivered by BOREAS's one item.
      expect(
        h.storage.sql
          .exec<{ version: number; agent_id: string | null; item: number | null }>(
            `SELECT version, agent_id, item FROM decision_obligations
             WHERE kind = 'rework' ORDER BY version`,
          )
          .toArray(),
      ).toEqual([
        { version: 2, agent_id: BOREAS, item: 1 },
        { version: 3, agent_id: BOREAS, item: 1 },
      ]);
      expect(await h.entries(ATLAS)).toHaveLength(1);
    });
  });

  it("refuses an invalid target or one that is not the current holder, writing nothing", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      h.generation(2);
      expect(await h.record(decisionId, "reject", 1)).toEqual(ok({ decisionId, version: 2 }));
      const head = h.log.head();
      const targets: InboxTarget[] = [
        { agentId: "usr_lemarier", claimId: CLAIM, generation: 2 },
        { agentId: BOREAS, claimId: "iss_issue001", generation: 2 },
        { agentId: BOREAS, claimId: CLAIM, generation: 0 },
        // Generation 3 is not current, nor is the generation ATLAS held it at.
        { agentId: BOREAS, claimId: CLAIM, generation: 3 },
        { agentId: ATLAS, claimId: CLAIM, generation: 1 },
      ];
      for (const target of targets) {
        expect(() => h.transfer(target)).toThrow(DecisionsWriteError);
      }
      // A claim nobody holds has no one to transfer to.
      h.generation(null);
      expect(() => h.transfer({ agentId: BOREAS, claimId: CLAIM, generation: 2 })).toThrow(
        DecisionsWriteError,
      );
      expect(h.log.head()).toBe(head);
      expect(h.obligations()).toMatchObject([{ delivery: null }]);
    });
  });

  it("rolls back the move with the caller's transaction when the inbox refuses", async () => {
    await withDecisions(async (h) => {
      const decisionId = await answered(h);
      h.generation(2);
      h.useInbox(unavailableInbox);
      expect(() => h.transfer({ agentId: BOREAS, claimId: CLAIM, generation: 2 })).toThrow(
        "The inbox module is not available.",
      );
      h.useInbox(h.inbox);
      // The dependency did not move, so the retry delivers the current version once.
      const events = h.transfer({ agentId: BOREAS, claimId: CLAIM, generation: 2 });
      expect(events.map((event) => event.data)).toMatchObject([
        { agentId: BOREAS, entry: entry("decision", decisionId, 1) },
      ]);
    });
  });
});

describe("obligations", () => {
  it("answers null for a non-claim id and nothing for a claim without dependencies", async () => {
    await withDecisions(async (h) => {
      await answered(h);
      expect(h.obligations("iss_issue001")).toBeNull();
      expect(h.obligations("")).toBeNull();
      expect(h.obligations("clm_unknown01")).toEqual([]);
    });
  });

  it("survive eviction, and neither a retried record nor transfer duplicates them", async () => {
    const repo = await freshRepo();
    const decisionId = await withDecisions(async (h) => {
      const id = await answered(h);
      h.relied([{ decisionId: id, version: 1 }]);
      h.generation(null);
      expect(await h.record(id, "reject", 1, "chl_change0001")).toEqual(
        ok({ decisionId: id, version: 2 }),
      );
      return id;
    }, repo);
    await evictDurableObject(repo.stub);

    await withDecisions(async (h) => {
      h.generation(null);
      expect(h.obligations()).toMatchObject([
        {
          decision: { decisionId, version: 1 },
          kind: "decision",
          delivery: { agentId: ATLAS, item: 1 },
        },
        { decision: { decisionId, version: 2 }, kind: "rework", delivery: null },
      ]);
      // The person's lost response is retried after the restart.
      expect(await h.record(decisionId, "reject", 1, "chl_change0001")).toEqual(
        ok({ decisionId, version: 2 }),
      );
      h.generation(2);
      h.transfer({ agentId: BOREAS, claimId: CLAIM, generation: 2 });
    }, repo);
    await evictDurableObject(repo.stub);

    await withDecisions(async (h) => {
      h.generation(2);
      expect(h.transfer({ agentId: BOREAS, claimId: CLAIM, generation: 2 })).toEqual([]);
      expect(h.count("decision_obligations")).toBe(2);
      expect(h.obligations()).toMatchObject([
        {
          decision: { decisionId, version: 1 },
          kind: "decision",
          delivery: { agentId: ATLAS, item: 1 },
        },
        {
          decision: { decisionId, version: 2 },
          kind: "rework",
          delivery: { agentId: BOREAS, item: 1 },
        },
      ]);
      expect(await h.entries(BOREAS)).toMatchObject([
        { item: 1, entry: entry("rework", decisionId, 2) },
      ]);
    }, repo);
  });
});
