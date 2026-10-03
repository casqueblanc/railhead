import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClaimView, ReadyRequest } from "@railhead/shared/agent-api";
import type { DecisionRef, RailheadEvent } from "@railhead/shared/events";
import {
  ARTIFACTS_LIMITS,
  createArtifactsAdapter,
  forkRepoName,
  mainRepoName,
} from "../src/artifacts/adapter";
import { FakeArtifacts } from "../src/artifacts/fake";
import type { ClaimsPort } from "../src/contracts/claims";
import type { InboxPort, QueuedItem } from "../src/contracts/inbox";
import type { DecisionsPort } from "../src/contracts/decisions";
import type { AgentPrincipal, GrantFor } from "../src/contracts/principals";
import { ok, type PortResult } from "../src/contracts/result";
import { createClaims } from "../src/modules/claims/module";
import { createDecisions } from "../src/modules/decisions/decisions";
import { composeRepo, type RepoPorts } from "../src/repo/composeRepo";
import type { Repo } from "../src/repo/RepoObject";
import { EventLog } from "../src/repo/eventLog";

const REPO = "rep_readyrepo01";
const ROOT = "1".repeat(40);
const HEAD = "2".repeat(40);
const WORK = "4".repeat(40);
const LATER = "5".repeat(40);
const MISSING = "6".repeat(40);
const OTHER_CLAIM = "clm_otherclaim1";

const CONFLICT: QueuedItem = {
  entry: { kind: "conflict", otherClaimId: OTHER_CLAIM, path: "src/upload/index.ts" },
  decision: null,
};

function agent(n: number, repoId = REPO): AgentPrincipal {
  return { kind: "agent", agentId: `agt_agent000${n}`, ownerId: "usr_owner0001", repoId };
}

function grant(title: string): GrantFor<"issue.file"> {
  return {
    kind: "human",
    userId: "usr_owner0001",
    repoId: REPO,
    grantId: crypto.randomUUID(),
    action: { kind: "issue.file", title, body: "Do it." },
  };
}

interface World {
  fake: FakeArtifacts;
  /** `real` for the decisions module, otherwise what a fake decisions fence reader answers. */
  versions: "real" | DecisionRef[] | null;
  /** Whether the Artifacts module is installed. */
  artifacts: boolean;
  /** When true, the inbox cannot answer the ready gate. */
  gateUnknown?: boolean;
}

interface Setup {
  port: ClaimsPort;
  inbox: InboxPort;
  decisions: DecisionsPort;
  log: EventLog;
  sql: SqlStorage;
  events: () => RailheadEvent[];
  /** Files an issue, claims it for agent 1 and returns the opened claim and its fork's name. */
  open: () => Promise<{ claim: ClaimView; fork: string }>;
  /** Adds `commit` to the fork, as a push would. */
  push: (fork: string, commit: string) => void;
}

/** Runs `body` in a fresh Repo with real claims and inbox, fake Artifacts and fake decisions. */
function withReady<T>(
  body: (setup: Setup, world: World) => Promise<T>,
  world: World = { fake: new FakeArtifacts(), versions: "real", artifacts: true },
): Promise<T> {
  const stub: DurableObjectStub<Repo> = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    const { fake } = world;
    const main = await mainRepoName(REPO);
    fake.seed(main, [ROOT, HEAD]);
    const log = EventLog.open(state.storage, REPO, fake.clock);
    const context = {
      repoId: REPO,
      storage: state.storage,
      log,
      clock: fake.clock,
      env,
      wake: async () => true,
    };
    const base = composeRepo(context);
    const artifacts = world.artifacts
      ? createArtifactsAdapter(
          { ...context, namespace: fake },
          { ...ARTIFACTS_LIMITS, callTimeoutMs: 50 },
        )
      : base.artifacts;
    // The fakes read `world` on every call, so a test can change their answers after ready.
    const decisions =
      world.versions === "real"
        ? createDecisions(context, () => ports)
        : {
            ...base.decisions,
            currentVersions: () => (world.versions === "real" ? null : world.versions),
          };
    const inbox: InboxPort = {
      ...base.inbox,
      readyGateNow: (claimId, generation) =>
        world.gateUnknown === true ? null : base.inbox.readyGateNow(claimId, generation),
    };
    const port: ClaimsPort = createClaims(context, () => ports);
    const ports: RepoPorts = {
      ...base,
      claims: port,
      artifacts,
      decisions,
      inbox,
      mainWriter: { ...base.mainWriter, head: async () => ok(HEAD) },
    };
    const setup: Setup = {
      port,
      inbox,
      decisions,
      log,
      sql: state.storage.sql,
      events: () => log.replay(0, 256).events,
      async open() {
        const filed = await port.fileIssue(grant("Add uploads"));
        if (!filed.ok) throw new Error(`filing refused: ${filed.code}`);
        const claimed = await port.work(agent(1));
        if (!claimed.ok) throw new Error(`claim refused: ${claimed.code}`);
        const fork = await forkRepoName(REPO, claimed.value.claim.claimId);
        return { claim: claimed.value.claim, fork };
      },
      push(fork, commit) {
        const repo = fake.repos.get(fork);
        if (repo === undefined) throw new Error("no such fork");
        repo.commits.push(commit);
      },
    };
    const result = await body(setup, world);
    expect(fake.openHandles).toBe(0);
    return result;
  });
}

function request(commit: string, generation = 1): ReadyRequest {
  return { generation, commit };
}

function types(events: RailheadEvent[]): string[] {
  return events.map((event) => event.type);
}

function claimState(
  sql: SqlStorage,
  claimId: string,
): { state: string; ready_commit: string | null } {
  const [row] = sql
    .exec<{ state: string; ready_commit: string | null }>(
      "SELECT state, ready_commit FROM claims_claims WHERE claim_id = ?",
      claimId,
    )
    .toArray();
  if (row === undefined) throw new Error("no such claim");
  return row;
}

function queueConflict(setup: Setup, claimId: string, generation = 1): void {
  setup.log.transaction((tx) =>
    setup.inbox.queue(tx, { agentId: "agt_agent0001", claimId, generation }, CONFLICT),
  );
}

function expectFailure(result: PortResult<unknown>, code: string): void {
  expect(result).toMatchObject({ ok: false, code });
}

describe("ready", () => {
  it("pins the exact commit with the current decision versions and revokes the fork's tokens", async () => {
    await withReady(async (setup, { fake }) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      const write = fake.mintFor(fork, "write", 600);
      const asked = await setup.decisions.ask(agent(1), claim.claimId, {
        generation: 1,
        requestId: "req_upload0000000001",
        text: "Should uploads above 10 MB be rejected or chunked?",
        options: [
          { key: "reject", label: "Reject them" },
          { key: "chunk", label: "Upload them in chunks" },
        ],
        scope: ["src/upload.ts"],
      });
      if (!asked.ok) throw new Error(`ask refused: ${asked.code}`);
      const { decisionId } = asked.value;
      const recorded = await setup.decisions.record({
        kind: "human",
        userId: "usr_owner0001",
        repoId: REPO,
        grantId: crypto.randomUUID(),
        action: { kind: "decision.record", decisionId, option: "chunk", expectedVersion: null },
      });
      expect(recorded).toEqual(ok({ decisionId, version: 1 }));

      // The decision's inbox item blocks ready until the agent acknowledges it.
      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, request(WORK)),
        "unacked_decision",
      );
      const delivered = await setup.inbox.pending(agent(1), 1);
      const item = delivered.ok ? delivered.value.items[0]?.item : undefined;
      if (item === undefined) throw new Error("the decision was not delivered");
      await setup.inbox.ack(agent(1), item, "Upload in chunks.");

      const result = await setup.port.ready(agent(1), claim.claimId, request(WORK));

      expect(result).toEqual({
        ok: true,
        value: { claim: { ...claim, state: "ready", readyCommit: WORK }, repeated: false },
      });
      expect(setup.events().at(-1)).toMatchObject({
        actor: { kind: "agent", id: "agt_agent0001" },
        type: "claim.ready",
        data: {
          claimId: claim.claimId,
          generation: 1,
          commit: WORK,
          decisions: [{ decisionId, version: 1 }],
        },
      });
      expect(fake.accepts(write.plaintext)).toBe(false);
      expect(fake.liveTokens(fork)).toEqual([]);
      expect(await setup.port.pin(claim.claimId)).toEqual({
        ok: true,
        value: { claimId: claim.claimId, generation: 1, commit: WORK },
      });
    });
  });

  it("answers a repeat with the same pin and records nothing new", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      const first = await setup.port.ready(agent(1), claim.claimId, request(WORK));
      const head = setup.log.head();

      const again = await setup.port.ready(agent(1), claim.claimId, request(WORK));

      expect(first).toMatchObject({ ok: true, value: { repeated: false } });
      if (!first.ok) throw new Error("the first ready was refused");
      expect(again).toEqual(ok({ ...first.value, repeated: true }));
      expect(setup.log.head()).toBe(head);
    });
  });

  it("refuses a commit the fork does not have and pins nothing", async () => {
    await withReady(async (setup) => {
      const { claim } = await setup.open();
      const head = setup.log.head();

      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, request(MISSING)),
        "commit_not_found",
      );

      expect(setup.log.head()).toBe(head);
      expect(claimState(setup.sql, claim.claimId)).toEqual({
        state: "working",
        ready_commit: null,
      });
      expectFailure(await setup.port.pin(claim.claimId), "claim_closed");
    });
  });

  it("refuses malformed input and a session of another repository before anything else", async () => {
    await withReady(async (setup, { fake }) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      const head = setup.log.head();
      const forks = fake.forkCalls;
      for (const [claimId, body] of [
        ["iss_issue0001", request(WORK)],
        [claim.claimId, request(WORK, 0)],
        [claim.claimId, request(WORK, 1.5)],
        [claim.claimId, request("A".repeat(40))],
        [claim.claimId, request(WORK.slice(1))],
      ] as const) {
        expectFailure(await setup.port.ready(agent(1), claimId, body), "invalid_request");
      }
      expectFailure(
        await setup.port.ready(agent(1, "rep_otherrepo1"), claim.claimId, request(WORK)),
        "unauthenticated",
      );
      expect(setup.log.head()).toBe(head);
      expect(fake.forkCalls).toBe(forks);
      expect(claimState(setup.sql, claim.claimId).state).toBe("working");
    });
  });

  it("refuses a stale generation, recording the refusal, and another agent without recording", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);

      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, request(WORK, 2)),
        "stale_generation",
      );
      expect(setup.events().at(-1)).toMatchObject({
        type: "claim.refused",
        data: { claimId: claim.claimId, generation: 1, reason: "stale_generation" },
      });
      const head = setup.log.head();
      expectFailure(
        await setup.port.ready(agent(2), claim.claimId, request(WORK)),
        "stale_generation",
      );
      expect(setup.log.head()).toBe(head);
      expect(claimState(setup.sql, claim.claimId).state).toBe("working");
    });
  });

  it("refuses while an inbox item is unacknowledged, then pins once it is acknowledged", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      queueConflict(setup, claim.claimId);

      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, request(WORK)),
        "unacked_decision",
      );
      expect(setup.events().at(-1)).toMatchObject({
        type: "claim.refused",
        data: { claimId: claim.claimId, generation: 1, reason: "unacked_decision" },
      });
      expect(claimState(setup.sql, claim.claimId).state).toBe("working");

      // Delivery alone does not clear the gate.
      await setup.inbox.pending(agent(1), 1);
      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, request(WORK)),
        "unacked_decision",
      );

      await setup.inbox.ack(agent(1), 1, "Rebase on the other claim.");
      expect(await setup.port.ready(agent(1), claim.claimId, request(WORK))).toMatchObject({
        ok: true,
        value: { repeated: false, claim: { state: "ready", readyCommit: WORK } },
      });
    });
  });

  it("is not blocked by an item for another generation", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      queueConflict(setup, claim.claimId, 2);
      expect((await setup.port.ready(agent(1), claim.claimId, request(WORK))).ok).toBe(true);
    });
  });

  it("refuses when the decision versions are unknown, never treating them as none", async () => {
    await withReady(
      async (setup) => {
        const { claim, fork } = await setup.open();
        setup.push(fork, WORK);
        const head = setup.log.head();
        expectFailure(
          await setup.port.ready(agent(1), claim.claimId, request(WORK)),
          "unavailable",
        );
        expect(setup.log.head()).toBe(head);
        expect(claimState(setup.sql, claim.claimId).state).toBe("working");
      },
      { fake: new FakeArtifacts(), versions: null, artifacts: true },
    );
  });

  it("refuses when the inbox cannot answer the gate, never treating it as clear", async () => {
    await withReady(
      async (setup, { fake }) => {
        const { claim, fork } = await setup.open();
        setup.push(fork, WORK);
        const write = fake.mintFor(fork, "write", 600);
        const head = setup.log.head();
        expectFailure(
          await setup.port.ready(agent(1), claim.claimId, request(WORK)),
          "unavailable",
        );
        expect(setup.log.head()).toBe(head);
        expect(claimState(setup.sql, claim.claimId)).toEqual({
          state: "working",
          ready_commit: null,
        });
        expectFailure(await setup.port.pin(claim.claimId), "claim_closed");
        expect(fake.accepts(write.plaintext)).toBe(true);
      },
      { fake: new FakeArtifacts(), versions: "real", artifacts: true, gateUnknown: true },
    );
  });

  it("fails closed with no pin while Artifacts is missing", async () => {
    await withReady(
      async (setup) => {
        // Allocation needs Artifacts too, so the opened claim is written directly.
        await setup.port.fileIssue(grant("Add uploads"));
        setup.sql.exec(
          `INSERT INTO claims_claims (claim_id, issue_id, agent_id, owner_id, generation, state, base)
           SELECT 'clm_manualclaim', issue_id, 'agt_agent0001', 'usr_owner0001', 1, 'working', ?
           FROM claims_issues`,
          HEAD,
        );
        expectFailure(
          await setup.port.ready(agent(1), "clm_manualclaim", request(WORK)),
          "unavailable",
        );
        expect(claimState(setup.sql, "clm_manualclaim").state).toBe("working");
      },
      { fake: new FakeArtifacts(), versions: [], artifacts: false },
    );
  });

  it("refuses a closed claim, an unknown one and a claim still allocating", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      expectFailure(
        await setup.port.ready(agent(1), "clm_unknownclm1", request(WORK)),
        "claim_closed",
      );
      setup.sql.exec(
        "UPDATE claims_claims SET state = 'expired' WHERE claim_id = ?",
        claim.claimId,
      );
      expectFailure(await setup.port.ready(agent(1), claim.claimId, request(WORK)), "claim_closed");
      setup.sql.exec(
        "UPDATE claims_claims SET state = 'allocating', base = NULL WHERE claim_id = ?",
        claim.claimId,
      );
      expectFailure(await setup.port.ready(agent(1), claim.claimId, request(WORK)), "busy");
    });
  });
});

describe("ready races", () => {
  it("sees an inbox item queued while the commit was being looked up", async () => {
    await withReady(async (setup, { fake }) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      const held = fake.pauseNext("get");
      const pending = setup.port.ready(agent(1), claim.claimId, request(WORK));
      await held.reached;
      queueConflict(setup, claim.claimId);
      held.release();

      expectFailure(await pending, "unacked_decision");
      expect(claimState(setup.sql, claim.claimId)).toEqual({
        state: "working",
        ready_commit: null,
      });
    });
  });

  it("sees a takeover made while the commit was being looked up", async () => {
    await withReady(async (setup, { fake }) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      const held = fake.pauseNext("get");
      const pending = setup.port.ready(agent(1), claim.claimId, request(WORK));
      await held.reached;
      setup.sql.exec(
        "UPDATE claims_claims SET generation = 2, agent_id = 'agt_agent0002' WHERE claim_id = ?",
        claim.claimId,
      );
      held.release();

      expectFailure(await pending, "stale_generation");
      expect(claimState(setup.sql, claim.claimId)).toEqual({
        state: "working",
        ready_commit: null,
      });
    });
  });

  it("keeps the first pin when two commits are marked ready at once", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      setup.push(fork, LATER);
      const [a, b] = await Promise.all([
        setup.port.ready(agent(1), claim.claimId, request(WORK)),
        setup.port.ready(agent(1), claim.claimId, request(LATER)),
      ]);
      const outcomes = [a, b].map((r) => (r.ok ? "ok" : r.code)).toSorted();
      expect(outcomes).toEqual(["after_ready", "ok"]);
      const pinned = a.ok ? WORK : LATER;
      expect(claimState(setup.sql, claim.claimId)).toEqual({
        state: "ready",
        ready_commit: pinned,
      });
      expect(types(setup.events()).filter((t) => t === "claim.ready")).toHaveLength(1);
    });
  });

  it("keeps the pin when the fork moves after ready, and refuses the newer commit", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      await setup.port.ready(agent(1), claim.claimId, request(WORK));
      // A push granted before the pin lands afterwards.
      setup.push(fork, LATER);

      expectFailure(await setup.port.ready(agent(1), claim.claimId, request(LATER)), "after_ready");
      expect(setup.events().at(-1)).toMatchObject({
        type: "claim.refused",
        data: { reason: "after_ready" },
      });
      expect(await setup.port.pin(claim.claimId)).toEqual({
        ok: true,
        value: { claimId: claim.claimId, generation: 1, commit: WORK },
      });
      expectFailure(
        await setup.port.authorizeGit({
          principal: agent(1),
          target: { kind: "fork", claimId: claim.claimId },
          operation: "push",
        }),
        "after_ready",
      );
    });
  });

  it("records the pin when revocation fails and revokes on the repeat", async () => {
    await withReady(async (setup, { fake }) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      const write = fake.mintFor(fork, "write", 600);
      fake.failRevocations(100);

      const first = await setup.port.ready(agent(1), claim.claimId, request(WORK));
      expectFailure(first, "busy");
      expect(claimState(setup.sql, claim.claimId)).toEqual({ state: "ready", ready_commit: WORK });

      fake.failRevocations(0);
      const again = await setup.port.ready(agent(1), claim.claimId, request(WORK));
      expect(again).toMatchObject({ ok: true, value: { repeated: true } });
      expect(fake.accepts(write.plaintext)).toBe(false);
      expect(types(setup.events()).filter((t) => t === "claim.ready")).toHaveLength(1);
    });
  });
});

/** Asks a question on the claim and records `option` as the owner's decision. */
async function decide(
  setup: Setup,
  claimId: string,
  expectedVersion: number | null,
  existing?: DecisionRef["decisionId"],
): Promise<DecisionRef> {
  let decisionId = existing;
  if (decisionId === undefined) {
    const asked = await setup.decisions.ask(agent(1), claimId, {
      generation: 1,
      requestId: "req_upload0000000001",
      text: "Should uploads above 10 MB be rejected or chunked?",
      options: [
        { key: "reject", label: "Reject them" },
        { key: "chunk", label: "Upload them in chunks" },
      ],
      scope: ["src/upload.ts"],
    });
    if (!asked.ok) throw new Error(`ask refused: ${asked.code}`);
    decisionId = asked.value.decisionId;
  }
  const recorded = await setup.decisions.record({
    kind: "human",
    userId: "usr_owner0001",
    repoId: REPO,
    grantId: crypto.randomUUID(),
    action: {
      kind: "decision.record",
      decisionId,
      option: expectedVersion === null ? "chunk" : "reject",
      expectedVersion,
    },
  });
  if (!recorded.ok) throw new Error(`record refused: ${recorded.code}`);
  return recorded.value;
}

/** Acknowledges every item delivered to agent 1. */
async function ackAll(setup: Setup): Promise<void> {
  const delivered = await setup.inbox.pending(agent(1), 16);
  if (!delivered.ok) throw new Error(`pending refused: ${delivered.code}`);
  for (const { item } of delivered.value.items) {
    const acked = await setup.inbox.ack(agent(1), item, "Follow the decision.");
    if (!acked.ok) throw new Error(`ack refused: ${acked.code}`);
  }
}

describe("pin", () => {
  it("refuses a working claim, an unknown one and a malformed id", async () => {
    await withReady(async (setup) => {
      const { claim } = await setup.open();
      expectFailure(await setup.port.pin(claim.claimId), "claim_closed");
      expectFailure(await setup.port.pin("clm_unknownclm1"), "claim_closed");
      expectFailure(await setup.port.pin("iss_issue0001"), "invalid_request");
    });
  });

  it("answers while the versions match in any order and reopens the claim when they do not", async () => {
    const a: DecisionRef = { decisionId: "dec_decisiona1", version: 1 };
    const b: DecisionRef = { decisionId: "dec_decisionb1", version: 3 };
    const world: World = { fake: new FakeArtifacts(), versions: [a, b], artifacts: true };
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      expect((await setup.port.ready(agent(1), claim.claimId, request(WORK))).ok).toBe(true);
      const pinned = ok({ claimId: claim.claimId, generation: 1, commit: WORK });

      world.versions = [b, a];
      expect(await setup.port.pin(claim.claimId)).toEqual(pinned);

      const c: DecisionRef = { decisionId: "dec_decisionc1", version: 1 };
      for (const versions of [[a, b, c], [a], [], [b, a]]) {
        world.versions = versions;
        expectFailure(await setup.port.pin(claim.claimId), "decision_superseded");
        expect(claimState(setup.sql, claim.claimId)).toEqual({
          state: "working",
          ready_commit: null,
        });
        expect(setup.events().at(-1)).toMatchObject({
          actor: { kind: "system", id: "sys_claims" },
          type: "claim.reopened",
          data: { claimId: claim.claimId, generation: 1, decisions: versions },
        });
        expectFailure(await setup.port.pin(claim.claimId), "claim_closed");
        // The holder marks the work ready again under the versions that are now current.
        expect(await setup.port.ready(agent(1), claim.claimId, request(WORK))).toMatchObject({
          ok: true,
          value: { repeated: false },
        });
        expect(await setup.port.pin(claim.claimId)).toEqual(pinned);
      }
    }, world);
  });

  it("refuses while the decision versions or the inbox gate are unknown, never treating them as clear", async () => {
    const world: World = { fake: new FakeArtifacts(), versions: [], artifacts: true };
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      expect((await setup.port.ready(agent(1), claim.claimId, request(WORK))).ok).toBe(true);

      world.versions = null;
      expectFailure(await setup.port.pin(claim.claimId), "unavailable");
      world.versions = [];
      world.gateUnknown = true;
      expectFailure(await setup.port.pin(claim.claimId), "unavailable");
      world.gateUnknown = false;
      expect((await setup.port.pin(claim.claimId)).ok).toBe(true);
    }, world);
  });

  it("refuses the pin and a repeated ready while an item is unacknowledged, keeping the claim ready", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      expect((await setup.port.ready(agent(1), claim.claimId, request(WORK))).ok).toBe(true);
      queueConflict(setup, claim.claimId);
      const head = setup.log.head();

      expectFailure(await setup.port.pin(claim.claimId), "unacked_decision");
      expect(claimState(setup.sql, claim.claimId)).toEqual({ state: "ready", ready_commit: WORK });
      expect(setup.log.head()).toBe(head);

      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, request(WORK)),
        "unacked_decision",
      );
      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, request(WORK)),
        "unacked_decision",
      );
      expect(setup.log.replay(head, 16).events).toMatchObject([
        {
          type: "claim.refused",
          data: { claimId: claim.claimId, generation: 1, reason: "unacked_decision" },
        },
      ]);
      expect(claimState(setup.sql, claim.claimId)).toEqual({ state: "ready", ready_commit: WORK });

      await ackAll(setup);
      expect(await setup.port.pin(claim.claimId)).toEqual(
        ok({ claimId: claim.claimId, generation: 1, commit: WORK }),
      );
      expect(await setup.port.ready(agent(1), claim.claimId, request(WORK))).toMatchObject({
        ok: true,
        value: { repeated: true, claim: { state: "ready", readyCommit: WORK } },
      });
      expect(types(setup.events())).not.toContain("claim.reopened");
    });
  });

  it("reopens a claim whose stored versions are missing or unreadable", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      expect((await setup.port.ready(agent(1), claim.claimId, request(WORK))).ok).toBe(true);
      const [stored] = setup.sql
        .exec<{ ready_decisions: string | null }>(
          "SELECT ready_decisions FROM claims_claims WHERE claim_id = ?",
          claim.claimId,
        )
        .toArray();
      expect(stored?.ready_decisions).toBe("[]");

      for (const value of [null, "{", "[{}]", '[{"decisionId":"dec_decisiona1","version":0}]']) {
        setup.sql.exec(
          "UPDATE claims_claims SET ready_decisions = ? WHERE claim_id = ?",
          value,
          claim.claimId,
        );
        expectFailure(await setup.port.pin(claim.claimId), "decision_superseded");
        expect(claimState(setup.sql, claim.claimId).state).toBe("working");
        expect((await setup.port.ready(agent(1), claim.claimId, request(WORK))).ok).toBe(true);
      }
    });
  });
});

describe("a decision superseded after ready", () => {
  const push = { kind: "fork", operation: "push" } as const;

  /** Agent 1's claim, ready at `WORK` under version 1 of a decision, then version 2 recorded. */
  async function superseded(setup: Setup) {
    const { claim, fork } = await setup.open();
    setup.push(fork, WORK);
    const first = await decide(setup, claim.claimId, null);
    await ackAll(setup);
    expect((await setup.port.ready(agent(1), claim.claimId, request(WORK))).ok).toBe(true);
    const second = await decide(setup, claim.claimId, 1, first.decisionId);
    expect(second).toEqual({ decisionId: first.decisionId, version: 2 });
    const access = {
      principal: agent(1),
      target: { kind: push.kind, claimId: claim.claimId },
      operation: push.operation,
    };
    return { claim, fork, second, access };
  }

  it("returns the claim to working, so the holder can push and mark adapted work ready at the new version", async () => {
    await withReady(async (setup, { fake }) => {
      const { claim, fork, second, access } = await superseded(setup);

      // The train's read finds the pin superseded and reopens the claim.
      expectFailure(await setup.port.pin(claim.claimId), "decision_superseded");
      expect(claimState(setup.sql, claim.claimId)).toEqual({
        state: "working",
        ready_commit: null,
      });
      expect(setup.events().at(-1)).toMatchObject({
        actor: { kind: "system", id: "sys_claims" },
        type: "claim.reopened",
        data: { claimId: claim.claimId, generation: 1, decisions: [second] },
      });
      expect(await setup.port.activeClaim(agent(1))).toEqual(
        ok({ ...claim, state: "working", readyCommit: null }),
      );

      // The holder may push again, and the new version still gates ready until acknowledged.
      expect(await setup.port.authorizeGit(access)).toEqual(
        ok({
          repo: fork,
          scope: "write",
          fence: { claimId: claim.claimId, generation: 1, episode: 3 },
        }),
      );
      setup.push(fork, LATER);
      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, request(LATER)),
        "unacked_decision",
      );
      await ackAll(setup);
      const write = fake.mintFor(fork, "write", 600);

      expect(await setup.port.ready(agent(1), claim.claimId, request(LATER))).toEqual(
        ok({ claim: { ...claim, state: "ready", readyCommit: LATER }, repeated: false }),
      );
      expect(setup.events().at(-1)).toMatchObject({
        type: "claim.ready",
        data: { claimId: claim.claimId, commit: LATER, decisions: [second] },
      });
      expect(fake.accepts(write.plaintext)).toBe(false);
      expect(await setup.port.pin(claim.claimId)).toEqual(
        ok({ claimId: claim.claimId, generation: 1, commit: LATER }),
      );
      expect(types(setup.events()).filter((type) => type === "claim.reopened")).toHaveLength(1);
    });
  });

  it("refuses a repeated ready of the superseded pin instead of answering with it", async () => {
    await withReady(async (setup) => {
      const { claim } = await superseded(setup);
      const head = setup.log.head();

      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, request(WORK)),
        "unacked_decision",
      );

      expect(claimState(setup.sql, claim.claimId)).toEqual({
        state: "working",
        ready_commit: null,
      });
      expect(types(setup.log.replay(head, 16).events)).toEqual(["claim.reopened", "claim.refused"]);
      expectFailure(await setup.port.pin(claim.claimId), "claim_closed");
    });
  });

  it("reopens on the holder's push, but not on another agent's", async () => {
    await withReady(async (setup) => {
      const { claim, fork, access } = await superseded(setup);
      const head = setup.log.head();

      expectFailure(
        await setup.port.authorizeGit({ ...access, principal: agent(2) }),
        "stale_generation",
      );
      expect(claimState(setup.sql, claim.claimId)).toEqual({ state: "ready", ready_commit: WORK });
      expect(setup.log.head()).toBe(head);

      expect(await setup.port.authorizeGit(access)).toEqual(
        ok({
          repo: fork,
          scope: "write",
          fence: { claimId: claim.claimId, generation: 1, episode: 3 },
        }),
      );
      expect(claimState(setup.sql, claim.claimId)).toEqual({
        state: "working",
        ready_commit: null,
      });
      expect(types(setup.log.replay(head, 16).events)).toEqual(["claim.reopened"]);
    });
  });

  it("fences a push granted before ready to its episode, which ready and the reopening each end", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      const first = await decide(setup, claim.claimId, null);
      await ackAll(setup);
      const access = {
        principal: agent(1),
        target: { kind: push.kind, claimId: claim.claimId },
        operation: push.operation,
      };
      const granted = await setup.port.authorizeGit(access);
      expect(granted).toMatchObject({
        ok: true,
        value: { fence: { claimId: claim.claimId, generation: 1, episode: 1 } },
      });
      expect(setup.port.workingEpisode(claim.claimId)).toBe(1);

      expect((await setup.port.ready(agent(1), claim.claimId, request(WORK))).ok).toBe(true);
      expect(setup.port.workingGeneration(claim.claimId)).toBeNull();
      expect(setup.port.workingEpisode(claim.claimId)).toBeNull();
      // The push granted before the pin lands now. It moves the fork's branch but not the pin,
      // and no new push is granted.
      setup.push(fork, LATER);
      expect(await setup.port.pin(claim.claimId)).toEqual({
        ok: true,
        value: { claimId: claim.claimId, generation: 1, commit: WORK },
      });
      expectFailure(await setup.port.authorizeGit(access), "after_ready");

      await decide(setup, claim.claimId, 1, first.decisionId);
      expect(await setup.port.activeClaim(agent(1))).toMatchObject({
        ok: true,
        value: { state: "working", readyCommit: null },
      });
      // A claim that is already working is not reopened again.
      expect((await setup.port.activeClaim(agent(1))).ok).toBe(true);
      expectFailure(await setup.port.pin(claim.claimId), "claim_closed");
      // Working again at the same generation, but in a later episode: the fence of the push granted
      // before ready no longer matches, so the gateway neither releases nor records that push.
      expect(setup.port.workingGeneration(claim.claimId)).toBe(1);
      expect(setup.port.workingEpisode(claim.claimId)).toBe(3);
      expect(await setup.port.authorizeGit(access)).toMatchObject({
        ok: true,
        value: { fence: { claimId: claim.claimId, generation: 1, episode: 3 } },
      });
      expect(types(setup.events()).filter((type) => type.startsWith("claim."))).toEqual([
        "claim.opened",
        "claim.ready",
        "claim.reopened",
      ]);
    });
  });

  it("keeps the pin and refuses while the decision versions are unknown", async () => {
    const world: World = { fake: new FakeArtifacts(), versions: [], artifacts: true };
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      expect((await setup.port.ready(agent(1), claim.claimId, request(WORK))).ok).toBe(true);
      const head = setup.log.head();

      world.versions = null;
      expectFailure(await setup.port.ready(agent(1), claim.claimId, request(WORK)), "unavailable");
      expectFailure(
        await setup.port.authorizeGit({
          principal: agent(1),
          target: { kind: "fork", claimId: claim.claimId },
          operation: "push",
        }),
        "after_ready",
      );
      expect(claimState(setup.sql, claim.claimId)).toEqual({ state: "ready", ready_commit: WORK });
      expect(setup.log.head()).toBe(head);

      world.versions = [];
      expect(await setup.port.ready(agent(1), claim.claimId, request(WORK))).toMatchObject({
        ok: true,
        value: { repeated: true },
      });
    }, world);
  });
});

describe("recorded refusals", () => {
  it("records a repeated refusal once, and again when its reason or the pin changes", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      setup.push(fork, LATER);
      const refusals = () =>
        setup.events().filter((event) => event.type === "claim.refused").length;

      for (let i = 0; i < 3; i += 1) {
        expectFailure(
          await setup.port.ready(agent(1), claim.claimId, request(WORK, 2)),
          "stale_generation",
        );
      }
      expect(refusals()).toBe(1);

      queueConflict(setup, claim.claimId);
      for (let i = 0; i < 3; i += 1) {
        expectFailure(
          await setup.port.ready(agent(1), claim.claimId, request(WORK)),
          "unacked_decision",
        );
      }
      expect(refusals()).toBe(2);

      await ackAll(setup);
      expect((await setup.port.ready(agent(1), claim.claimId, request(WORK))).ok).toBe(true);
      for (let i = 0; i < 3; i += 1) {
        expectFailure(
          await setup.port.ready(agent(1), claim.claimId, request(LATER)),
          "after_ready",
        );
      }
      // The pin changed the claim, so the same stale generation is recorded again, once.
      for (let i = 0; i < 2; i += 1) {
        expectFailure(
          await setup.port.ready(agent(1), claim.claimId, request(WORK, 2)),
          "stale_generation",
        );
      }
      expect(refusals()).toBe(4);
    });
  });

  it("records a refusal again after the claim was pinned and reopened", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      const first = await decide(setup, claim.claimId, null);
      const refusals = () =>
        setup.events().filter((event) => event.type === "claim.refused").length;

      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, request(WORK)),
        "unacked_decision",
      );
      expect(refusals()).toBe(1);
      await ackAll(setup);
      expect((await setup.port.ready(agent(1), claim.claimId, request(WORK))).ok).toBe(true);
      await decide(setup, claim.claimId, 1, first.decisionId);
      const head = setup.log.head();

      // The claim reopens to working with no pin, the same state as the first refusal.
      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, request(WORK)),
        "unacked_decision",
      );
      expect(types(setup.log.replay(head, 16).events)).toEqual(["claim.reopened", "claim.refused"]);
      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, request(WORK)),
        "unacked_decision",
      );
      expect(refusals()).toBe(2);
    });
  });
});

describe("authorizeGit", () => {
  it("grants the holder a write fenced to the current generation of its working fork", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      expect(
        await setup.port.authorizeGit({
          principal: agent(1),
          target: { kind: "fork", claimId: claim.claimId },
          operation: "push",
        }),
      ).toEqual({
        ok: true,
        value: {
          repo: fork,
          scope: "write",
          fence: { claimId: claim.claimId, generation: 1, episode: 1 },
        },
      });
    });
  });

  it("lets any agent of the repository read main and an opened fork, and nobody push main", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      expect(
        await setup.port.authorizeGit({
          principal: agent(2),
          target: { kind: "main" },
          operation: "fetch",
        }),
      ).toEqual({
        ok: true,
        value: { repo: await mainRepoName(REPO), scope: "read", fence: null },
      });
      expect(
        await setup.port.authorizeGit({
          principal: agent(2),
          target: { kind: "fork", claimId: claim.claimId },
          operation: "fetch",
        }),
      ).toEqual({ ok: true, value: { repo: fork, scope: "read", fence: null } });
      expectFailure(
        await setup.port.authorizeGit({
          principal: agent(1),
          target: { kind: "main" },
          operation: "push",
        }),
        "invalid_request",
      );
    });
  });

  it("refuses anonymous and foreign callers, another agent's push and an unknown claim", async () => {
    await withReady(async (setup) => {
      const { claim } = await setup.open();
      const target = { kind: "fork", claimId: claim.claimId } as const;
      expectFailure(
        await setup.port.authorizeGit({ principal: null, target, operation: "fetch" }),
        "unauthenticated",
      );
      expectFailure(
        await setup.port.authorizeGit({
          principal: agent(1, "rep_otherrepo1"),
          target,
          operation: "push",
        }),
        "unauthenticated",
      );
      expectFailure(
        await setup.port.authorizeGit({ principal: agent(2), target, operation: "push" }),
        "stale_generation",
      );
      expectFailure(
        await setup.port.authorizeGit({
          principal: agent(1),
          target: { kind: "fork", claimId: "clm_unknownclm1" },
          operation: "fetch",
        }),
        "not_found",
      );
    });
  });

  it("refuses a push after takeover and to a closed claim", async () => {
    await withReady(async (setup) => {
      const { claim } = await setup.open();
      const access = {
        principal: agent(1),
        target: { kind: "fork", claimId: claim.claimId },
        operation: "push",
      } as const;
      setup.sql.exec(
        "UPDATE claims_claims SET generation = 2, agent_id = 'agt_agent0002' WHERE claim_id = ?",
        claim.claimId,
      );
      expectFailure(await setup.port.authorizeGit(access), "stale_generation");
      setup.sql.exec(
        "UPDATE claims_claims SET state = 'expired', agent_id = 'agt_agent0001' WHERE claim_id = ?",
        claim.claimId,
      );
      expectFailure(await setup.port.authorizeGit(access), "claim_closed");
    });
  });
});

describe("authorizeGit races", () => {
  // `authorizeGit` awaits the fork's name, so a change made right after the call starts lands
  // while the name is being looked up.
  const push = { kind: "fork", operation: "push" } as const;

  function pushOf(claimId: string) {
    return {
      principal: agent(1),
      target: { kind: push.kind, claimId },
      operation: push.operation,
    };
  }

  it("refuses the former holder when a takeover lands during the lookup", async () => {
    await withReady(async (setup) => {
      const { claim } = await setup.open();
      const pending = setup.port.authorizeGit(pushOf(claim.claimId));
      setup.sql.exec(
        "UPDATE claims_claims SET generation = 2, agent_id = 'agt_agent0002' WHERE claim_id = ?",
        claim.claimId,
      );

      expectFailure(await pending, "stale_generation");
    });
  });

  it("refuses a write when the claim becomes ready during the lookup", async () => {
    await withReady(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      expect((await setup.port.ready(agent(1), claim.claimId, request(WORK))).ok).toBe(true);
      const [pinned] = setup.sql
        .exec<{ ready_decisions: string | null }>(
          "SELECT ready_decisions FROM claims_claims WHERE claim_id = ?",
          claim.claimId,
        )
        .toArray();
      if (pinned === undefined) throw new Error("no such claim");
      // Back to working, so the call starts on a working claim and the pin lands mid-lookup.
      setup.sql.exec(
        "UPDATE claims_claims SET state = 'working', ready_commit = NULL, ready_decisions = NULL WHERE claim_id = ?",
        claim.claimId,
      );
      const pending = setup.port.authorizeGit(pushOf(claim.claimId));
      setup.sql.exec(
        "UPDATE claims_claims SET state = 'ready', ready_commit = ?, ready_decisions = ? WHERE claim_id = ?",
        WORK,
        pinned.ready_decisions,
        claim.claimId,
      );

      expectFailure(await pending, "after_ready");
      expect(claimState(setup.sql, claim.claimId)).toEqual({ state: "ready", ready_commit: WORK });
    });
  });

  it("refuses a push to a claim that expires during the lookup", async () => {
    await withReady(async (setup) => {
      const { claim } = await setup.open();
      const pending = setup.port.authorizeGit(pushOf(claim.claimId));
      setup.sql.exec(
        "UPDATE claims_claims SET state = 'expired' WHERE claim_id = ?",
        claim.claimId,
      );

      expectFailure(await pending, "claim_closed");
    });
  });
});
