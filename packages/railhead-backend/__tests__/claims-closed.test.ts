import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClaimView } from "@railhead/shared/agent-api";
import type { RailheadEvent } from "@railhead/shared/events";
import {
  ARTIFACTS_LIMITS,
  createArtifactsAdapter,
  forkRepoName,
  mainRepoName,
} from "../src/artifacts/adapter";
import { FakeArtifacts } from "../src/artifacts/fake";
import type { ClaimsPort } from "../src/contracts/claims";
import type { DecisionsPort, SystemQuestion } from "../src/contracts/decisions";
import type { AgentPrincipal, GrantFor } from "../src/contracts/principals";
import { ok } from "../src/contracts/result";
import { CLAIM_LEASE_MS, createClaims } from "../src/modules/claims/module";
import { createDecisions } from "../src/modules/decisions/decisions";
import { composeRepo, type RepoPorts } from "../src/repo/composeRepo";
import type { Repo } from "../src/repo/RepoObject";
import { EventLog } from "../src/repo/eventLog";
import { migrateClaims } from "../src/modules/claims/store";

const REPO = "rep_closed00001";
const ROOT = "1".repeat(40);
const HEAD = "2".repeat(40);

function agent(n: number, repoId = REPO): AgentPrincipal {
  return { kind: "agent", agentId: `agt_agent000${n}`, ownerId: "usr_owner0001", repoId };
}

interface Setup {
  fake: FakeArtifacts;
  claims: ClaimsPort;
  decisions: DecisionsPort;
  sql: SqlStorage;
  storage: DurableObjectStorage;
  log: EventLog;
  events: () => RailheadEvent[];
  /** Files an issue titled `title` and returns its id. */
  file: (title: string) => Promise<string>;
  /** Files an issue and has `principal` take the next one, returning the opened claim. */
  open: (principal: AgentPrincipal) => Promise<ClaimView>;
  /** Adds `commit` to the claim's fork, as a push would. */
  push: (claimId: string, commit: string) => Promise<void>;
}

/** Runs `body` in a fresh Repo with real claims, inbox and decisions, and fake Artifacts. */
function withClaims<T>(body: (setup: Setup) => Promise<T>): Promise<T> {
  const stub: DurableObjectStub<Repo> = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    const fake = new FakeArtifacts();
    fake.seed(await mainRepoName(REPO), [ROOT, HEAD]);
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
    const claims = createClaims(context, () => ports);
    const ports: RepoPorts = {
      ...base,
      claims,
      artifacts: createArtifactsAdapter(
        { ...context, namespace: fake },
        { ...ARTIFACTS_LIMITS, callTimeoutMs: 50 },
      ),
      decisions: createDecisions(context, () => ports),
      mainWriter: { ...base.mainWriter, head: async () => ok(HEAD) },
    };
    let filed = 0;
    const setup: Setup = {
      fake,
      claims,
      decisions: ports.decisions,
      sql: state.storage.sql,
      storage: state.storage,
      log,
      events: () => log.replay(0, 256).events,
      async file(title) {
        filed += 1;
        const grant: GrantFor<"issue.file"> = {
          kind: "human",
          userId: "usr_owner0001",
          repoId: REPO,
          grantId: `grant-${filed}`,
          action: { kind: "issue.file", title, body: `${title}, as the issue says.` },
        };
        const result = await claims.fileIssue(grant);
        if (!result.ok) throw new Error(`filing refused: ${result.code}`);
        return result.value.issueId;
      },
      async open(principal) {
        await setup.file(`Issue ${filed + 1}`);
        const claimed = await claims.work(principal);
        if (!claimed.ok) throw new Error(`work refused: ${claimed.code}`);
        return claimed.value.claim;
      },
      async push(claimId, commit) {
        const repo = fake.repos.get(await forkRepoName(REPO, claimId));
        if (repo === undefined) throw new Error("no such fork");
        repo.commits.push(commit);
      },
    };
    return body(setup);
  });
}

function closedRows(sql: SqlStorage): number {
  return sql.exec("SELECT 1 FROM claims_closed").toArray().length;
}

describe("an agent's closed claim", () => {
  it("is null for an agent none of whose claims has closed", async () => {
    await withClaims(async (setup) => {
      expect(await setup.claims.lastClosed(agent(1))).toEqual(ok(null));
      await setup.open(agent(1));
      expect(await setup.claims.lastClosed(agent(1))).toEqual(ok(null));
      expect(closedRows(setup.sql)).toBe(0);
    });
  });

  it("reads as expired once the lease lapses, in the transaction that records the expiry", async () => {
    await withClaims(async (setup) => {
      const claim = await setup.open(agent(1));
      setup.fake.advance(CLAIM_LEASE_MS);
      const expiredAt = setup.fake.clock();

      // The holder's own status read finds the lapse, records it and then sees no active claim.
      expect(await setup.claims.activeClaim(agent(1))).toEqual(ok(null));
      expect(setup.events().at(-1)).toMatchObject({
        type: "claim.expired",
        data: { claimId: claim.claimId, generation: 1 },
      });
      expect(await setup.claims.lastClosed(agent(1))).toEqual(
        ok({
          claimId: claim.claimId,
          issueId: claim.issueId,
          generation: 1,
          reason: { kind: "expired" },
          closedAt: expiredAt,
        }),
      );
    });
  });

  it("reads as taken over for the former holder, and the successor has none", async () => {
    await withClaims(async (setup) => {
      const claim = await setup.open(agent(1));
      setup.fake.advance(CLAIM_LEASE_MS);

      const taken = await setup.claims.work(agent(2));
      expect(taken).toMatchObject({
        ok: true,
        value: { claim: { claimId: claim.claimId, generation: 2 } },
      });
      expect(setup.events().map((event) => event.type)).toContain("claim.reassigned");

      expect(await setup.claims.lastClosed(agent(1))).toMatchObject({
        ok: true,
        value: { claimId: claim.claimId, generation: 1, reason: { kind: "taken_over" } },
      });
      expect(await setup.claims.lastClosed(agent(2))).toEqual(ok(null));
      expect(closedRows(setup.sql)).toBe(1);
    });
  });

  it("keeps the latest closing per agent, and keeps it while the agent holds a new claim", async () => {
    await withClaims(async (setup) => {
      const first = await setup.open(agent(1));
      setup.fake.advance(CLAIM_LEASE_MS);
      expect(await setup.claims.activeClaim(agent(1))).toEqual(ok(null));

      // The former holder is never offered its own expired claim, so it gets a new issue.
      const second = await setup.open(agent(1));
      expect(second.claimId).not.toBe(first.claimId);
      expect(await setup.claims.lastClosed(agent(1))).toMatchObject({
        ok: true,
        value: { claimId: first.claimId, reason: { kind: "expired" } },
      });

      // Its second claim also lapses: the row is replaced, never added to.
      setup.fake.advance(CLAIM_LEASE_MS);
      expect(await setup.claims.activeClaim(agent(1))).toEqual(ok(null));
      expect(await setup.claims.lastClosed(agent(1))).toMatchObject({
        ok: true,
        value: { claimId: second.claimId, reason: { kind: "expired" } },
      });
      expect(closedRows(setup.sql)).toBe(1);
    });
  });

  it("keeps a newer merge when an older expired claim of the agent is taken over", async () => {
    await withClaims(async (setup) => {
      const first = await setup.open(agent(1));
      setup.fake.advance(CLAIM_LEASE_MS);
      expect(await setup.claims.activeClaim(agent(1))).toEqual(ok(null));

      // The agent's second claim lands while its first still waits for a successor.
      const second = await setup.open(agent(1));
      const commit = "3".repeat(40);
      await setup.push(second.claimId, commit);
      expect(
        await setup.claims.ready(agent(1), second.claimId, { generation: 1, commit }),
      ).toMatchObject({ ok: true });
      const landedAt = setup.fake.clock();
      setup.log.transaction((tx) => {
        const ready = setup.claims.readyPin(second.claimId);
        if (ready === null) throw new Error("the second claim has no pin");
        setup.claims.merged(tx, [{ ...ready.pin, episode: ready.episode }], HEAD);
      });
      const merged = {
        claimId: second.claimId,
        issueId: second.issueId,
        generation: 1,
        reason: { kind: "merged", commit: HEAD },
        closedAt: landedAt,
      };
      expect(await setup.claims.lastClosed(agent(1))).toEqual(ok(merged));

      // Only now does another agent take the first claim over.
      setup.fake.advance(1);
      expect(await setup.claims.work(agent(2))).toMatchObject({
        ok: true,
        value: { claim: { claimId: first.claimId, generation: 2 } },
      });
      expect(setup.events().at(-1)).toMatchObject({
        type: "claim.reassigned",
        data: { claimId: first.claimId, from: agent(1).agentId },
      });
      expect(await setup.claims.lastClosed(agent(1))).toEqual(ok(merged));
      expect(closedRows(setup.sql)).toBe(1);
    });
  });

  it("refuses an agent of another repository and reads nothing", async () => {
    await withClaims(async (setup) => {
      await setup.open(agent(1));
      setup.fake.advance(CLAIM_LEASE_MS);
      expect(await setup.claims.activeClaim(agent(1))).toEqual(ok(null));

      expect(await setup.claims.lastClosed(agent(1, "rep_elsewhere01"))).toMatchObject({
        ok: false,
        code: "unauthenticated",
      });
      // Another agent of this repository never sees agent 1's closing.
      expect(await setup.claims.lastClosed(agent(3))).toEqual(ok(null));
    });
  });
});

describe("a merged claim", () => {
  it("is refused by a system question, which records nothing, though it keeps its generation", async () => {
    await withClaims(async (setup) => {
      const claim = await setup.open(agent(1));
      const commit = "3".repeat(40);
      await setup.push(claim.claimId, commit);
      expect(
        await setup.claims.ready(agent(1), claim.claimId, { generation: 1, commit }),
      ).toMatchObject({ ok: true });
      const question: SystemQuestion = {
        asker: "sys_train",
        key: "conflict_1",
        claims: [{ claimId: claim.claimId, generation: 1 }],
        text: "Which change should main keep?",
        options: [
          { key: "keep_first", label: "Keep the first change" },
          { key: "keep_second", label: "Keep the second change" },
        ],
        scope: ["src/upload.ts"],
      };
      // While ready, the claim is held, so the same question would be accepted.
      expect(setup.claims.holder(claim.claimId)).toEqual({
        agentId: agent(1).agentId,
        claimId: claim.claimId,
        generation: 1,
      });

      setup.log.transaction((tx) => {
        const ready = setup.claims.readyPin(claim.claimId);
        if (ready === null) throw new Error("the claim has no pin");
        setup.claims.merged(tx, [{ ...ready.pin, episode: ready.episode }], HEAD);
      });
      expect(setup.claims.currentGeneration(claim.claimId)).toBe(1);
      expect(setup.claims.holder(claim.claimId)).toBeNull();

      const before = setup.events().length;
      const asked = setup.log.transaction((tx) => setup.decisions.askSystem(tx, question)).value;
      expect(asked).toMatchObject({ ok: false, code: "claim_closed" });
      expect(setup.events()).toHaveLength(before);
      expect(setup.sql.exec("SELECT 1 FROM questions").toArray()).toHaveLength(0);
    });
  });
});

describe("releasing a claim", () => {
  it("closes a working claim as released, and a repeat returns the same release", async () => {
    await withClaims(async (setup) => {
      const claim = await setup.open(agent(1));
      const releasedAt = setup.fake.clock();
      const closed = {
        claimId: claim.claimId,
        issueId: claim.issueId,
        generation: 1,
        reason: { kind: "released" },
        closedAt: releasedAt,
      };

      expect(await setup.claims.release(agent(1), claim.claimId, { generation: 1 })).toEqual(
        ok({ closed, repeated: false }),
      );
      expect(setup.events().at(-1)).toMatchObject({
        v: 2,
        actor: { kind: "agent", id: agent(1).agentId },
        type: "claim.released",
        data: { claimId: claim.claimId, generation: 1 },
      });
      expect(await setup.claims.lastClosed(agent(1))).toEqual(ok(closed));
      expect(await setup.claims.activeClaim(agent(1))).toEqual(ok(null));
      // The fork takes no more pushes from its former holder.
      expect(
        await setup.claims.authorizeGit({
          principal: agent(1),
          target: { kind: "fork", claimId: claim.claimId },
          operation: "push",
        }),
      ).toMatchObject({ ok: false, code: "claim_closed" });

      const count = setup.events().length;
      setup.fake.advance(1);
      expect(await setup.claims.release(agent(1), claim.claimId, { generation: 1 })).toEqual(
        ok({ closed, repeated: true }),
      );
      expect(setup.events()).toHaveLength(count);
    });
  });

  it("offers the released claim to a successor, which takes it over at the next generation", async () => {
    await withClaims(async (setup) => {
      const claim = await setup.open(agent(1));
      expect(await setup.claims.release(agent(1), claim.claimId, { generation: 1 })).toMatchObject({
        ok: true,
      });

      // No lease has lapsed: the successor's call revokes the fork's tokens, then takes it over.
      expect(await setup.claims.work(agent(2))).toMatchObject({
        ok: true,
        value: { claim: { claimId: claim.claimId, generation: 2, state: "working" } },
      });
      expect(setup.events().at(-1)).toMatchObject({
        type: "claim.reassigned",
        data: { claimId: claim.claimId, from: agent(1).agentId, to: agent(2).agentId },
      });
      expect(await setup.claims.lastClosed(agent(1))).toMatchObject({
        ok: true,
        value: { claimId: claim.claimId, generation: 1, reason: { kind: "taken_over" } },
      });
      // The former holder's repeat no longer holds the claim.
      expect(await setup.claims.release(agent(1), claim.claimId, { generation: 1 })).toMatchObject({
        ok: false,
        code: "stale_generation",
      });
    });
  });

  it("refuses a stale generation and another agent's release, and changes nothing", async () => {
    await withClaims(async (setup) => {
      const claim = await setup.open(agent(1));
      const count = setup.events().length;

      expect(await setup.claims.release(agent(1), claim.claimId, { generation: 2 })).toMatchObject({
        ok: false,
        code: "stale_generation",
      });
      expect(await setup.claims.release(agent(2), claim.claimId, { generation: 1 })).toMatchObject({
        ok: false,
        code: "stale_generation",
      });
      expect(setup.events()).toHaveLength(count);
      expect(await setup.claims.activeClaim(agent(1))).toMatchObject({
        ok: true,
        value: { claimId: claim.claimId, state: "working" },
      });
      expect(await setup.claims.lastClosed(agent(1))).toEqual(ok(null));
    });
  });

  it("refuses a ready claim, whose pin stays on the train", async () => {
    await withClaims(async (setup) => {
      const claim = await setup.open(agent(1));
      const commit = "3".repeat(40);
      await setup.push(claim.claimId, commit);
      expect(
        await setup.claims.ready(agent(1), claim.claimId, { generation: 1, commit }),
      ).toMatchObject({ ok: true });
      const count = setup.events().length;

      expect(await setup.claims.release(agent(1), claim.claimId, { generation: 1 })).toMatchObject({
        ok: false,
        code: "after_ready",
      });
      expect(setup.events()).toHaveLength(count);
      expect(setup.claims.readyPin(claim.claimId)?.pin).toEqual({
        claimId: claim.claimId,
        generation: 1,
        commit,
      });
    });
  });

  it("refuses a claim whose lease lapsed, recording the expiry rather than a release", async () => {
    await withClaims(async (setup) => {
      const claim = await setup.open(agent(1));
      setup.fake.advance(CLAIM_LEASE_MS);

      expect(await setup.claims.release(agent(1), claim.claimId, { generation: 1 })).toMatchObject({
        ok: false,
        code: "claim_closed",
      });
      expect(setup.events().at(-1)).toMatchObject({
        type: "claim.expired",
        data: { claimId: claim.claimId, generation: 1 },
      });
      expect(await setup.claims.lastClosed(agent(1))).toMatchObject({
        ok: true,
        value: { reason: { kind: "expired" } },
      });
    });
  });

  it("refuses a malformed request, an unknown claim and another repository's agent", async () => {
    await withClaims(async (setup) => {
      const claim = await setup.open(agent(1));
      const count = setup.events().length;

      expect(await setup.claims.release(agent(1), claim.claimId, { generation: 0 })).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(await setup.claims.release(agent(1), "not-a-claim", { generation: 1 })).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(
        await setup.claims.release(agent(1), "clm_unknown01", { generation: 1 }),
      ).toMatchObject({ ok: false, code: "claim_closed" });
      expect(
        await setup.claims.release(agent(1, "rep_elsewhere01"), claim.claimId, { generation: 1 }),
      ).toMatchObject({ ok: false, code: "unauthenticated" });
      expect(setup.events()).toHaveLength(count);
    });
  });

  it("keeps closed claims recorded before `released` was a reason", async () => {
    await withClaims(async (setup) => {
      const first = await setup.open(agent(1));
      setup.fake.advance(CLAIM_LEASE_MS);
      expect(await setup.claims.activeClaim(agent(1))).toEqual(ok(null));

      // Put back the table as the previous migration left it, with its row.
      const { sql } = setup;
      sql.exec(`CREATE TABLE claims_closed_old (
        agent_id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL REFERENCES claims_claims (claim_id),
        issue_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        reason TEXT NOT NULL CHECK (reason IN ('merged', 'expired', 'taken_over')),
        commit_sha TEXT,
        closed_at INTEGER NOT NULL,
        CHECK ((reason = 'merged') = (commit_sha IS NOT NULL))
      ) STRICT`);
      sql.exec("INSERT INTO claims_closed_old SELECT * FROM claims_closed");
      sql.exec("DROP TABLE claims_closed");
      sql.exec("ALTER TABLE claims_closed_old RENAME TO claims_closed");
      sql.exec("UPDATE railhead_migrations SET version = version - 4 WHERE owner = 'claims'");
      expect(() =>
        sql.exec(
          "UPDATE claims_closed SET reason = 'released' WHERE agent_id = ?",
          agent(1).agentId,
        ),
      ).toThrow();

      migrateClaims(setup.storage);
      expect(await setup.claims.lastClosed(agent(1))).toMatchObject({
        ok: true,
        value: { claimId: first.claimId, reason: { kind: "expired" } },
      });

      const second = await setup.open(agent(1));
      expect(await setup.claims.release(agent(1), second.claimId, { generation: 1 })).toMatchObject(
        { ok: true, value: { closed: { claimId: second.claimId, reason: { kind: "released" } } } },
      );
    });
  });
});
