import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClaimResult } from "@railhead/shared/agent-api";
import type { RailheadEvent } from "@railhead/shared/events";
import {
  ARTIFACTS_LIMITS,
  createArtifactsAdapter,
  forkRepoName,
  mainRepoName,
  type ArtifactsAdapterLimits,
} from "../src/artifacts/adapter";
import { FakeArtifacts } from "../src/artifacts/fake";
import type { ClaimsPort } from "../src/contracts/claims";
import type { AgentPrincipal, GrantFor } from "../src/contracts/principals";
import { fail, ok, type PortResult } from "../src/contracts/result";
import { claims as claimsEntry } from "../src/modules/claims/entry";
import { CLAIMS_LIMITS, createClaims, type ClaimsLimits } from "../src/modules/claims/module";
import { composeRepo } from "../src/repo/composeRepo";
import type { Repo } from "../src/repo/RepoObject";
import { EventLog } from "../src/repo/eventLog";
import { freshStub } from "./sliceWorld";

const REPO = "rep_claimsrepo1";
const ROOT = "1".repeat(40);
const HEAD = "2".repeat(40);
const MOVED = "3".repeat(40);
const FAST: ArtifactsAdapterLimits = { ...ARTIFACTS_LIMITS, callTimeoutMs: 50 };

function agent(n: number, ownerId = "usr_owner0001"): AgentPrincipal {
  return { kind: "agent", agentId: `agt_agent000${n}`, ownerId, repoId: REPO };
}

function grant(
  title: string,
  body = "Do it.",
  grantId = crypto.randomUUID(),
): GrantFor<"issue.file"> {
  return {
    kind: "human",
    userId: "usr_owner0001",
    repoId: REPO,
    grantId,
    action: { kind: "issue.file", title, body },
  };
}

interface World {
  fake: FakeArtifacts;
  /** What main's reader answers; `null` reads the fake's main. */
  mainHead: PortResult<string> | null;
  mainReads: number;
}

interface Setup {
  port: ClaimsPort;
  events: () => RailheadEvent[];
  sql: SqlStorage;
}

function newWorld(): World {
  return { fake: new FakeArtifacts(), mainHead: null, mainReads: 0 };
}

/** Runs `body` in `stub` with a claims port over its storage, wired to `world`'s fake Artifacts. */
function inRepo<T>(
  stub: DurableObjectStub<Repo>,
  world: World,
  body: (setup: Setup) => Promise<T>,
  limits: ClaimsLimits = CLAIMS_LIMITS,
): Promise<T> {
  return runInDurableObject(stub, async (_instance, state) => {
    const { fake } = world;
    const main = await mainRepoName(REPO);
    if (!fake.repos.has(main)) fake.seed(main, [ROOT, HEAD]);
    const log = EventLog.open(state.storage, REPO, fake.clock);
    const context = {
      repoId: REPO,
      storage: state.storage,
      log,
      clock: fake.clock,
      env,
      wake: async () => true,
    };
    const artifacts = createArtifactsAdapter({ ...context, namespace: fake }, FAST);
    const base = composeRepo(context);
    // Main is read through the main writer's `head`, answered here from the fake's main.
    const mainWriter = {
      ...base.mainWriter,
      head: async (): Promise<PortResult<string>> => {
        world.mainReads += 1;
        if (world.mainHead !== null) return world.mainHead;
        const tip = fake.repos.get(main)?.commits.at(-1);
        return tip === undefined ? fail("internal", "Main is empty.") : ok(tip);
      },
    };
    const port = createClaims(context, () => ({ ...base, artifacts, mainWriter }), limits);
    const result = await body({
      port,
      sql: state.storage.sql,
      events: () => log.replay(0, 256).events,
    });
    expect(fake.openHandles).toBe(0);
    return result;
  });
}

function withClaims<T>(body: (setup: Setup, world: World) => Promise<T>, limits?: ClaimsLimits) {
  const world = newWorld();
  return inRepo(freshStub(), world, (setup) => body(setup, world), limits);
}

async function fileIssues(port: ClaimsPort, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    const filed = await port.fileIssue(grant(`Issue ${n}`, `Body ${n}`));
    if (!filed.ok) throw new Error(`filing refused: ${filed.code}`);
    ids.push(filed.value.issueId);
  }
  return ids;
}

function claimed(result: PortResult<ClaimResult>): ClaimResult {
  if (!result.ok) throw new Error(`claim refused: ${result.code}`);
  return result.value;
}

function opened(events: RailheadEvent[]): RailheadEvent[] {
  return events.filter((event) => event.type === "claim.opened");
}

function claimRows(sql: SqlStorage): { issue_id: string; agent_id: string; state: string }[] {
  return sql
    .exec<{ issue_id: string; agent_id: string; state: string }>(
      "SELECT issue_id, agent_id, state FROM claims_claims ORDER BY issue_id",
    )
    .toArray();
}

describe("fileIssue", () => {
  it("records a thin issue with its event, and a repeated approval files nothing new", async () => {
    await withClaims(async ({ port, events }) => {
      const approval = grant("Add uploads", "Accept PNG files.");
      const first = await port.fileIssue(approval);
      const again = await port.fileIssue(approval);

      expect(first.ok).toBe(true);
      expect(again).toEqual(first);
      const log = events();
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        actor: { kind: "human", id: "usr_owner0001" },
        type: "issue.filed",
        data: { title: "Add uploads", body: "Accept PNG files." },
      });
    });
  });

  it("refuses an empty title or an oversized body, and writes nothing", async () => {
    await withClaims(async ({ port, events, sql }) => {
      expect(await port.fileIssue(grant(""))).toMatchObject({ ok: false, code: "invalid_request" });
      expect(await port.fileIssue(grant("Big", "x".repeat(16 * 1024 + 1)))).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(events()).toEqual([]);
      expect(sql.exec("SELECT * FROM claims_issues").toArray()).toEqual([]);
    });
  });

  it("refuses an approval for another repository", async () => {
    await withClaims(async ({ port, events }) => {
      const foreign = { ...grant("Elsewhere"), repoId: "rep_otherrepo1" };
      expect(await port.fileIssue(foreign)).toMatchObject({ ok: false, code: "unauthenticated" });
      expect(events()).toEqual([]);
    });
  });
});

describe("work", () => {
  it("claims the oldest issue on a fork of main and returns the same claim on repeat", async () => {
    await withClaims(async ({ port, events }, { fake }) => {
      const [first] = await fileIssues(port, 2);
      const result = claimed(await port.work(agent(1)));

      expect(result).toEqual({
        resumed: false,
        claim: {
          claimId: expect.stringMatching(/^clm_[0-9a-f]{32}$/),
          issueId: first,
          generation: 1,
          base: HEAD,
          state: "working",
          readyCommit: null,
          originUrl: "",
          upstreamUrl: "",
          task: { title: "Issue 1", body: "Body 1" },
        },
      });
      const fork = await forkRepoName(REPO, result.claim.claimId);
      expect(fake.repos.get(fork)?.commits).toEqual([ROOT, HEAD]);
      expect(fake.liveTokens(fork)).toEqual([]);
      expect(opened(events())).toMatchObject([
        {
          actor: { kind: "agent", id: "agt_agent0001" },
          data: {
            claimId: result.claim.claimId,
            agentId: "agt_agent0001",
            generation: 1,
            base: HEAD,
          },
        },
      ]);

      expect(await port.work(agent(1))).toEqual(ok({ claim: result.claim, resumed: true }));
      expect(await port.activeClaim(agent(1))).toEqual(ok(result.claim));
      expect(fake.forkCalls).toBe(1);
      expect(opened(events())).toHaveLength(1);
    });
  });

  it("answers no_work with nothing filed and once every issue is claimed", async () => {
    await withClaims(async ({ port, sql }, world) => {
      expect(await port.work(agent(1))).toMatchObject({ ok: false, code: "no_work" });
      expect(await port.activeClaim(agent(1))).toEqual(ok(null));

      await fileIssues(port, 1);
      claimed(await port.work(agent(1)));
      expect(await port.work(agent(2))).toMatchObject({ ok: false, code: "no_work" });
      expect(claimRows(sql)).toHaveLength(1);
      expect(world.fake.forkCalls).toBe(1);
    });
  });

  it("never gives one issue to two agents working at once", async () => {
    await withClaims(async ({ port, events, sql }, { fake }) => {
      const issues = await fileIssues(port, 2);
      const results = await Promise.all([1, 2, 3].map((n) => port.work(agent(n))));

      const won = results.filter((result) => result.ok).map((result) => claimed(result));
      expect(won.map((result) => result.claim.issueId).toSorted()).toEqual(issues.toSorted());
      expect(results.filter((result) => !result.ok)).toMatchObject([{ code: "no_work" }]);
      expect(claimRows(sql).map((row) => row.issue_id)).toEqual(issues.toSorted());
      expect(fake.forkCalls).toBe(2);
      expect(opened(events())).toHaveLength(2);
    });
  });

  it("gives one agent's concurrent requests the same claim and one fork", async () => {
    await withClaims(async ({ port, events }, { fake }) => {
      await fileIssues(port, 2);
      const [a, b] = await Promise.all([port.work(agent(1)), port.work(agent(1))]);

      expect(claimed(a).claim).toEqual(claimed(b).claim);
      expect([claimed(a).resumed, claimed(b).resumed].toSorted()).toEqual([false, true]);
      expect(fake.forkCalls).toBe(1);
      expect(opened(events())).toHaveLength(1);
    });
  });

  it("refuses a session for another repository without touching state", async () => {
    await withClaims(async ({ port, sql }, world) => {
      await fileIssues(port, 1);
      const foreign = { ...agent(1), repoId: "rep_otherrepo1" };

      expect(await port.work(foreign)).toMatchObject({ ok: false, code: "unauthenticated" });
      expect(await port.claim(foreign, "iss_whatever1")).toMatchObject({
        ok: false,
        code: "unauthenticated",
      });
      expect(await port.activeClaim(foreign)).toMatchObject({ ok: false, code: "unauthenticated" });
      expect(claimRows(sql)).toEqual([]);
      expect(world.mainReads).toBe(0);
    });
  });
});

describe("claim", () => {
  it("claims a named issue and resumes it on repeat", async () => {
    await withClaims(async ({ port }) => {
      const [, second] = await fileIssues(port, 2);
      const result = claimed(await port.claim(agent(1), second ?? ""));

      expect(result.resumed).toBe(false);
      expect(result.claim).toMatchObject({ issueId: second, state: "working", base: HEAD });
      expect(await port.claim(agent(1), second ?? "")).toEqual(
        ok({ claim: result.claim, resumed: true }),
      );
    });
  });

  it("refuses a second issue, a taken issue, an unknown one and a malformed id", async () => {
    await withClaims(async ({ port, sql }, { fake }) => {
      const [first, second] = await fileIssues(port, 2);
      claimed(await port.claim(agent(1), first ?? ""));

      expect(await port.claim(agent(1), second ?? "")).toMatchObject({
        ok: false,
        code: "claim_exists",
      });
      expect(await port.claim(agent(2), first ?? "")).toMatchObject({
        ok: false,
        code: "issue_unavailable",
      });
      expect(await port.claim(agent(2), "iss_nosuchissue")).toMatchObject({
        ok: false,
        code: "issue_unavailable",
      });
      expect(await port.claim(agent(2), "clm_notanissue")).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(claimRows(sql)).toHaveLength(1);
      expect(fake.forkCalls).toBe(1);
    });
  });

  it("gives a contested issue to exactly one of two agents claiming it at once", async () => {
    await withClaims(async ({ port, sql }) => {
      const [issue] = await fileIssues(port, 1);
      const results = await Promise.all([
        port.claim(agent(1), issue ?? ""),
        port.claim(agent(2), issue ?? ""),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toMatchObject([{ code: "issue_unavailable" }]);
      expect(claimRows(sql)).toHaveLength(1);
    });
  });
});

describe("currentGeneration", () => {
  it("reports an opened claim's generation and unknown for anything else", async () => {
    await withClaims(async ({ port, sql }, { fake }) => {
      await fileIssues(port, 2);
      const held = claimed(await port.work(agent(1)));
      fake.failNextFork("lose-response");
      expect((await port.work(agent(2))).ok).toBe(false);
      const [intent] = sql
        .exec<{ claim_id: string }>("SELECT claim_id FROM claims_claims WHERE state = 'allocating'")
        .toArray()
        .map((row) => row.claim_id);

      expect(intent).toMatch(/^clm_/);
      expect(port.currentGeneration(held.claim.claimId)).toBe(1);
      // An allocating claim has no fork yet, so it has no generation a pin could match.
      expect(port.currentGeneration(intent ?? "")).toBeNull();
      expect(port.currentGeneration("clm_nosuchclaim")).toBeNull();
      expect(port.currentGeneration("")).toBeNull();
    });
  });

  it("reads as unknown once a claim expires, and keeps a merged claim's for its decisions", async () => {
    await withClaims(async ({ port, sql }) => {
      await fileIssues(port, 1);
      const held = claimed(await port.work(agent(1)));
      const set = (state: string) =>
        sql.exec(
          "UPDATE claims_claims SET state = ? WHERE claim_id = ?",
          state,
          held.claim.claimId,
        );
      set("expired");
      expect(port.currentGeneration(held.claim.claimId)).toBeNull();
      set("merged");
      expect(port.currentGeneration(held.claim.claimId)).toBe(1);
      // A merged claim has no pin for the train and takes no push.
      expect(port.readyPin(held.claim.claimId)).toBeNull();
      expect(port.workingGeneration(held.claim.claimId)).toBeNull();
      set("ready");
      expect(port.currentGeneration(held.claim.claimId)).toBe(1);
    });
  });
});

describe("holder", () => {
  it("names the agent and generation of a working claim", async () => {
    await withClaims(async ({ port }) => {
      await fileIssues(port, 2);
      const first = claimed(await port.work(agent(1)));
      const second = claimed(await port.work(agent(2)));

      expect(port.holder(first.claim.claimId)).toEqual({
        agentId: agent(1).agentId,
        claimId: first.claim.claimId,
        generation: 1,
      });
      expect(port.holder(second.claim.claimId)).toEqual({
        agentId: agent(2).agentId,
        claimId: second.claim.claimId,
        generation: 1,
      });
    });
  });

  it("names the holder of a ready claim", async () => {
    await withClaims(async ({ port, sql }) => {
      await fileIssues(port, 1);
      const held = claimed(await port.work(agent(1)));
      sql.exec("UPDATE claims_claims SET state = 'ready' WHERE claim_id = ?", held.claim.claimId);

      expect(port.holder(held.claim.claimId)).toEqual({
        agentId: agent(1).agentId,
        claimId: held.claim.claimId,
        generation: 1,
      });
    });
  });

  it("is null for an unknown, allocating, merged or expired claim", async () => {
    await withClaims(async ({ port, sql }, { fake }) => {
      await fileIssues(port, 2);
      const held = claimed(await port.work(agent(1)));
      fake.failNextFork("lose-response");
      expect((await port.work(agent(2))).ok).toBe(false);
      const [intent] = sql
        .exec<{ claim_id: string }>("SELECT claim_id FROM claims_claims WHERE state = 'allocating'")
        .toArray()
        .map((row) => row.claim_id);

      expect(port.holder(intent ?? "")).toBeNull();
      expect(port.holder("clm_nosuchclaim")).toBeNull();
      expect(port.holder("")).toBeNull();
      for (const state of ["merged", "expired"]) {
        sql.exec(
          "UPDATE claims_claims SET state = ? WHERE claim_id = ?",
          state,
          held.claim.claimId,
        );
        expect(port.holder(held.claim.claimId)).toBeNull();
      }
    });
  });
});

describe("workingGeneration and workingEpisode", () => {
  it("report a working claim's generation and episode, and unknown for an allocating or missing one", async () => {
    await withClaims(async ({ port, sql }, { fake }) => {
      await fileIssues(port, 2);
      const held = claimed(await port.work(agent(1)));
      fake.failNextFork("lose-response");
      expect((await port.work(agent(2))).ok).toBe(false);
      const [intent] = sql
        .exec<{ claim_id: string }>("SELECT claim_id FROM claims_claims WHERE state = 'allocating'")
        .toArray()
        .map((row) => row.claim_id);

      expect(port.workingGeneration(held.claim.claimId)).toBe(1);
      expect(port.workingGeneration(intent ?? "")).toBeNull();
      expect(port.workingGeneration("clm_nosuchclaim")).toBeNull();
      expect(port.workingGeneration("")).toBeNull();
      expect(port.workingEpisode(held.claim.claimId)).toBe(1);
      expect(port.workingEpisode(intent ?? "")).toBeNull();
      expect(port.workingEpisode("clm_nosuchclaim")).toBeNull();
      expect(port.workingEpisode("")).toBeNull();
    });
  });

  it("read as unknown once a claim is ready, merged or expired, and follow a new generation", async () => {
    await withClaims(async ({ port, sql }) => {
      await fileIssues(port, 1);
      const held = claimed(await port.work(agent(1)));
      for (const state of ["ready", "merged", "expired"]) {
        sql.exec(
          "UPDATE claims_claims SET state = ? WHERE claim_id = ?",
          state,
          held.claim.claimId,
        );
        expect(port.workingGeneration(held.claim.claimId), state).toBeNull();
        expect(port.workingEpisode(held.claim.claimId), state).toBeNull();
      }
      sql.exec(
        "UPDATE claims_claims SET state = 'working', generation = 2 WHERE claim_id = ?",
        held.claim.claimId,
      );
      expect(port.workingGeneration(held.claim.claimId)).toBe(2);
      expect(port.workingEpisode(held.claim.claimId)).toBe(1);
    });
  });
});

describe("quota", () => {
  it("stops one person's agents at the limit and lets another person's agent claim", async () => {
    await withClaims(
      async ({ port, sql }) => {
        await fileIssues(port, 3);
        claimed(await port.work(agent(1, "usr_owner0001")));

        expect(await port.work(agent(2, "usr_owner0001"))).toMatchObject({
          ok: false,
          code: "quota_exceeded",
        });
        claimed(await port.work(agent(3, "usr_owner0002")));
        expect(
          claimRows(sql)
            .map((row) => row.agent_id)
            .toSorted(),
        ).toEqual(["agt_agent0001", "agt_agent0003"]);
      },
      { maxActiveClaimsPerOwner: 1 },
    );
  });
});

describe("allocation failures", () => {
  it("finishes the same claim after a lost fork response, without a second fork", async () => {
    await withClaims(async ({ port, events, sql }, { fake }) => {
      await fileIssues(port, 1);
      fake.failNextFork("lose-response");

      expect(await port.work(agent(1))).toMatchObject({ ok: false, code: "internal" });
      expect(claimRows(sql)).toMatchObject([{ agent_id: "agt_agent0001", state: "allocating" }]);
      expect(opened(events())).toEqual([]);
      // Another agent cannot take the reserved issue meanwhile.
      expect(await port.work(agent(2))).toMatchObject({ ok: false, code: "no_work" });

      const result = claimed(await port.work(agent(1)));
      expect(result).toMatchObject({ resumed: true, claim: { state: "working", base: HEAD } });
      expect(fake.forkCalls).toBe(1);
      expect(fake.liveTokens(await forkRepoName(REPO, result.claim.claimId))).toEqual([]);
      expect(opened(events())).toHaveLength(1);
    });
  });

  it("keeps the base the fork was made at after main moves", async () => {
    await withClaims(async ({ port }, { fake }) => {
      await fileIssues(port, 1);
      fake.failNextFork("lose-response");
      expect((await port.work(agent(1))).ok).toBe(false);
      fake.repos.get(await mainRepoName(REPO))?.commits.push(MOVED);

      const result = claimed(await port.work(agent(1)));
      expect(result.claim.base).toBe(HEAD);
      expect(claimed(await port.work(agent(1))).claim.base).toBe(HEAD);
    });
  });

  it("reports a fork call that never answers as busy and recovers on retry", async () => {
    await withClaims(async ({ port }, { fake }) => {
      await fileIssues(port, 1);
      fake.failNextFork("hang");

      expect(await port.work(agent(1))).toMatchObject({ ok: false, code: "busy" });
      expect(claimed(await port.work(agent(1))).claim.state).toBe("working");
    });
  });

  it("fails closed with no fork while main cannot be read", async () => {
    await withClaims(async ({ port, events }, world) => {
      await fileIssues(port, 1);
      world.mainHead = fail("unavailable", "The mainWriter module is not available.");

      expect(await port.work(agent(1))).toMatchObject({ ok: false, code: "unavailable" });
      expect(world.fake.forkCalls).toBe(0);
      expect(opened(events())).toEqual([]);

      world.mainHead = null;
      expect(claimed(await port.work(agent(1))).claim.base).toBe(HEAD);
    });
  });

  it("records no base from a malformed main head, so a later retry still opens the claim", async () => {
    await withClaims(async ({ port, sql }, world) => {
      await fileIssues(port, 1);
      world.mainHead = ok("not-a-commit");

      expect(await port.work(agent(1))).toMatchObject({ ok: false, code: "internal" });
      expect(world.fake.forkCalls).toBe(0);
      expect(sql.exec("SELECT fork_base FROM claims_claims").toArray()).toEqual([
        { fork_base: null },
      ]);

      world.mainHead = null;
      expect(claimed(await port.work(agent(1))).claim.base).toBe(HEAD);
    });
  });

  it("refuses allocation in the installed composition, whose main writer is missing", async () => {
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const log = EventLog.open(state.storage, REPO);
      const context = {
        repoId: REPO,
        storage: state.storage,
        log,
        clock: () => 1,
        env,
        wake: async () => true,
      };
      const base = composeRepo(context);
      const port = claimsEntry(context, () => base);
      expect((await port.fileIssue(grant("Ready"))).ok).toBe(true);

      expect(await port.work(agent(1))).toMatchObject({ ok: false, code: "unavailable" });
      expect(log.replay(0, 10).events.map((event) => event.type)).toEqual(["issue.filed"]);
    });
  });
});

describe("restart", () => {
  it("keeps the task and the claim, and finishes an interrupted allocation", async () => {
    const stub = freshStub();
    const world = newWorld();
    const interrupted = await inRepo(stub, world, async ({ port }) => {
      await fileIssues(port, 1);
      world.fake.failNextFork("lose-response");
      return port.work(agent(1));
    });
    expect(interrupted).toMatchObject({ ok: false, code: "internal" });
    await evictDurableObject(stub);

    const after = await inRepo(stub, world, async ({ port }) => claimed(await port.work(agent(1))));
    expect(after).toMatchObject({
      resumed: true,
      claim: { state: "working", base: HEAD, task: { title: "Issue 1", body: "Body 1" } },
    });
    await evictDurableObject(stub);

    const status = await inRepo(stub, world, async ({ port, events }) => ({
      claim: await port.activeClaim(agent(1)),
      opened: opened(events()).length,
    }));
    expect(status).toEqual({ claim: ok(after.claim), opened: 1 });
    expect(world.fake.forkCalls).toBe(1);
  });
});
