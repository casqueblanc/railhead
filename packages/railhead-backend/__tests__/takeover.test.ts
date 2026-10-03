import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClaimView } from "@railhead/shared/agent-api";
import type { DecisionId, RailheadEvent } from "@railhead/shared/events";
import {
  ARTIFACTS_LIMITS,
  createArtifactsAdapter,
  forkRepoName,
  mainRepoName,
} from "../src/artifacts/adapter";
import { FakeArtifacts } from "../src/artifacts/fake";
import type { ClaimsPort } from "../src/contracts/claims";
import type { DecisionsPort } from "../src/contracts/decisions";
import type { InboxPort } from "../src/contracts/inbox";
import type { AgentPrincipal, GrantFor } from "../src/contracts/principals";
import { ok, type PortResult } from "../src/contracts/result";
import { CLAIM_LEASE_MS, REVOKE_RETRY_MS, createClaims } from "../src/modules/claims/module";
import { createDecisions } from "../src/modules/decisions/decisions";
import { composeRepo, type RepoPorts } from "../src/repo/composeRepo";
import type { Repo } from "../src/repo/RepoObject";
import { EventLog } from "../src/repo/eventLog";

const REPO = "rep_takeover001";
const ROOT = "1".repeat(40);
const HEAD = "2".repeat(40);
const WORK = "4".repeat(40);
const STALE = "5".repeat(40);
const SUCCESSOR = "6".repeat(40);

function agent(n: number, repoId = REPO): AgentPrincipal {
  return { kind: "agent", agentId: `agt_agent000${n}`, ownerId: "usr_owner0001", repoId };
}

function issueGrant(title: string): GrantFor<"issue.file"> {
  return {
    kind: "human",
    userId: "usr_owner0001",
    repoId: REPO,
    grantId: crypto.randomUUID(),
    action: { kind: "issue.file", title, body: `${title}, as the issue says.` },
  };
}

interface Setup {
  fake: FakeArtifacts;
  port: ClaimsPort;
  inbox: InboxPort;
  decisions: DecisionsPort;
  log: EventLog;
  sql: SqlStorage;
  /** Every alarm time a module asked for, in order. */
  wakes: number[];
  events: () => RailheadEvent[];
  file: (title: string) => Promise<string>;
  /** Files an issue, claims it for agent 1 and returns the opened claim and its fork's name. */
  open: () => Promise<{ claim: ClaimView; fork: string }>;
  /** Adds `commit` to the fork, as a push would. */
  push: (fork: string, commit: string) => void;
}

/** Runs `body` in a fresh Repo with real claims, inbox and decisions, and fake Artifacts. */
function withTakeover<T>(body: (setup: Setup) => Promise<T>): Promise<T> {
  const stub: DurableObjectStub<Repo> = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    const fake = new FakeArtifacts();
    fake.seed(await mainRepoName(REPO), [ROOT, HEAD]);
    const log = EventLog.open(state.storage, REPO, fake.clock);
    const wakes: number[] = [];
    const context = {
      repoId: REPO,
      storage: state.storage,
      log,
      clock: fake.clock,
      env,
      wake: (at: number) => {
        wakes.push(at);
      },
    };
    const base = composeRepo(context);
    const artifacts = createArtifactsAdapter(
      { ...context, namespace: fake },
      { ...ARTIFACTS_LIMITS, callTimeoutMs: 50 },
    );
    const decisions = createDecisions(context, () => ports);
    const port = createClaims(context, () => ports);
    const ports: RepoPorts = {
      ...base,
      claims: port,
      artifacts,
      decisions,
      mainWriter: { ...base.mainWriter, head: async () => ok(HEAD) },
    };
    const setup: Setup = {
      fake,
      port,
      inbox: base.inbox,
      decisions,
      log,
      sql: state.storage.sql,
      wakes,
      events: () => log.replay(0, 256).events,
      async file(title) {
        const filed = await port.fileIssue(issueGrant(title));
        if (!filed.ok) throw new Error(`filing refused: ${filed.code}`);
        return filed.value.issueId;
      },
      async open() {
        await setup.file("Add uploads");
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
    const result = await body(setup);
    expect(fake.openHandles).toBe(0);
    return result;
  });
}

function types(events: RailheadEvent[]): string[] {
  return events.map((event) => event.type);
}

function expectFailure(result: PortResult<unknown>, code: string): void {
  expect(result).toMatchObject({ ok: false, code });
}

function stored(
  sql: SqlStorage,
  claimId: string,
): { agent_id: string; generation: number; state: string; revoke_due: number | null } {
  const [row] = sql
    .exec<{ agent_id: string; generation: number; state: string; revoke_due: number | null }>(
      "SELECT agent_id, generation, state, revoke_due FROM claims_claims WHERE claim_id = ?",
      claimId,
    )
    .toArray();
  if (row === undefined) throw new Error("no such claim");
  return row;
}

/** Asks a question on the claim for agent 1 and records two versions of its decision. */
async function decideTwice(setup: Setup, claimId: string): Promise<DecisionId> {
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
  const { decisionId } = asked.value;
  for (const [option, expectedVersion] of [
    ["chunk", null],
    ["reject", 1],
  ] as const) {
    const recorded = await setup.decisions.record({
      kind: "human",
      userId: "usr_owner0001",
      repoId: REPO,
      grantId: crypto.randomUUID(),
      action: { kind: "decision.record", decisionId, option, expectedVersion },
    });
    if (!recorded.ok) throw new Error(`record refused: ${recorded.code}`);
  }
  return decisionId;
}

const push = (principal: AgentPrincipal, claimId: string) =>
  ({ principal, target: { kind: "fork", claimId }, operation: "push" }) as const;

describe("leases", () => {
  it("renews the lease on every holder call, so a live holder keeps its claim", async () => {
    await withTakeover(async (setup) => {
      const { claim } = await setup.open();

      // Two status reads, each just inside the lease, carry the claim past one lease length.
      setup.fake.advance(CLAIM_LEASE_MS - 1);
      expect(await setup.port.activeClaim(agent(1))).toEqual(ok(claim));
      setup.fake.advance(CLAIM_LEASE_MS - 1);
      expect(await setup.port.activeClaim(agent(1))).toEqual(ok(claim));
      // A Git fetch of main renews it too.
      setup.fake.advance(CLAIM_LEASE_MS - 1);
      const fetched = await setup.port.authorizeGit({
        principal: agent(1),
        target: { kind: "main" },
        operation: "fetch",
      });
      expect(fetched).toMatchObject({ ok: true, value: { scope: "read" } });
      setup.fake.advance(CLAIM_LEASE_MS - 1);

      expect(setup.port.currentGeneration(claim.claimId)).toBe(1);
      await setup.port.resume();
      expectFailure(await setup.port.work(agent(2)), "no_work");
      expect(types(setup.events())).not.toContain("claim.expired");
      expect(setup.wakes.at(-1)).toBe(setup.fake.clock() + 1);
    });
  });

  it("holds the claim until the lease's last millisecond and fences the holder after it", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);

      setup.fake.advance(CLAIM_LEASE_MS - 1);
      expect(setup.port.currentGeneration(claim.claimId)).toBe(1);
      setup.fake.advance(1);
      // Lapsed, though nothing has recorded the expiry yet.
      expect(setup.port.currentGeneration(claim.claimId)).toBeNull();

      expectFailure(await setup.port.authorizeGit(push(agent(1), claim.claimId)), "claim_closed");
      expect(setup.events().at(-1)).toMatchObject({
        actor: { kind: "system", id: "sys_claims" },
        type: "claim.expired",
        data: { claimId: claim.claimId, generation: 1 },
      });
      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, { generation: 1, commit: WORK }),
        "claim_closed",
      );
      expect(await setup.port.activeClaim(agent(1))).toEqual(ok(null));
      // The expiry asked the alarm to revoke the fork's tokens at once.
      expect(setup.wakes.at(-1)).toBeLessThanOrEqual(setup.fake.clock());
      expect(stored(setup.sql, claim.claimId)).toMatchObject({ state: "expired", generation: 1 });
    });
  });

  it("expires a lapsed claim on the alarm and revokes its fork's tokens", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const token = setup.fake.mintFor(fork, "write", 3600);
      setup.fake.advance(CLAIM_LEASE_MS);

      await setup.port.resume();

      expect(types(setup.events()).at(-1)).toBe("claim.expired");
      expect(setup.fake.accepts(token.plaintext)).toBe(false);
      expect(setup.fake.liveTokens(fork)).toEqual([]);
      expect(stored(setup.sql, claim.claimId)).toMatchObject({
        state: "expired",
        revoke_due: null,
      });
    });
  });

  it("never lapses a ready claim, whose pin the train holds", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      expect(
        await setup.port.ready(agent(1), claim.claimId, { generation: 1, commit: WORK }),
      ).toMatchObject({ ok: true });

      setup.fake.advance(3 * CLAIM_LEASE_MS);
      await setup.port.resume();
      expectFailure(await setup.port.work(agent(2)), "no_work");

      expect(await setup.port.pin(claim.claimId)).toEqual(
        ok({ claimId: claim.claimId, generation: 1, commit: WORK }),
      );
      expect(types(setup.events())).not.toContain("claim.expired");
    });
  });
});

describe("takeover", () => {
  it("hands a dead owner's claim to a successor with its task and latest decision", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      const decisionId = await decideTwice(setup, claim.claimId);
      const former = setup.fake.mintFor(fork, "write", 3600);

      // Agent 1 is killed; its lease lapses and agent 2 asks for work.
      setup.fake.advance(CLAIM_LEASE_MS);
      const taken = await setup.port.work(agent(2));

      expect(taken).toEqual(
        ok({ claim: { ...claim, generation: 2, state: "working" }, resumed: false }),
      );
      expect(taken.ok && taken.value.claim.task).toEqual({
        title: "Add uploads",
        body: "Add uploads, as the issue says.",
      });
      expect(setup.events().slice(-3)).toMatchObject([
        { type: "claim.expired", data: { claimId: claim.claimId, generation: 1 } },
        {
          actor: { kind: "system", id: "sys_claims" },
          type: "claim.reassigned",
          data: { claimId: claim.claimId, from: "agt_agent0001", to: "agt_agent0002" },
        },
        { type: "inbox.queued", data: { agentId: "agt_agent0002", claimId: claim.claimId } },
      ]);
      expect(setup.fake.accepts(former.plaintext)).toBe(false);

      // The successor's inbox holds the latest version, not the first.
      const pending = await setup.inbox.pending(agent(2), 10);
      if (!pending.ok) throw new Error(`inbox refused: ${pending.code}`);
      expect(pending.value.items).toHaveLength(1);
      expect(pending.value.items[0]).toMatchObject({
        entry: { kind: "decision", decision: { decisionId, version: 2 } },
      });
      expect(setup.decisions.currentVersions(claim.claimId)).toEqual([{ decisionId, version: 2 }]);
      expect(setup.port.currentGeneration(claim.claimId)).toBe(2);
      expect(await setup.port.activeClaim(agent(1))).toEqual(ok(null));
    });
  });

  it("keeps a stale owner's in-flight push out of the successor's pin", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      // The former holder's push was granted at generation 1 before its lease lapsed.
      expect(await setup.port.authorizeGit(push(agent(1), claim.claimId))).toMatchObject({
        ok: true,
        value: { scope: "write", fence: { claimId: claim.claimId, generation: 1 } },
      });
      setup.fake.advance(CLAIM_LEASE_MS);
      expect(await setup.port.work(agent(2))).toMatchObject({
        ok: true,
        value: { claim: { claimId: claim.claimId, generation: 2 } },
      });

      // The successor pushes, then the stale push lands on the fork after it.
      expect(await setup.port.authorizeGit(push(agent(2), claim.claimId))).toMatchObject({
        ok: true,
        value: { scope: "write", fence: { claimId: claim.claimId, generation: 2 } },
      });
      setup.push(fork, SUCCESSOR);
      setup.push(fork, STALE);

      expectFailure(
        await setup.port.authorizeGit(push(agent(1), claim.claimId)),
        "stale_generation",
      );
      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, { generation: 1, commit: STALE }),
        "stale_generation",
      );
      expectFailure(
        await setup.port.ready(agent(2), claim.claimId, { generation: 1, commit: STALE }),
        "stale_generation",
      );
      expect(
        await setup.port.ready(agent(2), claim.claimId, { generation: 2, commit: SUCCESSOR }),
      ).toMatchObject({ ok: true, value: { claim: { readyCommit: SUCCESSOR, generation: 2 } } });
      expect(await setup.port.pin(claim.claimId)).toEqual(
        ok({ claimId: claim.claimId, generation: 2, commit: SUCCESSOR }),
      );
    });
  });

  it("offers an expired claim before a new issue, and never back to its former holder", async () => {
    await withTakeover(async (setup) => {
      const { claim } = await setup.open();
      const fresh = await setup.file("Add downloads");
      setup.fake.advance(CLAIM_LEASE_MS);

      // The former holder gets the new issue, not its own expired claim.
      const former = await setup.port.work(agent(1));
      expect(former).toMatchObject({ ok: true, value: { claim: { issueId: fresh } } });
      const successor = await setup.port.work(agent(2));
      expect(successor).toMatchObject({
        ok: true,
        value: { claim: { claimId: claim.claimId, generation: 2 } },
      });
      expectFailure(await setup.port.work(agent(3)), "no_work");
    });
  });

  it("takes over through a named claim and refuses what cannot be taken", async () => {
    await withTakeover(async (setup) => {
      const { claim } = await setup.open();
      const head = setup.log.head();

      // Before the lease lapses the issue is held; malformed ids and foreign sessions are refused.
      expectFailure(await setup.port.claim(agent(2), claim.issueId), "issue_unavailable");
      expectFailure(await setup.port.claim(agent(2), "clm_notanissue1"), "invalid_request");
      expectFailure(await setup.port.work(agent(2, "rep_otherrepo1")), "unauthenticated");
      expect(setup.log.head()).toBe(head);

      setup.fake.advance(CLAIM_LEASE_MS);
      expectFailure(await setup.port.claim(agent(1), claim.issueId), "issue_unavailable");
      expect(await setup.port.claim(agent(2), claim.issueId)).toMatchObject({
        ok: true,
        value: { claim: { claimId: claim.claimId, generation: 2 }, resumed: false },
      });
      expect(stored(setup.sql, claim.claimId)).toMatchObject({
        agent_id: "agt_agent0002",
        generation: 2,
        state: "working",
      });
    });
  });

  it("gives no write grant while the old tokens' revocation is pending, and retries it on the alarm", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const former = setup.fake.mintFor(fork, "write", 3600);
      // Every revocation call fails, so each sweep leaves the former holder's token live.
      setup.fake.failRevocations(Number.MAX_SAFE_INTEGER);
      setup.fake.advance(CLAIM_LEASE_MS);

      expectFailure(await setup.port.work(agent(2)), "busy");
      expectFailure(await setup.port.claim(agent(2), claim.issueId), "busy");
      expectFailure(
        await setup.port.authorizeGit(push(agent(2), claim.issueId)),
        "invalid_request",
      );
      expectFailure(
        await setup.port.authorizeGit(push(agent(2), claim.claimId)),
        "stale_generation",
      );
      expect(types(setup.events())).not.toContain("claim.reassigned");
      expect(stored(setup.sql, claim.claimId)).toMatchObject({
        agent_id: "agt_agent0001",
        state: "expired",
        revoke_due: setup.fake.clock() + REVOKE_RETRY_MS,
      });
      expect(setup.fake.accepts(former.plaintext)).toBe(true);
      expect(setup.wakes).toContain(setup.fake.clock() + REVOKE_RETRY_MS);

      // The alarm before the retry time changes nothing; at it, the revocation settles.
      setup.fake.advance(REVOKE_RETRY_MS - 1);
      await setup.port.resume();
      expect(stored(setup.sql, claim.claimId).revoke_due).not.toBeNull();
      setup.fake.failRevocations(0);
      setup.fake.advance(1);
      await setup.port.resume();
      expect(stored(setup.sql, claim.claimId).revoke_due).toBeNull();
      expect(setup.fake.accepts(former.plaintext)).toBe(false);

      expect(await setup.port.work(agent(2))).toMatchObject({
        ok: true,
        value: { claim: { claimId: claim.claimId, generation: 2 } },
      });
      expect(await setup.port.authorizeGit(push(agent(2), claim.claimId))).toMatchObject({
        ok: true,
        value: { scope: "write", fence: { generation: 2 } },
      });
    });
  });

  it("passes a lapsed allocation to the successor, which finishes the same fork intent", async () => {
    await withTakeover(async (setup) => {
      await setup.file("Add uploads");
      setup.fake.failNextFork("lose-response");
      expect(await setup.port.work(agent(1))).toMatchObject({ ok: false });
      const [intent] = setup.sql
        .exec<{ claim_id: string }>("SELECT claim_id FROM claims_claims")
        .toArray();
      if (intent === undefined) throw new Error("no fork intent was recorded");

      setup.fake.advance(CLAIM_LEASE_MS);
      const taken = await setup.port.work(agent(2));

      expect(taken).toMatchObject({
        ok: true,
        value: { claim: { claimId: intent.claim_id, generation: 2, base: HEAD } },
      });
      // The fork created without its response is the one the successor opens: no second fork.
      expect(setup.fake.forkCalls).toBe(1);
      expect(setup.fake.repos.has(await forkRepoName(REPO, intent.claim_id))).toBe(true);
      expect(setup.events().at(-1)).toMatchObject({
        actor: { kind: "agent", id: "agt_agent0002" },
        type: "claim.opened",
        data: { claimId: intent.claim_id, agentId: "agt_agent0002", generation: 2 },
      });
      expect(types(setup.events())).not.toContain("claim.reassigned");
      expect(await setup.port.activeClaim(agent(1))).toEqual(ok(null));
    });
  });
});
