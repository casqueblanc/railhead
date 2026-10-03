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
import type { AgentPrincipal, GrantFor } from "../src/contracts/principals";
import { ok, type PortResult } from "../src/contracts/result";
import { createClaims } from "../src/modules/claims/module";
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
  /** What the decisions port's fence reader answers. */
  versions: DecisionRef[] | null;
  /** Whether the Artifacts module is installed. */
  artifacts: boolean;
}

interface Setup {
  port: ClaimsPort;
  inbox: InboxPort;
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
  world: World = { fake: new FakeArtifacts(), versions: [], artifacts: true },
): Promise<T> {
  const stub: DurableObjectStub<Repo> = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    const { fake } = world;
    const main = await mainRepoName(REPO);
    fake.seed(main, [ROOT, HEAD]);
    const log = EventLog.open(state.storage, REPO, fake.clock);
    const context = { repoId: REPO, storage: state.storage, log, clock: fake.clock, env };
    const base = composeRepo(context);
    const artifacts = world.artifacts
      ? createArtifactsAdapter(
          { ...context, namespace: fake },
          { ...ARTIFACTS_LIMITS, callTimeoutMs: 50 },
        )
      : base.artifacts;
    const ports: RepoPorts = {
      ...base,
      artifacts,
      mainWriter: { ...base.mainWriter, head: async () => ok(HEAD) },
      decisions: { ...base.decisions, currentVersions: () => world.versions },
    };
    const port = createClaims(context, () => ports);
    const setup: Setup = {
      port,
      inbox: base.inbox,
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
    const versions = [{ decisionId: "dec_decision1", version: 2 }];
    await withReady(
      async (setup, { fake }) => {
        const { claim, fork } = await setup.open();
        setup.push(fork, WORK);
        const write = fake.mintFor(fork, "write", 600);

        const result = await setup.port.ready(agent(1), claim.claimId, request(WORK));

        expect(result).toEqual({
          ok: true,
          value: { claim: { ...claim, state: "ready", readyCommit: WORK }, repeated: false },
        });
        expect(setup.events().at(-1)).toMatchObject({
          actor: { kind: "agent", id: "agt_agent0001" },
          type: "claim.ready",
          data: { claimId: claim.claimId, generation: 1, commit: WORK, decisions: versions },
        });
        expect(fake.accepts(write.plaintext)).toBe(false);
        expect(fake.liveTokens(fork)).toEqual([]);
        expect(await setup.port.pin(claim.claimId)).toEqual({
          ok: true,
          value: { claimId: claim.claimId, generation: 1, commit: WORK },
        });
      },
      { fake: new FakeArtifacts(), versions, artifacts: true },
    );
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

describe("pin", () => {
  it("refuses a working claim, an unknown one and a malformed id", async () => {
    await withReady(async (setup) => {
      const { claim } = await setup.open();
      expectFailure(await setup.port.pin(claim.claimId), "claim_closed");
      expectFailure(await setup.port.pin("clm_unknownclm1"), "claim_closed");
      expectFailure(await setup.port.pin("iss_issue0001"), "invalid_request");
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
        value: { repo: fork, scope: "write", fence: { claimId: claim.claimId, generation: 1 } },
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
