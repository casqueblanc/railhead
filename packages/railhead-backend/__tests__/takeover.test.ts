import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ClaimView } from "@railhead/shared/agent-api";
import type { DecisionId, RailheadEvent } from "@railhead/shared/events";
import {
  ARTIFACTS_LIMITS,
  createArtifactsAdapter,
  forkRepoName,
  mainRepoName,
} from "../src/artifacts/adapter";
import { FakeArtifacts } from "../src/artifacts/fake";
import type { ArtifactsPort, ArtifactsRepoName } from "../src/contracts/artifacts";
import type { ClaimsPort } from "../src/contracts/claims";
import type { DecisionsPort } from "../src/contracts/decisions";
import type { InboxPort } from "../src/contracts/inbox";
import type { AgentPrincipal, GrantFor } from "../src/contracts/principals";
import { fail, ok, type PortResult } from "../src/contracts/result";
import { unavailableSessions } from "../src/contracts/unavailable";
import { createGitGateway } from "../src/git/gateway";
import {
  CLAIM_LEASE_MS,
  CLAIMS_LIMITS,
  RELEASE_BATCH,
  REVOCATION_BARRIER_MS,
  REVOKE_RETRY_MS,
  createClaims,
  type ClaimsLimits,
} from "../src/modules/claims/module";
import { beginRevocation } from "../src/modules/claims/store";
import { createDecisions } from "../src/modules/decisions/decisions";
import { composeRepo, resumables, resumeAll, type RepoPorts } from "../src/repo/composeRepo";
import type { Repo } from "../src/repo/RepoObject";
import { EventLog } from "../src/repo/eventLog";
import { EarliestAlarm } from "../src/repo/storage";

const REPO = "rep_takeover001";
const ROOT = "1".repeat(40);
const HEAD = "2".repeat(40);
const WORK = "4".repeat(40);
const STALE = "5".repeat(40);
const SUCCESSOR = "6".repeat(40);
const ZERO = "0".repeat(40);

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
  /** The Artifacts port the claims module calls. */
  artifacts: ArtifactsPort;
  /** When set, each `revokeTokens` awaits it before reaching Artifacts. */
  holdRevocation: (() => Promise<void>) | null;
  /** When set, each `forkForClaim` awaits it after Artifacts answers, before returning. */
  holdFork: (() => Promise<void>) | null;
  /**
   * Fires the Repo's alarm as `Repo.alarm` does: the alarm forgets its time, every resumable module
   * resumes through `resumeAll`, and the alarm's writes settle. The clock does not move.
   */
  repoAlarm: () => Promise<void>;
  /** The time the Repo's alarm is set for, or `null` when none is set. */
  storedAlarm: () => number | null;
  /** How many times the alarm reached each module after claims. */
  laterResumes: { git: number; train: number };
  /**
   * A second claims module over the same storage and ports, as a Repo restarted after an eviction
   * would build. It knows nothing of the first module's running sweeps.
   */
  restarted: () => ClaimsPort;
  /**
   * A claims module and an Artifacts adapter both new, over the same storage, as a Repo recreated
   * after an eviction would build: neither knows of the first Repo's running sweeps or mints. Its
   * revocations and mints are recorded in `revoked` and `minted` too, and each revocation awaits
   * `holdRevocation`, when given, before reaching Artifacts.
   */
  rebooted: (holdRevocation?: () => Promise<void>) => {
    claims: ClaimsPort;
    artifacts: ArtifactsPort;
  };
}

/**
 * Runs `body` in a fresh Repo with real claims, inbox and decisions, and fake Artifacts, under
 * `limits`.
 */
function withTakeover<T>(
  body: (setup: Setup) => Promise<T>,
  limits: ClaimsLimits = CLAIMS_LIMITS,
): Promise<T> {
  const stub: DurableObjectStub<Repo> = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    const fake = new FakeArtifacts();
    fake.seed(await mainRepoName(REPO), [ROOT, HEAD]);
    const log = EventLog.open(state.storage, REPO, fake.clock);
    const wakes: number[] = [];
    // The alarm's storage is kept here, so no real alarm fires in the background.
    let storedAlarm: number | null = null;
    const alarm = new EarliestAlarm(
      {
        getAlarm: async () => storedAlarm,
        setAlarm: async (at) => {
          storedAlarm = typeof at === "number" ? at : at.getTime();
        },
      },
      noop,
    );
    await alarm.load();
    const context = {
      repoId: REPO,
      storage: state.storage,
      log,
      clock: fake.clock,
      env,
      wake: (at: number) => {
        wakes.push(at);
        void alarm.request(at);
      },
    };
    const base = composeRepo(context);
    const adapter = createArtifactsAdapter(
      { ...context, namespace: fake },
      { ...ARTIFACTS_LIMITS, callTimeoutMs: 50 },
    );
    const artifacts: RepoPorts["artifacts"] = {
      async forkForClaim(claimId, forkBase) {
        const forked = await adapter.forkForClaim(claimId, forkBase);
        await setup.holdFork?.();
        return forked;
      },
      commitExists: (repo, commit) => adapter.commitExists(repo, commit),
      token(repo, scope, ttlMs) {
        setup.minted.push(repo);
        return adapter.token(repo, scope, ttlMs);
      },
      async revokeTokens(repo, cutoff) {
        setup.revoked.push(repo);
        await setup.holdRevocation?.();
        return adapter.revokeTokens(repo, cutoff);
      },
    };
    const decisions = createDecisions(context, () => ports);
    const port = createClaims(context, () => ports, limits);
    const laterResumes = { git: 0, train: 0 };
    const ports: RepoPorts = {
      ...base,
      claims: port,
      artifacts,
      decisions,
      mainWriter: { ...base.mainWriter, head: async () => ok(HEAD) },
      git: {
        ...base.git,
        resume() {
          laterResumes.git += 1;
          return base.git.resume();
        },
      },
      train: {
        ...base.train,
        resume() {
          laterResumes.train += 1;
          return base.train.resume();
        },
      },
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
      artifacts,
      holdRevocation: null,
      holdFork: null,
      async repoAlarm() {
        alarm.fired();
        storedAlarm = null;
        await resumeAll(REPO, resumables(ports));
        await alarm.settle();
      },
      storedAlarm: () => storedAlarm,
      laterResumes,
      restarted: () => createClaims(context, () => ports, limits),
      rebooted(holdRevocation) {
        const fresh = createArtifactsAdapter(
          { ...context, namespace: fake },
          { ...ARTIFACTS_LIMITS, callTimeoutMs: 50 },
        );
        const freshArtifacts: ArtifactsPort = {
          forkForClaim: (claimId, forkBase) => fresh.forkForClaim(claimId, forkBase),
          commitExists: (repo, commit) => fresh.commitExists(repo, commit),
          token(repo, scope, ttlMs) {
            setup.minted.push(repo);
            return fresh.token(repo, scope, ttlMs);
          },
          async revokeTokens(repo, cutoff) {
            setup.revoked.push(repo);
            await holdRevocation?.();
            return fresh.revokeTokens(repo, cutoff);
          },
        };
        // The module reads its ports only when called, never while it is built.
        const claims: ClaimsPort = createClaims(
          context,
          () => ({ ...ports, claims, artifacts: freshArtifacts }),
          limits,
        );
        return { claims, artifacts: freshArtifacts };
      },
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

/**
 * Fires the Repo's alarm again while it is set at or before the current time, as the runtime
 * would, without moving the clock. Fails when it keeps asking to fire at once.
 */
async function fireDue(setup: Setup): Promise<void> {
  for (let firing = 0; firing < 8; firing += 1) {
    const at = setup.storedAlarm();
    if (at === null || at > setup.fake.clock()) return;
    await setup.repoAlarm();
  }
  throw new Error("the Repo's alarm kept asking to fire at once");
}

function noop(): void {}

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = noop;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** How many claims, of any state, the issue has. */
function claimsOn(setup: Setup, issueId: string): number {
  const [row] = setup.sql
    .exec<{ n: number }>("SELECT COUNT(*) AS n FROM claims_claims WHERE issue_id = ?", issueId)
    .toArray();
  return row?.n ?? 0;
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

/** Every stored revocation barrier, by claim and attempt. */
function barriers(sql: SqlStorage): { claim_id: string; attempt: number; expires_at: number }[] {
  return sql
    .exec<{ claim_id: string; attempt: number; expires_at: number }>(
      `SELECT claim_id, attempt, expires_at FROM claims_revocation_barriers
       ORDER BY claim_id, attempt`,
    )
    .toArray();
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

/**
 * Asks a question on the claim for `principal`, records the owner's first answer and has the
 * holder acknowledge it, so the claim can be marked ready under version 1.
 */
async function decideOnce(
  setup: Setup,
  principal: AgentPrincipal,
  claimId: string,
): Promise<DecisionId> {
  const asked = await setup.decisions.ask(principal, claimId, {
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
  await ackAll(setup, principal);
  return asked.value.decisionId;
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

/**
 * Files `count` issues and has agents 1 to `count` claim them in filing order, all leased until the
 * same time. Claim ids are minted in descending order, so the earliest filed issue's claim sorts
 * last by claim id, the order in which lapsed claims are expired.
 */
async function claimInFilingOrder(
  setup: Setup,
  count: number,
): Promise<{ issues: string[]; claims: { claimId: string; fork: string }[] }> {
  const issues: string[] = [];
  for (let n = 1; n <= count; n += 1) issues.push(await setup.file(`Issue ${n}`));
  let minted = 0;
  const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    minted += 1;
    const tail = (0xffffffffffff - minted).toString(16).padStart(12, "0");
    return `ffffffff-ffff-4fff-8fff-${tail}`;
  });
  const claims: { claimId: string; fork: string }[] = [];
  try {
    for (let n = 1; n <= count; n += 1) {
      const claimed = await setup.port.work(agent(n));
      if (!claimed.ok) throw new Error(`claim refused: ${claimed.code}`);
      expect(claimed.value.claim.issueId).toBe(issues[n - 1]);
      const { claimId } = claimed.value.claim;
      claims.push({ claimId, fork: await forkRepoName(REPO, claimId) });
    }
  } finally {
    uuid.mockRestore();
  }
  const ids = claims.map(({ claimId }) => claimId);
  expect(ids.toSorted().at(-1)).toBe(ids[0]);
  return { issues, claims };
}

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

  it("fences a working claim in both readers at its exact deadline, before any expiry is recorded", async () => {
    await withTakeover(async (setup) => {
      const { claim } = await setup.open();

      setup.fake.advance(CLAIM_LEASE_MS - 1);
      expect(setup.port.currentGeneration(claim.claimId)).toBe(1);
      expect(setup.port.workingGeneration(claim.claimId)).toBe(1);
      setup.fake.advance(1);
      expect(setup.port.currentGeneration(claim.claimId)).toBeNull();
      expect(setup.port.workingGeneration(claim.claimId)).toBeNull();
      // Neither read records anything: the claim is still stored as working, with no expiry.
      expect(stored(setup.sql, claim.claimId)).toMatchObject({ state: "working", generation: 1 });
      expect(types(setup.events())).not.toContain("claim.expired");
    });
  });

  it("keeps a holder's claim while its work or claim call awaits slow revocations past its deadline", async () => {
    for (const call of ["work", "claim"] as const) {
      await withTakeover(async (setup) => {
        // Agent 1's claim lapses while agent 2's, opened a second later, is a second from lapsing.
        const old = await setup.open();
        setup.fake.advance(1_000);
        const issueId = await setup.file("Add downloads");
        const held = await setup.port.work(agent(2));
        if (!held.ok) throw new Error(`claim refused: ${held.code}`);
        const { claimId } = held.value.claim;
        setup.fake.advance(CLAIM_LEASE_MS - 1);

        // Agent 2 calls a millisecond inside its lease; the revocation of agent 1's fork, which that
        // call triggers, is held until the clock is past agent 2's original deadline.
        const entered = deferred();
        const released = deferred();
        setup.holdRevocation = () => {
          entered.resolve();
          return released.promise;
        };
        const answer =
          call === "work" ? setup.port.work(agent(2)) : setup.port.claim(agent(2), issueId);
        await entered.promise;
        setup.fake.advance(2);
        released.resolve();

        expect(await answer, call).toMatchObject({
          ok: true,
          value: { claim: { claimId, issueId, generation: 1, state: "working" }, resumed: true },
        });
        expect(setup.revoked, call).toEqual([old.fork]);
        expect(stored(setup.sql, claimId), call).toMatchObject({
          state: "working",
          agent_id: agent(2).agentId,
        });
        expect(setup.port.workingGeneration(claimId), call).toBe(1);
        expect(
          setup.events().filter((event) => event.type === "claim.expired"),
          call,
        ).toMatchObject([{ data: { claimId: old.claim.claimId, generation: 1 } }]);
      });
    }
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

  it("keeps a wake when a revocation throws on the alarm, and hands the claim over once it recovers", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const former = setup.fake.mintFor(fork, "write", 3600);
      setup.fake.advance(CLAIM_LEASE_MS);
      setup.holdRevocation = () => Promise.reject(new Error("storage reset"));

      // The alarm expires the claim and its revocation throws. The alarm still reaches the later
      // modules and stays set for the retry, so the owed revocation is not stranded.
      await setup.repoAlarm();
      expect(setup.laterResumes).toEqual({ git: 1, train: 1 });
      await fireDue(setup);
      const retry = setup.fake.clock() + REVOKE_RETRY_MS;
      expect(stored(setup.sql, claim.claimId)).toMatchObject({
        state: "expired",
        revoke_due: retry,
      });
      expect(setup.storedAlarm()).toBe(retry);
      expect(setup.revoked).toEqual([fork]);
      expect(setup.fake.accepts(former.plaintext)).toBe(true);
      expectFailure(await setup.port.work(agent(2)), "busy");
      expect(setup.storedAlarm()).toBe(retry);

      // At the retry the revocation no longer throws: the alarm settles it and nothing stays owed.
      setup.holdRevocation = null;
      setup.fake.advance(REVOKE_RETRY_MS);
      await setup.repoAlarm();
      await fireDue(setup);
      expect(stored(setup.sql, claim.claimId).revoke_due).toBeNull();
      expect(setup.storedAlarm()).toBeNull();
      expect(setup.fake.accepts(former.plaintext)).toBe(false);
      expect(setup.revoked).toEqual([fork, fork]);

      expect(await setup.port.work(agent(2))).toMatchObject({
        ok: true,
        value: { claim: { claimId: claim.claimId, generation: 2 } },
      });
      expect(types(setup.events()).at(-1)).toBe("claim.reassigned");
    });
  });

  it("revokes at most one fork per work or claim call and drains the rest across alarms that reach the later modules", async () => {
    for (const call of ["work", "claim"] as const) {
      await withTakeover(async (setup) => {
        const sweepMs = 20_000;
        const claims: { claimId: string; issueId: string; fork: string }[] = [];
        for (let n = 1; n <= 6; n += 1) {
          const issueId = await setup.file(`Issue ${n}`);
          const claimed = await setup.port.work(agent(n));
          if (!claimed.ok) throw new Error(`claim refused: ${claimed.code}`);
          const { claimId } = claimed.value.claim;
          claims.push({ claimId, issueId, fork: await forkRepoName(REPO, claimId) });
        }
        const forks = claims.map(({ fork }) => fork);
        const owed = (): number =>
          setup.sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) AS n FROM claims_claims WHERE revoke_due IS NOT NULL",
            )
            .one().n;
        // Every lease lapses together, and each revocation takes a slow sweep.
        setup.fake.advance(CLAIM_LEASE_MS);
        setup.holdRevocation = async () => {
          setup.fake.advance(sweepMs);
        };

        // Agent 7's call expires all six but awaits only the oldest issue's sweep, then takes it over.
        const started = setup.fake.clock();
        const oldest = claims[0]?.issueId ?? "";
        const answer =
          call === "work" ? setup.port.work(agent(7)) : setup.port.claim(agent(7), oldest);
        expect(await answer, call).toMatchObject({
          ok: true,
          value: { claim: { claimId: claims[0]?.claimId, generation: 2 } },
        });
        expect(setup.fake.clock() - started).toBe(sweepMs);
        expect(setup.revoked).toEqual(forks.slice(0, 1));
        expect(owed()).toBe(5);
        // The rest are owed now, so the alarm is due at once.
        expect(setup.storedAlarm()).toBeLessThanOrEqual(setup.fake.clock());

        // The first alarm sweeps four, oldest first, reaches the later modules and stays due at once.
        await setup.repoAlarm();
        expect(setup.revoked).toEqual(forks.slice(0, 5));
        expect(setup.laterResumes).toEqual({ git: 1, train: 1 });
        expect(owed()).toBe(1);
        expect(setup.storedAlarm()).toBeLessThanOrEqual(setup.fake.clock());

        // The next sweeps the last; the alarm then waits for agent 7's lease.
        await setup.repoAlarm();
        expect(setup.revoked).toEqual(forks);
        expect(setup.laterResumes).toEqual({ git: 2, train: 2 });
        expect(owed()).toBe(0);
        await fireDue(setup);
        expect(setup.revoked).toEqual(forks);
        expect(setup.storedAlarm()).toBe(started + sweepMs + CLAIM_LEASE_MS);

        // The next expired claim is settled already, so agent 8 takes it over with no sweep.
        expect(await setup.port.work(agent(8))).toMatchObject({
          ok: true,
          value: { claim: { claimId: claims[1]?.claimId, generation: 2 } },
        });
        expect(setup.revoked).toEqual(forks);
      });
    }
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

  it("joins the sweep already running for a claim instead of starting another", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const former = setup.fake.mintFor(fork, "write", 3600);
      setup.fake.advance(CLAIM_LEASE_MS);
      const held = deferred();
      setup.holdRevocation = () => held.promise;

      const alarm = setup.port.resume();
      await vi.waitFor(() => expect(setup.revoked).toEqual([fork]), { timeout: 1000 });
      const successor = setup.port.work(agent(2));
      held.resolve();
      await alarm;

      expect(await successor).toMatchObject({
        ok: true,
        value: { claim: { claimId: claim.claimId, generation: 2 } },
      });
      expect(setup.revoked).toEqual([fork]);
      expect(setup.fake.accepts(former.plaintext)).toBe(false);
    });
  });

  it("keeps a claim owed when overlapping sweeps answer clean and partial in either order", async () => {
    // Which sweep lists every token, the one started first or second, and whether it answers first.
    const cases = [
      { clean: "earlier", answers: "first" },
      { clean: "later", answers: "first" },
      { clean: "earlier", answers: "last" },
    ] as const;
    for (const { clean, answers } of cases) {
      const label = `${clean} clean sweep answers ${answers}`;
      await withTakeover(async (setup) => {
        const { claim, fork } = await setup.open();
        const former = setup.fake.mintFor(fork, "write", 3600);
        setup.fake.advance(CLAIM_LEASE_MS);
        const holds = [deferred(), deferred()];
        setup.holdRevocation = () => holds[setup.revoked.length - 1]?.promise ?? Promise.resolve();

        // The alarm's sweep is running when the Repo restarts and a second module starts another,
        // so the per-claim join cannot serialize them. Both are held before Artifacts answers.
        const first = setup.port.resume();
        await vi.waitFor(() => expect(setup.revoked).toEqual([fork]), { timeout: 1000 });
        const second = setup.restarted().resume();
        await vi.waitFor(() => expect(setup.revoked).toEqual([fork, fork]), { timeout: 1000 });
        const [cleanSweep, partialSweep] = clean === "earlier" ? [first, second] : [second, first];
        const [cleanHold, partialHold] =
          clean === "earlier" ? [holds[0], holds[1]] : [holds[1], holds[0]];

        const answer = async (sweep: "clean" | "partial"): Promise<void> => {
          if (sweep === "clean") setup.fake.pageTokens(null);
          else setup.fake.pageTokens(1, "creation");
          (sweep === "clean" ? cleanHold : partialHold)?.resolve();
          await (sweep === "clean" ? cleanSweep : partialSweep);
        };
        const order =
          answers === "first" ? (["clean", "partial"] as const) : (["partial", "clean"] as const);
        for (const sweep of order) await answer(sweep);

        const retry = setup.fake.clock() + REVOKE_RETRY_MS;
        expect(stored(setup.sql, claim.claimId), label).toMatchObject({
          agent_id: "agt_agent0001",
          generation: 1,
          state: "expired",
          revoke_due: retry,
        });
        expectFailure(await setup.port.work(agent(2)), "busy");
        expectFailure(await setup.port.claim(agent(2), claim.issueId), "busy");
        expectFailure(
          await setup.port.authorizeGit(push(agent(2), claim.claimId)),
          "stale_generation",
        );
        expect(types(setup.events())).not.toContain("claim.reassigned");
        expect(setup.minted).toEqual([]);
        expect(setup.wakes).toContain(retry);

        // The alarm retries at the retry time; a full listing settles the claim for the successor.
        setup.fake.pageTokens(null);
        await fireAlarm(setup);
        expect(setup.revoked).toEqual([fork, fork, fork]);
        expect(stored(setup.sql, claim.claimId).revoke_due).toBeNull();
        expect(setup.fake.accepts(former.plaintext)).toBe(false);
        expect(await setup.port.work(agent(2))).toMatchObject({
          ok: true,
          value: { claim: { claimId: claim.claimId, generation: 2 } },
        });
      });
    }
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

  it("keeps the former holder off a newer issue until its own expired claim is released", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const newer = await setup.file("Add downloads");
      setup.fake.mintFor(fork, "write", 3600);
      setup.fake.pageTokens(1, "creation");
      setup.fake.advance(CLAIM_LEASE_MS);

      // Its own expired claim is never offered back, but it still waits rather than skip ahead.
      expectFailure(await setup.port.work(agent(1)), "busy");
      expectFailure(await setup.port.claim(agent(1), newer), "busy");
      expectFailure(await setup.port.work(agent(2)), "busy");
      expect(claimsOn(setup, newer)).toBe(0);

      // Once a sweep settles, the former holder gets the newer issue and a successor the old claim.
      setup.fake.pageTokens(null);
      await fireAlarm(setup);
      expect(await setup.port.work(agent(1))).toMatchObject({
        ok: true,
        value: { claim: { issueId: newer, generation: 1 } },
      });
      expect(await setup.port.work(agent(2))).toMatchObject({
        ok: true,
        value: { claim: { claimId: claim.claimId, generation: 2 } },
      });
    });
  });

  it("refuses a named claim on a newer issue while an older revocation is pending", async () => {
    await withTakeover(async (setup) => {
      const older = await setup.file("Add previews");
      const pendingIssue = await setup.file("Add uploads");
      const newer = await setup.file("Add downloads");
      const opened = await setup.port.claim(agent(1), pendingIssue);
      if (!opened.ok) throw new Error(`claim refused: ${opened.code}`);
      const fork = await forkRepoName(REPO, opened.value.claim.claimId);
      const former = setup.fake.mintFor(fork, "write", 3600);
      // Every revocation call fails, so the expired claim stays owed.
      setup.fake.failRevocations(Number.MAX_SAFE_INTEGER);
      setup.fake.advance(CLAIM_LEASE_MS);

      expectFailure(await setup.port.claim(agent(2), newer), "busy");
      expectFailure(await setup.port.claim(agent(3), newer), "busy");
      expect(claimsOn(setup, newer)).toBe(0);
      expect(setup.fake.accepts(former.plaintext)).toBe(true);
      expect(stored(setup.sql, opened.value.claim.claimId)).toMatchObject({ state: "expired" });

      // The next sweep reaches Artifacts but lists the tokens only in part, so the claim stays owed.
      setup.fake.failRevocations(0);
      setup.fake.pageTokens(1, "creation");
      await fireAlarm(setup);
      expect(stored(setup.sql, opened.value.claim.claimId).revoke_due).not.toBeNull();
      expectFailure(await setup.port.claim(agent(2), newer), "busy");
      expect(claimsOn(setup, newer)).toBe(0);

      // An issue filed before the expired one is not behind it, so it can still be claimed.
      expect(await setup.port.claim(agent(2), older)).toMatchObject({
        ok: true,
        value: { claim: { issueId: older, generation: 1 }, resumed: false },
      });

      // Once a sweep settles, the newer issue is free to claim.
      setup.fake.pageTokens(null);
      await fireAlarm(setup);
      expect(setup.fake.accepts(former.plaintext)).toBe(false);
      expect(await setup.port.claim(agent(3), newer)).toMatchObject({
        ok: true,
        value: { claim: { issueId: newer, generation: 1 }, resumed: false },
      });
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

  it("hands over the earliest filed lapsed claim first when more lapse than one call expires", async () => {
    await withTakeover(
      async (setup) => {
        const count = RELEASE_BATCH + 1;
        const { issues, claims } = await claimInFilingOrder(setup, count);
        const earliest = claims[0] ?? { claimId: "", fork: "" };
        const second = claims[1] ?? { claimId: "", fork: "" };
        const former = setup.fake.mintFor(earliest.fork, "write", 3600);
        setup.fake.advance(CLAIM_LEASE_MS);

        // The call's batch expires every claim but the earliest filed one and settles the second
        // issue's revocation. Selection still finds the earliest, expires it and hands nothing over.
        const successor = agent(count + 1);
        expectFailure(await setup.port.work(successor), "busy");
        expect(stored(setup.sql, earliest.claimId)).toMatchObject({
          agent_id: "agt_agent0001",
          generation: 1,
          state: "expired",
          revoke_due: setup.fake.clock(),
        });
        expect(stored(setup.sql, second.claimId)).toMatchObject({
          agent_id: "agt_agent0002",
          generation: 1,
          state: "expired",
          revoke_due: null,
        });
        expect(types(setup.events())).not.toContain("claim.reassigned");

        // While the earliest revocation is owed, no newer claim or write grant goes to anyone.
        setup.fake.failRevocations(Number.MAX_SAFE_INTEGER);
        expectFailure(await setup.port.work(successor), "busy");
        expectFailure(await setup.port.claim(successor, issues[1] ?? ""), "busy");
        expectFailure(
          await setup.port.authorizeGit(push(successor, second.claimId)),
          "stale_generation",
        );
        expect(setup.minted).toEqual([]);
        expect(setup.fake.accepts(former.plaintext)).toBe(true);
        expect(types(setup.events())).not.toContain("claim.reassigned");

        // Once its revocation settles at the retry, the earliest filed issue goes to the successor
        // first.
        setup.fake.failRevocations(0);
        setup.fake.advance(REVOKE_RETRY_MS);
        expect(await setup.port.work(successor)).toMatchObject({
          ok: true,
          value: { claim: { claimId: earliest.claimId, issueId: issues[0], generation: 2 } },
        });
        expect(setup.fake.accepts(former.plaintext)).toBe(false);
        expect(await setup.port.authorizeGit(push(successor, earliest.claimId))).toMatchObject({
          ok: true,
          value: { scope: "write", fence: { generation: 2 } },
        });
        expect(await setup.port.work(agent(count + 2))).toMatchObject({
          ok: true,
          value: { claim: { claimId: second.claimId, generation: 2 } },
        });
      },
      { maxActiveClaimsPerOwner: 64 },
    );
  });

  it("refuses a named claim on a newer issue while an older lapsed claim waits for a later batch", async () => {
    await withTakeover(
      async (setup) => {
        const count = RELEASE_BATCH + 1;
        const { issues, claims } = await claimInFilingOrder(setup, count);
        const earliest = claims[0] ?? { claimId: "", fork: "" };
        const second = claims[1] ?? { claimId: "", fork: "" };
        setup.fake.advance(CLAIM_LEASE_MS);

        // The call's batch leaves the earliest filed claim working and settles the second issue's
        // revocation, yet the second issue is not handed over ahead of the earliest.
        const successor = agent(count + 1);
        expectFailure(await setup.port.claim(successor, issues[1] ?? ""), "busy");
        expect(stored(setup.sql, earliest.claimId)).toMatchObject({
          generation: 1,
          state: "working",
        });
        expect(stored(setup.sql, second.claimId)).toMatchObject({
          agent_id: "agt_agent0002",
          generation: 1,
          state: "expired",
          revoke_due: null,
        });
        expectFailure(
          await setup.port.authorizeGit(push(successor, second.claimId)),
          "stale_generation",
        );
        expect(types(setup.events())).not.toContain("claim.reassigned");
      },
      { maxActiveClaimsPerOwner: 64 },
    );
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

  it("lets a same-owner successor take a lapsed allocation while the owner is at its limit", async () => {
    for (const via of ["work", "claim"] as const) {
      await withTakeover(
        async (setup) => {
          const issueId = await setup.file("Add uploads");
          setup.fake.failNextFork("lose-response");
          expect(await setup.port.work(agent(1))).toMatchObject({ ok: false });
          const [intent] = setup.sql
            .exec<{ claim_id: string }>("SELECT claim_id FROM claims_claims")
            .toArray();
          if (intent === undefined) throw new Error("no fork intent was recorded");
          const take = () =>
            via === "work" ? setup.port.work(agent(2)) : setup.port.claim(agent(2), issueId);

          // While the allocation's lease runs it fills the owner's one slot.
          const newer = await setup.file("Add downloads");
          setup.fake.advance(CLAIM_LEASE_MS - 1);
          await setup.port.resume();
          expectFailure(await setup.port.work(agent(2)), "quota_exceeded");
          expectFailure(await setup.port.claim(agent(2), newer), "quota_exceeded");
          expectFailure(await setup.port.claim(agent(2), issueId), "issue_unavailable");
          expect(stored(setup.sql, intent.claim_id)).toMatchObject({
            agent_id: "agt_agent0001",
            generation: 1,
            state: "allocating",
          });

          // Once it lapses it no longer counts, and the same owner's other agent takes it.
          setup.fake.advance(1);
          expect(await take()).toMatchObject({
            ok: true,
            value: { claim: { claimId: intent.claim_id, generation: 2, state: "working" } },
          });
          expect(stored(setup.sql, intent.claim_id)).toMatchObject({
            agent_id: "agt_agent0002",
            generation: 2,
            state: "working",
          });
          expect(setup.port.currentGeneration(intent.claim_id)).toBe(2);

          // The original agent stays fenced: no claim, no push and no ready at its generation.
          expect(await setup.port.activeClaim(agent(1))).toEqual(ok(null));
          expectFailure(
            await setup.port.authorizeGit(push(agent(1), intent.claim_id)),
            "stale_generation",
          );
          expectFailure(
            await setup.port.ready(agent(1), intent.claim_id, { generation: 1, commit: HEAD }),
            "stale_generation",
          );
        },
        { maxActiveClaimsPerOwner: 1 },
      );
    }
  });

  it("opens nothing when the fork answers after the allocation's lease lapsed", async () => {
    await withTakeover(async (setup) => {
      await setup.file("Add uploads");
      const gate = deferred();
      setup.holdFork = () => gate.promise;
      const first = setup.port.work(agent(1));
      // The fork exists, but its response is held until the lease has lapsed.
      await vi.waitFor(() => {
        expect(setup.fake.forkCalls).toBe(1);
      });
      const [intent] = setup.sql
        .exec<{ claim_id: string; lease_until: number }>(
          "SELECT claim_id, lease_until FROM claims_claims",
        )
        .toArray();
      if (intent === undefined) throw new Error("no fork intent was recorded");
      setup.fake.advance(CLAIM_LEASE_MS);
      setup.holdFork = null;
      gate.resolve();

      expectFailure(await first, "busy");
      expect(
        setup.sql
          .exec<{ state: string; generation: number; base: string | null; lease_until: number }>(
            "SELECT state, generation, base, lease_until FROM claims_claims",
          )
          .toArray(),
      ).toEqual([
        { state: "allocating", generation: 1, base: null, lease_until: intent.lease_until },
      ]);
      expect(types(setup.events())).not.toContain("claim.opened");
      expect(setup.port.currentGeneration(intent.claim_id)).toBeNull();

      // The intent is left for a successor, which opens the same fork at the next generation.
      expect(await setup.port.work(agent(2))).toMatchObject({
        ok: true,
        value: { claim: { claimId: intent.claim_id, generation: 2, base: HEAD } },
      });
      // The fork the late response named is the one the successor opens: no second fork.
      expect(setup.fake.forkCalls).toBe(1);
      expect(types(setup.events()).filter((type) => type === "claim.opened")).toHaveLength(1);
    });
  });

  it("opens a claim whose fork answers a millisecond before the lease lapses", async () => {
    await withTakeover(async (setup) => {
      await setup.file("Add uploads");
      const gate = deferred();
      setup.holdFork = () => gate.promise;
      const first = setup.port.work(agent(1));
      await vi.waitFor(() => {
        expect(setup.fake.forkCalls).toBe(1);
      });
      setup.fake.advance(CLAIM_LEASE_MS - 1);
      setup.holdFork = null;
      gate.resolve();

      expect(await first).toMatchObject({
        ok: true,
        value: { claim: { generation: 1, state: "working", base: HEAD } },
      });
      expect(types(setup.events())).toContain("claim.opened");
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

  it("skips a later claim of the alarm's batch that a newer decision reopened during an earlier sweep", async () => {
    await withTakeover(async (setup) => {
      const { claims } = await claimInFilingOrder(setup, 2);
      const [first, second] = claims;
      if (first === undefined || second === undefined) throw new Error("two claims expected");
      const decisionId = await decideOnce(setup, agent(2), second.claimId);
      setup.push(first.fork, WORK);
      setup.push(second.fork, SUCCESSOR);
      setup.fake.mintFor(first.fork, "write", 3600);
      setup.fake.mintFor(second.fork, "write", 3600);
      // Both listings are partial, so both pins owe a revocation the alarm retries.
      setup.fake.pageTokens(1, "creation");
      for (const [n, { claimId }, commit] of [
        [1, first, WORK],
        [2, second, SUCCESSOR],
      ] as const) {
        expectFailure(await setup.port.ready(agent(n), claimId, { generation: 1, commit }), "busy");
      }
      expect(setup.revoked).toEqual([first.fork, second.fork]);
      setup.fake.pageTokens(null);
      setup.fake.advance(REVOKE_RETRY_MS);

      // The alarm reads both due claims, then waits on the first claim's sweep.
      const held = deferred();
      setup.holdRevocation = () => held.promise;
      const alarm = setup.port.resume();
      await vi.waitFor(() => expect(setup.revoked).toHaveLength(3), { timeout: 1000 });

      // Meanwhile a newer decision reopens the second claim, whose holder pushes with a new token.
      await record(setup, decisionId, "reject", 1);
      await ackAll(setup, agent(2));
      expect(await setup.port.authorizeGit(push(agent(2), second.claimId))).toMatchObject({
        ok: true,
        value: { scope: "write", fence: { generation: 1 } },
      });
      const fresh = setup.fake.mintFor(second.fork, "write", 3600);
      held.resolve();
      await alarm;

      expect(setup.revoked).toEqual([first.fork, second.fork, first.fork]);
      expect(setup.fake.accepts(fresh.plaintext)).toBe(true);
      expect(stored(setup.sql, first.claimId)).toMatchObject({ state: "ready", revoke_due: null });
      expect(stored(setup.sql, second.claimId)).toMatchObject({
        state: "working",
        revoke_due: null,
      });
    });
  });

  it("answers a ready from the stored claim when a newer decision reopens it during the sweep", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const decisionId = await decideOnce(setup, agent(1), claim.claimId);
      setup.push(fork, WORK);
      const held = deferred();
      setup.holdRevocation = () => held.promise;
      const ready = { generation: 1, commit: WORK };
      const pending = setup.port.ready(agent(1), claim.claimId, ready);
      await vi.waitFor(() => expect(setup.revoked).toEqual([fork]), { timeout: 1000 });

      // The holder's push reopens the superseded pin, but waits for the running sweep to end.
      await record(setup, decisionId, "reject", 1);
      expectFailure(await setup.port.authorizeGit(push(agent(1), claim.claimId)), "busy");
      expect(stored(setup.sql, claim.claimId)).toMatchObject({
        state: "working",
        revoke_due: null,
      });
      held.resolve();

      // The sweep settled, but the pin it was for is gone: the holder must acknowledge and adapt.
      expectFailure(await pending, "unacked_decision");
      expect(types(setup.events()).filter((type) => type === "claim.reopened")).toHaveLength(1);
      expect(await setup.port.authorizeGit(push(agent(1), claim.claimId))).toMatchObject({
        ok: true,
        value: { scope: "write", fence: { generation: 1 } },
      });
      expectFailure(await setup.port.pin(claim.claimId), "claim_closed");
    });
  });

  it("refuses a restarted Repo's write grant until the sweep started before the restart ends, then keeps its token", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const decisionId = await decideOnce(setup, agent(1), claim.claimId);
      setup.push(fork, WORK);
      const former = setup.fake.mintFor(fork, "write", 3600);
      const held = deferred();
      setup.holdRevocation = () => held.promise;
      const pending = setup.port.ready(agent(1), claim.claimId, { generation: 1, commit: WORK });
      await vi.waitFor(() => expect(setup.revoked).toEqual([fork]), { timeout: 1000 });
      const barrierUntil = setup.fake.clock() + REVOCATION_BARRIER_MS;
      expect(barriers(setup.sql)).toMatchObject([
        { claim_id: claim.claimId, expires_at: barrierUntil },
      ]);

      // The Repo is recreated while the first sweep still waits on Artifacts. The new Repo's
      // memory holds no running sweep and its adapter no revocation, so only storage knows.
      const rebooted = setup.rebooted();
      await record(setup, decisionId, "reject", 1);
      await ackAll(setup, agent(1));
      const minted = setup.fake.tokensMinted;
      // The push reopens the superseded pin, and the barrier refuses it.
      expectFailure(await rebooted.claims.authorizeGit(push(agent(1), claim.claimId)), "busy");
      expect(stored(setup.sql, claim.claimId)).toMatchObject({
        state: "working",
        revoke_due: null,
      });
      expect(setup.fake.tokensMinted).toBe(minted);
      // The barrier's expiry is the earliest deadline left, so the alarm is asked for it.
      expect(setup.wakes.at(-1)).toBe(barrierUntil);

      // The first sweep ends and records its outcome, which lowers the barrier.
      held.resolve();
      expectFailure(await pending, "busy");
      expect(barriers(setup.sql)).toEqual([]);
      expect(setup.fake.accepts(former.plaintext)).toBe(false);

      const grant = await rebooted.claims.authorizeGit(push(agent(1), claim.claimId));
      expect(grant).toMatchObject({
        ok: true,
        value: { scope: "write", fence: { generation: 1 } },
      });
      const token = await rebooted.artifacts.token(fork, "write", 120_000);
      if (!token.ok) throw new Error(`token refused: ${token.code}`);
      expect(setup.fake.accepts(token.value.value)).toBe(true);

      // Neither Repo's alarm revokes it later: nothing is owed and no barrier stands.
      setup.fake.advance(REVOCATION_BARRIER_MS);
      await rebooted.claims.resume();
      await setup.port.resume();
      expect(setup.revoked).toEqual([fork]);
      expect(setup.fake.accepts(token.value.value)).toBe(true);
    });
  });

  it("keeps refusing grants past a lost sweep's barrier until the alarm's new sweep records its outcome", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const decisionId = await decideOnce(setup, agent(1), claim.claimId);
      setup.push(fork, WORK);
      const lost = deferred();
      setup.holdRevocation = () => lost.promise;
      const pending = setup.port.ready(agent(1), claim.claimId, { generation: 1, commit: WORK });
      await vi.waitFor(() => expect(setup.revoked).toEqual([fork]), { timeout: 1000 });
      const barrierUntil = setup.fake.clock() + REVOCATION_BARRIER_MS;
      const resweep = deferred();
      const rebooted = setup.rebooted(() => resweep.promise);
      await record(setup, decisionId, "reject", 1);
      await ackAll(setup, agent(1));
      expectFailure(await rebooted.claims.authorizeGit(push(agent(1), claim.claimId)), "busy");
      const missed = setup.fake.mintFor(fork, "write", 3600);

      // A millisecond before the barrier expires, the alarm leaves the first sweep to finish.
      setup.fake.advance(REVOCATION_BARRIER_MS - 1);
      await rebooted.claims.resume();
      expect(setup.revoked).toEqual([fork]);
      expectFailure(await rebooted.claims.authorizeGit(push(agent(1), claim.claimId)), "busy");

      // At expiry the alarm presumes that sweep lost and starts another under a new barrier.
      setup.fake.advance(1);
      expect(setup.fake.clock()).toBe(barrierUntil);
      const alarm = rebooted.claims.resume();
      await vi.waitFor(() => expect(setup.revoked).toEqual([fork, fork]), { timeout: 1000 });
      const [replacement] = barriers(setup.sql);
      expect(replacement).toMatchObject({
        claim_id: claim.claimId,
        expires_at: barrierUntil + REVOCATION_BARRIER_MS,
      });
      expectFailure(await rebooted.claims.authorizeGit(push(agent(1), claim.claimId)), "busy");

      // The lost sweep answers late; its outcome lowers only its own barrier.
      lost.resolve();
      await pending;
      expect(barriers(setup.sql)).toEqual([replacement]);
      expectFailure(await rebooted.claims.authorizeGit(push(agent(1), claim.claimId)), "busy");

      resweep.resolve();
      await alarm;
      expect(barriers(setup.sql)).toEqual([]);
      expect(setup.fake.accepts(missed.plaintext)).toBe(false);
      expect(await rebooted.claims.authorizeGit(push(agent(1), claim.claimId))).toMatchObject({
        ok: true,
        value: { scope: "write", fence: { generation: 1 } },
      });
    });
  });

  it("keeps a new holder's token when a lost sweep resumes after the replacing sweep lowered its barrier", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const decisionId = await decideOnce(setup, agent(1), claim.claimId);
      setup.push(fork, WORK);
      const former = setup.fake.mintFor(fork, "write", 3600);
      // Sweep A begins, recording its barrier and cutoff, then stalls before reaching Artifacts.
      const stalled = deferred();
      setup.holdRevocation = () => stalled.promise;
      const pending = setup.port.ready(agent(1), claim.claimId, { generation: 1, commit: WORK });
      await vi.waitFor(() => expect(setup.revoked).toEqual([fork]), { timeout: 1000 });

      // The Repo restarts, a newer decision reopens the claim, and the barrier refuses the push.
      const rebooted = setup.rebooted();
      await record(setup, decisionId, "reject", 1);
      await ackAll(setup, agent(1));
      expectFailure(await rebooted.claims.authorizeGit(push(agent(1), claim.claimId)), "busy");

      // A's barrier expires; the alarm's sweep B replaces it, revokes the former token and lowers it.
      setup.fake.advance(REVOCATION_BARRIER_MS);
      await rebooted.claims.resume();
      expect(setup.revoked).toEqual([fork, fork]);
      expect(barriers(setup.sql)).toEqual([]);
      expect(setup.fake.accepts(former.plaintext)).toBe(false);

      // The push is granted and a token minted for it.
      expect(await rebooted.claims.authorizeGit(push(agent(1), claim.claimId))).toMatchObject({
        ok: true,
        value: { scope: "write", fence: { generation: 1 } },
      });
      const token = await rebooted.artifacts.token(fork, "write", 120_000);
      if (!token.ok) throw new Error(`token refused: ${token.code}`);

      // A resumes and sweeps under its own cutoff, which the new token's mint is after.
      const listed = setup.fake.listTokensCalls;
      stalled.resolve();
      expectFailure(await pending, "busy");
      expect(setup.fake.listTokensCalls).toBeGreaterThan(listed);
      expect(setup.fake.accepts(token.value.value)).toBe(true);
      // A's outcome changes nothing: no barrier, nothing owed, and the push is still granted.
      expect(barriers(setup.sql)).toEqual([]);
      expect(stored(setup.sql, claim.claimId)).toMatchObject({
        state: "working",
        revoke_due: null,
      });
      expect(await rebooted.claims.authorizeGit(push(agent(1), claim.claimId))).toMatchObject({
        ok: true,
      });

      // Neither Repo's alarm sweeps again later.
      setup.fake.advance(REVOCATION_BARRIER_MS);
      await rebooted.claims.resume();
      await setup.port.resume();
      expect(setup.revoked).toEqual([fork, fork]);
      expect(setup.fake.accepts(token.value.value)).toBe(true);
    });
  });

  it("lowers a lost sweep's barrier when the new sweep fails, leaving the adapter to refuse the mint", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const decisionId = await decideOnce(setup, agent(1), claim.claimId);
      setup.push(fork, WORK);
      setup.holdRevocation = () => deferred().promise;
      void setup.port.ready(agent(1), claim.claimId, { generation: 1, commit: WORK });
      await vi.waitFor(() => expect(setup.revoked).toEqual([fork]), { timeout: 1000 });
      const rebooted = setup.rebooted();
      await record(setup, decisionId, "reject", 1);
      await ackAll(setup, agent(1));
      expectFailure(await rebooted.claims.authorizeGit(push(agent(1), claim.claimId)), "busy");
      setup.fake.mintFor(fork, "write", 3600);

      // The new sweep's listing is partial, so Artifacts reports a debt, not a revocation.
      setup.fake.pageTokens(1, "live-first");
      setup.fake.advance(REVOCATION_BARRIER_MS);
      await rebooted.claims.resume();
      expect(setup.revoked).toEqual([fork, fork]);
      expect(barriers(setup.sql)).toEqual([]);
      expect(stored(setup.sql, claim.claimId)).toMatchObject({
        state: "working",
        revoke_due: null,
      });

      // The claim grants the push, and the adapter refuses its token while the debt stands.
      expect(await rebooted.claims.authorizeGit(push(agent(1), claim.claimId))).toMatchObject({
        ok: true,
        value: { scope: "write" },
      });
      // A partial listing may hide a live token, so none is minted until a later sweep is clean.
      const minted = setup.fake.tokensMinted;
      expectFailure(await rebooted.artifacts.token(fork, "write", 120_000), "busy");
      expect(setup.fake.tokensMinted).toBe(minted);
    });
  });

  it("answers busy, then pins under the new version, when the holder acknowledges it during the sweep", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      const decisionId = await decideOnce(setup, agent(1), claim.claimId);
      setup.push(fork, WORK);
      const held = deferred();
      setup.holdRevocation = () => held.promise;
      const ready = { generation: 1, commit: WORK };
      const pending = setup.port.ready(agent(1), claim.claimId, ready);
      await vi.waitFor(() => expect(setup.revoked).toEqual([fork]), { timeout: 1000 });

      // Nothing reopens the claim before the sweep ends; the ready's own answer does.
      await record(setup, decisionId, "reject", 1);
      await ackAll(setup, agent(1));
      held.resolve();
      expectFailure(await pending, "busy");
      expect(stored(setup.sql, claim.claimId)).toMatchObject({
        state: "working",
        revoke_due: null,
      });

      setup.holdRevocation = null;
      expect(await setup.port.ready(agent(1), claim.claimId, ready)).toMatchObject({
        ok: true,
        value: { repeated: false, claim: { readyCommit: WORK } },
      });
      expect(await setup.port.pin(claim.claimId)).toEqual(
        ok({ claimId: claim.claimId, generation: 1, commit: WORK }),
      );
    });
  });

  it("starts a sweep only while the claim still owes the revocation the caller read", async () => {
    await withTakeover(async (setup) => {
      const { claim, fork } = await setup.open();
      setup.push(fork, WORK);
      setup.fake.mintFor(fork, "write", 3600);
      setup.fake.pageTokens(1, "creation");
      expectFailure(
        await setup.port.ready(agent(1), claim.claimId, { generation: 1, commit: WORK }),
        "busy",
      );
      const owedAt = setup.fake.clock() + REVOKE_RETRY_MS;
      const read = {
        claimId: claim.claimId,
        generation: 1,
        state: "ready",
        revokeDue: owedAt,
      } as const;
      const attempts = () =>
        setup.sql
          .exec<{ n: number }>(
            "SELECT revoke_attempt AS n FROM claims_claims WHERE claim_id = ?",
            claim.claimId,
          )
          .one().n;
      const before = attempts();
      const until = setup.fake.clock() + REVOCATION_BARRIER_MS;
      const CUTOFF = { seq: 7, startedAt: setup.fake.clock() };

      for (const changed of [
        { generation: 2 },
        { state: "expired" },
        { revokeDue: owedAt - 1 },
        { revokeDue: null },
      ] as const) {
        expect(beginRevocation(setup.sql, { ...read, ...changed }, until, CUTOFF)).toBe("stale");
      }
      expect(
        beginRevocation(setup.sql, { ...read, claimId: "clm_unknown00000000001" }, until, CUTOFF),
      ).toBe("stale");
      expect(attempts()).toBe(before);
      expect(barriers(setup.sql)).toEqual([]);
      expect(beginRevocation(setup.sql, read, until, CUTOFF)).toBe(before + 1);
      expect(barriers(setup.sql)).toEqual([
        { claim_id: claim.claimId, attempt: before + 1, expires_at: until },
      ]);
      // The barrier keeps the attempt's cutoff, which bounds what its sweep may revoke.
      expect(
        setup.sql.exec("SELECT mint_cutoff, started_at FROM claims_revocation_barriers").toArray(),
      ).toEqual([{ mint_cutoff: 7, started_at: CUTOFF.startedAt }]);
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

describe("the Git gateway at the lease deadline", () => {
  const SESSION = "session-token-of-agent-one";
  const encoder = new TextEncoder();
  /** A pkt-line, written by hand so the test does not reuse the subject's encoder. */
  const pkt = (payload: string): string =>
    (encoder.encode(payload).length + 4).toString(16).padStart(4, "0") + payload;

  /**
   * Pushes a new branch to agent 1's fork through a gateway over the real claims module, with the
   * clock moved `elapsed` milliseconds while the upstream holds the push, then answers that it
   * applied. Returns the `claim.pushed` events recorded.
   */
  async function pushHeldFor(
    setup: Setup,
    claimId: string,
    elapsed: number,
  ): Promise<RailheadEvent[]> {
    const gateway = createGitGateway({
      log: setup.log,
      storage: setup.storage,
      clock: setup.fake.clock,
      wake: async () => true,
      ports: () => ({
        sessions: {
          ...unavailableSessions,
          authenticate: async (token) =>
            token === SESSION ? ok(agent(1)) : fail("unauthenticated", "The session is not valid."),
        },
        claims: setup.port,
        artifacts: setup.artifacts,
      }),
      remote: async (repo) => ok(`https://fake.artifacts.invalid/${repo}.git`),
      async upstream(request) {
        // The fork read before release fails; the push's own report still settles it.
        if (request.method === "GET") return new Response(null, { status: 500 });
        await request.arrayBuffer();
        setup.fake.advance(elapsed);
        const report = `${pkt("unpack ok\n")}${pkt("ok refs/heads/feature\n")}0000`;
        return new Response(`${pkt(`\u0001${report}`)}0000`, {
          headers: { "content-type": "application/x-git-receive-pack-result" },
        });
      },
    });
    const body = encoder.encode(
      `${pkt(`${ZERO} ${WORK} refs/heads/feature\0report-status side-band-64k\n`)}0000PACK`,
    );
    const response = await gateway.serve(
      new Request("https://railhead.test/git/acme/demo.git/git-receive-pack", {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${agent(1).agentId}:${SESSION}`)}`,
          "content-type": "application/x-git-receive-pack-request",
        },
        body,
      }),
      { kind: "fork", claimId },
      "/git-receive-pack",
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    return setup.events().filter((event) => event.type === "claim.pushed");
  }

  it("records an in-flight push whose report arrives a millisecond before the deadline", async () => {
    await withTakeover(async (setup) => {
      const { claim } = await setup.open();
      // The push's authorization renews the lease, so the deadline is one lease from now.
      expect(await pushHeldFor(setup, claim.claimId, CLAIM_LEASE_MS - 1)).toMatchObject([
        {
          type: "claim.pushed",
          data: { claimId: claim.claimId, generation: 1, ref: "refs/heads/feature", to: WORK },
        },
      ]);
    });
  });

  it("records nothing for an in-flight push whose fence is checked at the deadline, before the expiry is recorded", async () => {
    await withTakeover(async (setup) => {
      const { claim } = await setup.open();
      expect(await pushHeldFor(setup, claim.claimId, CLAIM_LEASE_MS)).toEqual([]);
      // Nothing recorded the expiry: only the lapsed lease fenced the push.
      expect(stored(setup.sql, claim.claimId)).toMatchObject({ state: "working", generation: 1 });
      expect(types(setup.events())).not.toContain("claim.expired");
    });
  });
});
