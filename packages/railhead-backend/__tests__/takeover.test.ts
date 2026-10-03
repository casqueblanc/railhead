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
import type { ArtifactsRepoName } from "../src/contracts/artifacts";
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
  storage: DurableObjectStorage;
  /** Every alarm time a module asked for, in order. */
  wakes: number[];
  events: () => RailheadEvent[];
  file: (title: string) => Promise<string>;
  /** Files an issue, claims it for agent 1 and returns the opened claim and its fork's name. */
  open: () => Promise<{ claim: ClaimView; fork: string }>;
  /** Adds `commit` to the fork, as a push would. */
  push: (fork: string, commit: string) => void;
  /** Every repository `revokeTokens` was called for, in order. */
  revoked: ArtifactsRepoName[];
  /** Every repository a token was minted for through the port, in order. */
  minted: ArtifactsRepoName[];
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
    const adapter = createArtifactsAdapter(
      { ...context, namespace: fake },
      { ...ARTIFACTS_LIMITS, callTimeoutMs: 50 },
    );
    const artifacts: RepoPorts["artifacts"] = {
      forkForClaim: (claimId, forkBase) => adapter.forkForClaim(claimId, forkBase),
      commitExists: (repo, commit) => adapter.commitExists(repo, commit),
      token(repo, scope, ttlMs) {
        setup.minted.push(repo);
        return adapter.token(repo, scope, ttlMs);
      },
      revokeTokens(repo) {
        setup.revoked.push(repo);
        return adapter.revokeTokens(repo);
      },
    };
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
      storage: state.storage,
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
      revoked: [],
      minted: [],
    };
    const result = await body(setup);
    expect(fake.openHandles).toBe(0);
    return result;
  });
}

/**
 * Runs the Repo's alarm as the Repo would, up to and including the first firing that needs the
 * clock to move. Each firing happens at the earliest time any module asked for and forgets every
 * request, after which each module asks again from `resume`; a request at or before the current
 * time fires at once. Fails when no wake is pending, or when the alarm never settles.
 */
async function fireAlarm(setup: Setup): Promise<void> {
  if (setup.wakes.length === 0) throw new Error("no alarm was asked for");
  for (let firing = 0; firing < 8; firing += 1) {
    if (setup.wakes.length === 0) return;
    const at = Math.min(...setup.wakes);
    setup.wakes.length = 0;
    const now = setup.fake.clock();
    if (at > now) setup.fake.advance(at - now);
    await setup.port.resume();
    if (at > now) return;
  }
  throw new Error("the alarm kept asking to fire at once");
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

/** Records `option` as the owner's decision at `expectedVersion`. */
async function record(
  setup: Setup,
  decisionId: DecisionId,
  option: "reject" | "chunk",
  expectedVersion: number | null,
): Promise<void> {
  const recorded = await setup.decisions.record({
    kind: "human",
    userId: "usr_owner0001",
    repoId: REPO,
    grantId: crypto.randomUUID(),
    action: { kind: "decision.record", decisionId, option, expectedVersion },
  });
  if (!recorded.ok) throw new Error(`record refused: ${recorded.code}`);
}

/** Acknowledges every item delivered to `principal`. */
async function ackAll(setup: Setup, principal: AgentPrincipal): Promise<void> {
  const delivered = await setup.inbox.pending(principal, 16);
  if (!delivered.ok) throw new Error(`pending refused: ${delivered.code}`);
  for (const { item } of delivered.value.items) {
    const acked = await setup.inbox.ack(principal, item, "Follow the decision.");
    if (!acked.ok) throw new Error(`ack refused: ${acked.code}`);
  }
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

  it("gives a claim recorded before leases a lease when the module starts", async () => {
    await withTakeover(async (setup) => {
      const { claim } = await setup.open();
      const working = await setup.file("Add downloads");
      setup.sql.exec(
        `INSERT INTO claims_claims (claim_id, issue_id, agent_id, owner_id, generation, state, base)
         VALUES ('clm_legacyclaim1', ?, 'agt_agent0009', 'usr_owner0001', 1, 'working', ?)`,
        working,
        HEAD,
      );
      setup.sql.exec("UPDATE claims_claims SET lease_until = NULL");
      const unleased = setup.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM claims_claims WHERE lease_until IS NULL")
        .toArray()[0];
      expect(unleased?.n).toBe(2);

      // A restarted module backfills from its clock and asks for the lapse; nothing else is touched.
      const restartWakes: number[] = [];
      createClaims(
        {
          repoId: REPO,
          storage: setup.storage,
          log: setup.log,
          clock: setup.fake.clock,
          env,
          wake: (at) => {
            restartWakes.push(at);
          },
        },
        () => {
          throw new Error("ports are not read while building");
        },
      );
      const leases = setup.sql
        .exec<{ lease_until: number | null }>(
          "SELECT lease_until FROM claims_claims ORDER BY claim_id",
        )
        .toArray()
        .map((row) => row.lease_until);
      expect(leases).toEqual([
        setup.fake.clock() + CLAIM_LEASE_MS,
        setup.fake.clock() + CLAIM_LEASE_MS,
      ]);
      expect(restartWakes).toEqual([setup.fake.clock() + CLAIM_LEASE_MS]);

      setup.fake.advance(CLAIM_LEASE_MS);
      await setup.port.resume();
      expect(stored(setup.sql, claim.claimId).state).toBe("expired");
      expect(stored(setup.sql, "clm_legacyclaim1").state).toBe("expired");
    });
  });

  it("asks for the alarm when a claim opens, so it expires with no further calls", async () => {
    await withTakeover(async (setup) => {
      await setup.file("Add uploads");
      expect(setup.wakes).toEqual([]);
      const claimed = await setup.port.work(agent(1));
      if (!claimed.ok) throw new Error(`claim refused: ${claimed.code}`);
      const { claimId } = claimed.value.claim;
      const fork = await forkRepoName(REPO, claimId);
      const opened = setup.fake.clock();
      expect(setup.wakes).toEqual([opened + CLAIM_LEASE_MS]);
      const token = setup.fake.mintFor(fork, "write", 3600);

      // The agent dies. Only the alarm runs: it fires at the lapse, expires and revokes.
      await fireAlarm(setup);

      expect(setup.fake.clock()).toBe(opened + CLAIM_LEASE_MS);
      expect(setup.events().at(-1)).toMatchObject({
        type: "claim.expired",
        data: { claimId, generation: 1 },
      });
      expect(setup.fake.accepts(token.plaintext)).toBe(false);
      expect(stored(setup.sql, claimId)).toMatchObject({ state: "expired", revoke_due: null });
      // The revocation's own wake is spent; a later alarm finds nothing owed and asks for none.
      await fireAlarm(setup);
      expect(setup.wakes).toEqual([]);
    });
  });

  it("moves the alarm with each renewal and expires at the last lease's end", async () => {
    await withTakeover(async (setup) => {
      const { claim } = await setup.open();
      const opened = setup.fake.clock();
      setup.fake.advance(CLAIM_LEASE_MS / 2);
      expect(await setup.port.activeClaim(agent(1))).toEqual(ok(claim));
      const renewed = setup.fake.clock();
      expect(setup.wakes.at(-1)).toBe(renewed + CLAIM_LEASE_MS);

      // The alarm set at opening fires first, finds the lease renewed and asks for its new end.
      await fireAlarm(setup);
      expect(setup.fake.clock()).toBe(opened + CLAIM_LEASE_MS);
      expect(stored(setup.sql, claim.claimId).state).toBe("working");
      expect(new Set(setup.wakes)).toEqual(new Set([renewed + CLAIM_LEASE_MS]));

      await fireAlarm(setup);
      expect(setup.fake.clock()).toBe(renewed + CLAIM_LEASE_MS);
      expect(stored(setup.sql, claim.claimId).state).toBe("expired");
      expect(types(setup.events()).filter((type) => type === "claim.expired")).toHaveLength(1);
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

  it("treats a partial token listing as unrevoked until a later sweep reports revoked", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const former = setup.fake.mintFor(fork, "write", 3600);
      // Each listing page holds only the fork's revoked initial token and hides the former holder's.
      setup.fake.pageTokens(1, "creation");
      setup.fake.advance(CLAIM_LEASE_MS);

      // The adapter reports a debt: the former holder's token is still live, so nobody may write.
      expectFailure(await setup.port.work(agent(2)), "busy");
      expectFailure(await setup.port.claim(agent(2), claim.issueId), "busy");
      expectFailure(
        await setup.port.authorizeGit(push(agent(2), claim.claimId)),
        "stale_generation",
      );
      // The second request finds the retry not yet due and does not sweep again.
      expect(setup.revoked).toEqual([fork]);
      expect(setup.fake.accepts(former.plaintext)).toBe(true);
      expect(stored(setup.sql, claim.claimId)).toMatchObject({
        agent_id: "agt_agent0001",
        generation: 1,
        state: "expired",
        revoke_due: setup.fake.clock() + REVOKE_RETRY_MS,
      });

      // At the retry the alarm sweeps again, still partially, and leaves the claim owed.
      await fireAlarm(setup);
      expect(setup.revoked).toEqual([fork, fork]);
      expect(stored(setup.sql, claim.claimId).revoke_due).toBe(
        setup.fake.clock() + REVOKE_RETRY_MS,
      );
      expectFailure(await setup.port.work(agent(2)), "busy");
      expect(types(setup.events())).not.toContain("claim.reassigned");
      expect(setup.minted).toEqual([]);

      // The next alarm's listing covers every token; only now does the successor get the claim and
      // a write grant.
      setup.fake.pageTokens(null);
      await fireAlarm(setup);
      expect(stored(setup.sql, claim.claimId).revoke_due).toBeNull();
      expect(setup.fake.accepts(former.plaintext)).toBe(false);
      expect(await setup.port.work(agent(2))).toMatchObject({
        ok: true,
        value: { claim: { claimId: claim.claimId, generation: 2 } },
      });
      expect(await setup.port.authorizeGit(push(agent(2), claim.claimId))).toMatchObject({
        ok: true,
        value: { scope: "write", fence: { claimId: claim.claimId, generation: 2 } },
      });
    });
  });

  it("keeps an expired claim with a pending revocation ahead of a newer open issue", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const newer = await setup.file("Add downloads");
      const former = setup.fake.mintFor(fork, "write", 3600);
      setup.fake.pageTokens(1, "creation");
      setup.fake.advance(CLAIM_LEASE_MS);

      // While the release is pending, another agent is told to wait rather than handed the newer issue.
      expectFailure(await setup.port.work(agent(2)), "busy");
      expectFailure(await setup.port.work(agent(3)), "busy");
      const claimed = setup.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM claims_claims WHERE issue_id = ?", newer)
        .toArray()[0];
      expect(claimed?.n).toBe(0);
      expect(setup.revoked).toEqual([fork]);
      expect(setup.fake.accepts(former.plaintext)).toBe(true);

      // Once a sweep settles, the expired claim goes first and the newer issue to the next agent.
      setup.fake.pageTokens(null);
      await fireAlarm(setup);
      expect(setup.fake.accepts(former.plaintext)).toBe(false);
      expect(await setup.port.work(agent(2))).toMatchObject({
        ok: true,
        value: { claim: { claimId: claim.claimId, generation: 2 } },
      });
      expect(await setup.port.work(agent(3))).toMatchObject({
        ok: true,
        value: { claim: { issueId: newer, generation: 1 } },
      });
    });
  });

  it("lets the former holder take a newer issue while its own expired claim is released", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const newer = await setup.file("Add downloads");
      setup.fake.mintFor(fork, "write", 3600);
      setup.fake.pageTokens(1, "creation");
      setup.fake.advance(CLAIM_LEASE_MS);

      // Its own expired claim is never offered back, so it does not wait on it.
      expect(await setup.port.work(agent(1))).toMatchObject({
        ok: true,
        value: { claim: { issueId: newer, generation: 1 } },
      });
      expect(stored(setup.sql, claim.claimId)).toMatchObject({
        agent_id: "agt_agent0001",
        state: "expired",
      });
      expectFailure(await setup.port.work(agent(2)), "busy");
    });
  });

  it("renews an allocation its holder resumes a millisecond before the lease lapses", async () => {
    await withTakeover(async (setup) => {
      await setup.file("Add uploads");
      setup.fake.failNextFork("lose-response");
      expect(await setup.port.work(agent(1))).toMatchObject({ ok: false });

      setup.fake.advance(CLAIM_LEASE_MS - 1);
      expect(await setup.port.activeClaim(agent(1))).toMatchObject({
        ok: true,
        value: { generation: 1, base: HEAD, state: "working" },
      });
      expectFailure(await setup.port.work(agent(2)), "no_work");
    });
  });

  it("never renews a lapsed allocation for its former holder, which leaves it to the successor", async () => {
    await withTakeover(async (setup) => {
      const issueId = await setup.file("Add uploads");
      setup.fake.failNextFork("lose-response");
      expect(await setup.port.work(agent(1))).toMatchObject({ ok: false });
      const [intent] = setup.sql
        .exec<{ claim_id: string; lease_until: number }>(
          "SELECT claim_id, lease_until FROM claims_claims",
        )
        .toArray();
      if (intent === undefined) throw new Error("no fork intent was recorded");

      // At the deadline the former holder calls first: status, work and claim all find it lapsed.
      setup.fake.advance(CLAIM_LEASE_MS);
      expect(await setup.port.activeClaim(agent(1))).toEqual(ok(null));
      expectFailure(await setup.port.work(agent(1)), "busy");
      expectFailure(await setup.port.claim(agent(1), issueId), "busy");
      expect(
        setup.sql
          .exec<{ lease_until: number; state: string; generation: number }>(
            "SELECT lease_until, state, generation FROM claims_claims",
          )
          .toArray(),
      ).toEqual([{ lease_until: intent.lease_until, state: "allocating", generation: 1 }]);
      expect(setup.fake.forkCalls).toBe(1);
      expect(types(setup.events())).not.toContain("claim.opened");

      // The successor takes it at the next generation; the former holder is then free and idle.
      expect(await setup.port.work(agent(2))).toMatchObject({
        ok: true,
        value: { claim: { claimId: intent.claim_id, generation: 2 } },
      });
      expect(await setup.port.activeClaim(agent(1))).toEqual(ok(null));
      expectFailure(await setup.port.work(agent(1)), "no_work");
    });
  });

  it("hands over no newer expired claim while an older one's revocation is pending", async () => {
    await withTakeover(async (setup) => {
      const older = await setup.open();
      const newerIssue = await setup.file("Add downloads");
      const newer = await setup.port.work(agent(2));
      if (!newer.ok) throw new Error(`claim refused: ${newer.code}`);
      const newerId = newer.value.claim.claimId;
      // Only the older fork holds a token the partial listing hides, so only its sweep stays owed.
      const former = setup.fake.mintFor(older.fork, "write", 3600);
      setup.fake.pageTokens(1, "creation");
      setup.fake.advance(CLAIM_LEASE_MS);
      await setup.port.resume();
      expect(stored(setup.sql, older.claim.claimId)).toMatchObject({
        state: "expired",
        revoke_due: setup.fake.clock() + REVOKE_RETRY_MS,
      });
      expect(stored(setup.sql, newerId)).toMatchObject({ state: "expired", revoke_due: null });

      // Neither a new agent nor the older claim's former holder gets the newer settled claim.
      expectFailure(await setup.port.work(agent(3)), "busy");
      expectFailure(await setup.port.claim(agent(3), newerIssue), "busy");
      expectFailure(await setup.port.work(agent(1)), "busy");
      expect(stored(setup.sql, newerId)).toMatchObject({
        agent_id: "agt_agent0002",
        generation: 1,
        state: "expired",
      });
      expect(types(setup.events())).not.toContain("claim.reassigned");
      expect(setup.fake.accepts(former.plaintext)).toBe(true);

      // Once the older sweep settles, the claims go in issue order.
      setup.fake.pageTokens(null);
      await fireAlarm(setup);
      expect(setup.fake.accepts(former.plaintext)).toBe(false);
      expect(await setup.port.work(agent(3))).toMatchObject({
        ok: true,
        value: { claim: { claimId: older.claim.claimId, generation: 2 } },
      });
      expect(await setup.port.claim(agent(4), newerIssue)).toMatchObject({
        ok: true,
        value: { claim: { claimId: newerId, generation: 2 } },
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

describe("revocation at ready", () => {
  it("withholds the pin while the revocation is pending and settles it on the alarm", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      const live = setup.fake.mintFor(fork, "write", 3600);
      // The listing hides the live token, so Artifacts reports a debt rather than `revoked`.
      setup.fake.pageTokens(1, "creation");
      const ready = { generation: 1, commit: WORK };

      expectFailure(await setup.port.ready(agent(1), claim.claimId, ready), "busy");
      expect(stored(setup.sql, claim.claimId)).toMatchObject({
        state: "ready",
        revoke_due: setup.fake.clock() + REVOKE_RETRY_MS,
      });
      expect(setup.fake.accepts(live.plaintext)).toBe(true);
      expectFailure(await setup.port.pin(claim.claimId), "busy");
      expect(setup.wakes).toContain(setup.fake.clock() + REVOKE_RETRY_MS);

      // The holder's repeat revokes again; still partial, it is still refused.
      expectFailure(await setup.port.ready(agent(1), claim.claimId, ready), "busy");
      expect(setup.revoked).toEqual([fork, fork]);

      // The alarm's retry sees every token; only then does the train get the pin.
      setup.fake.pageTokens(null);
      await fireAlarm(setup);
      expect(setup.revoked).toEqual([fork, fork, fork]);
      expect(stored(setup.sql, claim.claimId)).toMatchObject({ state: "ready", revoke_due: null });
      expect(setup.fake.accepts(live.plaintext)).toBe(false);
      expect(await setup.port.pin(claim.claimId)).toEqual(
        ok({ claimId: claim.claimId, generation: 1, commit: WORK }),
      );

      // A later repeat answers with the pin and revokes nothing more.
      expect(await setup.port.ready(agent(1), claim.claimId, ready)).toMatchObject({
        ok: true,
        value: { repeated: true, claim: { readyCommit: WORK } },
      });
      expect(setup.revoked).toHaveLength(3);
      expect(types(setup.events()).filter((type) => type === "claim.ready")).toHaveLength(1);
    });
  });

  it("drops the pin's pending revocation when a newer decision reopens the claim", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
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
      await record(setup, asked.value.decisionId, "chunk", null);
      await ackAll(setup, agent(1));
      setup.fake.mintFor(fork, "write", 3600);
      setup.fake.pageTokens(1, "creation");
      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, { generation: 1, commit: WORK }),
        "busy",
      );

      // A newer version supersedes the pin; the holder works again and owes no revocation.
      await record(setup, asked.value.decisionId, "reject", 1);
      expectFailure(await setup.port.pin(claim.claimId), "decision_superseded");
      expect(stored(setup.sql, claim.claimId)).toMatchObject({
        state: "working",
        revoke_due: null,
      });

      // The alarm's retry time passes without revoking the holder's new write grant.
      setup.fake.advance(REVOKE_RETRY_MS);
      await setup.port.resume();
      expect(setup.revoked).toEqual([fork]);
      expect(await setup.port.authorizeGit(push(agent(1), claim.claimId))).toMatchObject({
        ok: true,
        value: { scope: "write", fence: { generation: 1 } },
      });
    });
  });

  it("revokes once and answers the pin when the first revocation settles", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      const live = setup.fake.mintFor(fork, "write", 3600);

      expect(
        await setup.port.ready(agent(1), claim.claimId, { generation: 1, commit: WORK }),
      ).toMatchObject({ ok: true, value: { repeated: false } });
      expect(setup.revoked).toEqual([fork]);
      expect(stored(setup.sql, claim.claimId)).toMatchObject({ state: "ready", revoke_due: null });
      expect(setup.fake.accepts(live.plaintext)).toBe(false);
      expect(await setup.port.pin(claim.claimId)).toEqual(
        ok({ claimId: claim.claimId, generation: 1, commit: WORK }),
      );
    });
  });
});
