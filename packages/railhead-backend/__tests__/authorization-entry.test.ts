// The authorization module as the Repo installs it. Every module the train reaches is built by the
// factory `composeRepo` calls, over one Repo's storage and one `ports` function. Only the ports
// backed by remote services are fakes: Artifacts behind the real adapter, merging, check runs and
// main's ref.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClaimView } from "@railhead/shared/agent-api";
import type { CommitSha, DecisionRef, RailheadEvent } from "@railhead/shared/events";
import {
  ARTIFACTS_LIMITS,
  createArtifactsAdapter,
  forkRepoName,
  mainRepoName,
} from "../src/artifacts/adapter";
import { FakeArtifacts } from "../src/artifacts/fake";
import type { ClaimPin } from "../src/contracts/claims";
import type { AgentPrincipal } from "../src/contracts/principals";
import { fail, ok } from "../src/contracts/result";
import type { CheckAttempt, MainRefPort } from "../src/contracts/train";
import { authorization } from "../src/modules/authorization/entry";
import { CLAIM_LEASE_MS } from "../src/modules/claims/module";
import { claims } from "../src/modules/claims/entry";
import { decisions } from "../src/modules/decisions/entry";
import { inbox } from "../src/modules/inbox/entry";
import { mainWriter } from "../src/modules/mainWriter/entry";
import { train } from "../src/modules/train/entry";
import { composeRepo, type RepoPorts } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";

const REPO = "rep_authentry01";
const ROOT = "1".repeat(40);
const MAIN = "2".repeat(40);
const FIRST = "4".repeat(40);
const SECOND = "5".repeat(40);
const CANDIDATE = "7".repeat(40);
const OWNER = "usr_owner0001";

function agent(n: number): AgentPrincipal {
  return { kind: "agent", agentId: `agt_agent000${n}`, ownerId: OWNER, repoId: REPO };
}

interface Setup {
  ports: RepoPorts;
  sql: SqlStorage;
  log: EventLog;
  /** Every check attempt started, oldest first. */
  started: CheckAttempt[];
  /** The commit main is at. */
  main(): CommitSha;
  /** Moves the Repo's clock forward. */
  advance(ms: number): void;
  /** Files an issue and claims it for agent `n`, with `commit` pushed to its fork. */
  open(n: number, commit: CommitSha): Promise<ClaimView>;
  /** Records the next version of `decisionId` on the claim, asking the question first if none. */
  decide(claimId: string, decisionId?: string): Promise<DecisionRef>;
  /** Acknowledges every inbox item agent `n` has pending. */
  ackAll(n: number): Promise<void>;
}

function withRepo<T>(body: (setup: Setup) => Promise<T>): Promise<T> {
  const fake = new FakeArtifacts();
  return runInDurableObject(env.REPO.getByName(crypto.randomUUID()), async (_instance, state) => {
    fake.seed(await mainRepoName(REPO), [ROOT, MAIN]);
    const context = {
      repoId: REPO,
      storage: state.storage,
      log: EventLog.open(state.storage, REPO, fake.clock),
      clock: fake.clock,
      env,
      wake: async () => true,
    };
    let mainAt: CommitSha = MAIN;
    const mainRef: MainRefPort = {
      read: async () => ok(mainAt),
      update: async (expected, next) => {
        if (mainAt !== expected) return ok({ kind: "rejected", actual: mainAt });
        mainAt = next;
        return ok({ kind: "updated" });
      },
    };
    const started: CheckAttempt[] = [];
    const base = composeRepo(context);
    const installed = (): RepoPorts => ports;
    const ports: RepoPorts = {
      ...base,
      artifacts: createArtifactsAdapter(
        { ...context, namespace: fake },
        { ...ARTIFACTS_LIMITS, callTimeoutMs: 50 },
      ),
      claims: claims(context, installed),
      inbox: inbox(context, installed),
      decisions: decisions(context, installed),
      train: train(context, installed),
      authorization: authorization(context, installed),
      mainWriter: mainWriter(context, installed, mainRef),
      checks: {
        definitions: async (main) =>
          ok([{ name: "test", source: main, digest: "d".repeat(64), acceptance: null }]),
        start: async (attempt) => {
          started.push(attempt);
          return ok({ attemptId: attempt.attemptId });
        },
        report: async () => fail("unavailable", "Not used."),
        detail: async () => fail("unavailable", "Not used."),
        approve: async () => fail("unavailable", "Not used."),
      },
      merge: {
        compose: async () => ok({ kind: "clean", candidate: CANDIDATE }),
        discard: async () => ok({ removed: 1 }),
      },
    };
    let asked = 0;
    const setup: Setup = {
      ports,
      sql: state.storage.sql,
      log: context.log,
      started,
      main: () => mainAt,
      advance: (ms) => fake.advance(ms),
      async open(n, commit) {
        const filed = await ports.claims.fileIssue({
          kind: "human",
          userId: OWNER,
          repoId: REPO,
          grantId: crypto.randomUUID(),
          action: { kind: "issue.file", title: `Issue ${n}`, body: "Do it." },
        });
        if (!filed.ok) throw new Error(`filing refused: ${filed.code}`);
        const claimed = await ports.claims.work(agent(n));
        if (!claimed.ok) throw new Error(`claim refused: ${claimed.code}`);
        const fork = fake.repos.get(await forkRepoName(REPO, claimed.value.claim.claimId));
        if (fork === undefined) throw new Error("no such fork");
        fork.commits.push(commit);
        return claimed.value.claim;
      },
      async decide(claimId, existing) {
        let decisionId = existing;
        if (decisionId === undefined) {
          asked += 1;
          const question = await ports.decisions.ask(agent(1), claimId, {
            generation: 1,
            requestId: `req_upload000000000${asked}`,
            text: "Should uploads above 10 MB be rejected or chunked?",
            options: [
              { key: "reject", label: "Reject them" },
              { key: "chunk", label: "Upload them in chunks" },
            ],
            scope: ["src/upload.ts"],
          });
          if (!question.ok) throw new Error(`ask refused: ${question.code}`);
          decisionId = question.value.decisionId;
        }
        const current = ports.decisions
          .currentVersions(claimId)
          ?.find((ref) => ref.decisionId === decisionId);
        const recorded = await ports.decisions.record({
          kind: "human",
          userId: OWNER,
          repoId: REPO,
          grantId: crypto.randomUUID(),
          action: {
            kind: "decision.record",
            decisionId,
            option: current === undefined ? "chunk" : "reject",
            expectedVersion: current?.version ?? null,
          },
        });
        if (!recorded.ok) throw new Error(`record refused: ${recorded.code}`);
        return recorded.value;
      },
      async ackAll(n) {
        const delivered = await ports.inbox.pending(agent(n), 16);
        if (!delivered.ok) throw new Error(`pending refused: ${delivered.code}`);
        for (const { item } of delivered.value.items) {
          const acked = await ports.inbox.ack(agent(n), item, "Follow the decision.");
          if (!acked.ok) throw new Error(`ack refused: ${acked.code}`);
        }
      },
    };
    return body(setup);
  });
}

/**
 * Claims for agents 1 and 2, readied with `FIRST` and `SECOND`, and the train's drive that batches
 * them and starts one check. The first claim's work follows a recorded decision.
 */
async function readyPair(setup: Setup) {
  const first = await setup.open(1, FIRST);
  const second = await setup.open(2, SECOND);
  const decision = await setup.decide(first.claimId);
  await setup.ackAll(1);
  for (const [n, claim, commit] of [
    [1, first, FIRST],
    [2, second, SECOND],
  ] as const) {
    const ready = await setup.ports.claims.ready(agent(n), claim.claimId, {
      generation: 1,
      commit,
    });
    expect(ready).toMatchObject({ ok: true, value: { repeated: false } });
  }
  await setup.ports.train.resume();
  expect(setup.started).toHaveLength(1);
  const attempt = setup.started[0];
  if (attempt === undefined) throw new Error("no check was started");
  const pins: ClaimPin[] = [
    { claimId: first.claimId, generation: 1, commit: FIRST },
    { claimId: second.claimId, generation: 1, commit: SECOND },
  ];
  expect(
    attempt.pins.map(({ claimId, generation, commit }) => ({ claimId, generation, commit })),
  ).toEqual(expect.arrayContaining(pins));
  expect(attempt.pins).toHaveLength(2);
  return { first, second, decision, attempt };
}

/** Records a passing report for the attempt, as the checks module does when its run finishes. */
async function pass(setup: Setup, attempt: CheckAttempt): Promise<void> {
  const recorded = await setup.ports.train.recordCheck({
    attemptId: attempt.attemptId,
    candidate: attempt.candidate,
    result: "pass",
    logDigest: null,
    finishedAt: attempt.createdAt,
  });
  expect(recorded.ok).toBe(true);
  await setup.ports.train.resume();
}

function events(setup: Setup): RailheadEvent[] {
  return setup.log.replay(0, 256).events;
}

function intentCount(setup: Setup): unknown {
  return setup.sql.exec("SELECT COUNT(*) AS n FROM merge_intents").one().n;
}

function batchOf(setup: Setup, attempt: CheckAttempt): unknown {
  return setup.sql
    .exec("SELECT state, failure FROM train_batches WHERE attempt_id = ?", attempt.attemptId)
    .toArray();
}

/** Asserts that the attempt's batch failed authorization and nothing was authorized or published. */
function expectNothingLanded(setup: Setup, attempt: CheckAttempt): void {
  expect(batchOf(setup, attempt)).toEqual([{ state: "failed", failure: "authorization_refused" }]);
  expect(intentCount(setup)).toBe(0);
  const types = events(setup).map((event) => event.type);
  expect(types).not.toContain("train.intent");
  expect(types).not.toContain("train.main");
  expect(setup.main()).toBe(MAIN);
}

describe("the installed authorization module", () => {
  it("authorizes a ready two-claim batch whose check passed, and the main writer lands it", async () => {
    await withRepo(async (setup) => {
      const { first, second, decision, attempt } = await readyPair(setup);
      await pass(setup, attempt);

      expect(setup.main()).toBe(CANDIDATE);
      const log = events(setup);
      const intent = log.find((event) => event.type === "train.intent");
      expect(intent).toMatchObject({
        actor: { kind: "system", id: "sys_train" },
        data: {
          expectedMain: MAIN,
          candidate: CANDIDATE,
          claims: expect.arrayContaining([first.claimId, second.claimId]),
          decisions: [decision],
          checkRunId: attempt.attemptId,
        },
      });
      const types = log.map((event) => event.type);
      expect(types.indexOf("train.intent")).toBeLessThan(types.indexOf("train.main"));
      expect(log.filter((event) => event.type === "claim.merged")).toHaveLength(2);
      expect(setup.sql.exec("SELECT status, main FROM merge_intents").toArray()).toEqual([
        { status: "updated", main: CANDIDATE },
      ]);

      // A repeat for the same attempt returns the intent already written, with no new event.
      const head = log.length;
      const repeated = await setup.ports.authorization.authorize(attempt.attemptId);
      expect(repeated).toMatchObject({
        ok: true,
        value: { checkAttemptId: attempt.attemptId, status: "updated", main: CANDIDATE },
      });
      expect(events(setup)).toHaveLength(head);
      expect(intentCount(setup)).toBe(1);
    });
  });

  it("refuses an attempt it cannot read before any check is recorded", async () => {
    await withRepo(async (setup) => {
      const { attempt } = await readyPair(setup);

      expect(await setup.ports.authorization.authorize("not a check run")).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(await setup.ports.authorization.authorize("chk_unknown001")).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(await setup.ports.authorization.authorize(attempt.attemptId)).toMatchObject({
        ok: false,
        code: "check_not_passed",
      });
      expect(intentCount(setup)).toBe(0);
      expect(setup.main()).toBe(MAIN);
    });
  });

  it("refuses a stale batch whose claim was readied again since its check started", async () => {
    await withRepo(async (setup) => {
      const { second, attempt } = await readyPair(setup);
      const ready = setup.ports.claims.readyPin(second.claimId);
      if (ready === null) throw new Error("the claim is not ready");
      const pin: ClaimPin = { claimId: second.claimId, generation: 1, commit: SECOND };
      const reopened = setup.log.transaction((tx) =>
        setup.ports.claims.reopen(tx, pin, ready.episode, "lost_conflict"),
      ).value;
      expect(reopened).toBe(true);
      const again = await setup.ports.claims.ready(agent(2), second.claimId, {
        generation: 1,
        commit: SECOND,
      });
      expect(again).toMatchObject({ ok: true, value: { repeated: false } });

      await pass(setup, attempt);

      expectNothingLanded(setup, attempt);
      expect(await setup.ports.authorization.authorize(attempt.attemptId)).toMatchObject({
        ok: false,
        code: "decision_superseded",
      });
    });
  });

  it("refuses a batch whose decision was superseded after its check started", async () => {
    await withRepo(async (setup) => {
      const { first, decision, attempt } = await readyPair(setup);
      const next = await setup.decide(first.claimId, decision.decisionId);
      expect(next.version).toBe(decision.version + 1);

      await pass(setup, attempt);

      expectNothingLanded(setup, attempt);
      expect(await setup.ports.authorization.authorize(attempt.attemptId)).toMatchObject({
        ok: false,
        code: "decision_superseded",
      });
    });
  });

  it("refuses a batch whose claim moved to another agent after its check started", async () => {
    await withRepo(async (setup) => {
      const { second, attempt } = await readyPair(setup);
      const ready = setup.ports.claims.readyPin(second.claimId);
      if (ready === null) throw new Error("the claim is not ready");
      const pin: ClaimPin = { claimId: second.claimId, generation: 1, commit: SECOND };
      const reopened = setup.log.transaction((tx) =>
        setup.ports.claims.reopen(tx, pin, ready.episode, "lost_conflict"),
      ).value;
      expect(reopened).toBe(true);
      setup.advance(CLAIM_LEASE_MS);
      await setup.ports.claims.resume();
      const taken = await setup.ports.claims.work(agent(3));
      expect(taken).toMatchObject({ ok: true, value: { claim: { claimId: second.claimId } } });
      expect(setup.ports.claims.currentGeneration(second.claimId)).toBe(2);

      await pass(setup, attempt);

      expectNothingLanded(setup, attempt);
      expect(await setup.ports.authorization.authorize(attempt.attemptId)).toMatchObject({
        ok: false,
        code: "stale_generation",
      });
    });
  });
});
