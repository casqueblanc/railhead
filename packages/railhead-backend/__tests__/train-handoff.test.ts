import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClaimView } from "@railhead/shared/agent-api";
import type { CommitSha, DecisionRef } from "@railhead/shared/events";
import {
  ARTIFACTS_LIMITS,
  createArtifactsAdapter,
  forkRepoName,
  mainRepoName,
} from "../src/artifacts/adapter";
import { FakeArtifacts } from "../src/artifacts/fake";
import type { ClaimPin, ClaimsPort } from "../src/contracts/claims";
import type { DecisionsPort } from "../src/contracts/decisions";
import type { InboxPort } from "../src/contracts/inbox";
import type { AgentPrincipal, GrantFor } from "../src/contracts/principals";
import { fail, ok } from "../src/contracts/result";
import type { CheckAttempt, TrainPort } from "../src/contracts/train";
import { unavailableTrain } from "../src/contracts/unavailable";
import { createClaims } from "../src/modules/claims/module";
import { createDecisions } from "../src/modules/decisions/decisions";
import { createInbox } from "../src/modules/inbox/inbox";
import {
  createTrain,
  EXHAUSTED_FAILURES,
  MAX_QUEUE,
  MAX_WAKE_FAILURES,
  type Train,
} from "../src/modules/train/scheduler";
import { insertEntry, readWake } from "../src/modules/train/store";
import { composeRepo, resumables, resumeAll, type RepoPorts } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { EarliestAlarm } from "../src/repo/storage";
import { createAuthorization } from "../src/train/authorize";

const REPO = "rep_handoff0001";
const ROOT = "1".repeat(40);
const MAIN = "2".repeat(40);
const WORK = "4".repeat(40);
const LATER = "5".repeat(40);
const OWNER = "usr_owner0001";

function agent(n: number): AgentPrincipal {
  return { kind: "agent", agentId: `agt_agent000${n}`, ownerId: OWNER, repoId: REPO };
}

function candidateOf(pins: readonly ClaimPin[]): CommitSha {
  return pins.length === 1 && pins[0]?.commit === LATER ? "8".repeat(40) : "7".repeat(40);
}

interface Setup {
  sql: SqlStorage;
  log: EventLog;
  claims: ClaimsPort;
  inbox: InboxPort;
  decisions: DecisionsPort;
  train: Train;
  /** Every time the Repo's alarm was asked for, oldest first. */
  wakes: number[];
  /** Every pin list the merge port was asked to compose, oldest first. */
  composed: ClaimPin[][];
  /** Every check attempt started, oldest first. */
  started: CheckAttempt[];
  /** The claim's queue entries and their states. */
  entries(): { commit: string; state: string; next: string | null }[];
  /** Files an issue and claims it for agent 1, with `commits` pushed to its fork. */
  open(...commits: string[]): Promise<ClaimView>;
  /** Records the next version of `decisionId`, asking the question first when it is `undefined`. */
  decide(claimId: string, decisionId?: string): Promise<DecisionRef>;
  /** Acknowledges every inbox item agent 1 has pending. */
  ackAll(): Promise<void>;
  /** Pushes `commit` to the claim's fork. */
  push(claimId: string, commit: string): Promise<void>;
  /**
   * Holds the answer of the train's next `claims.pin` read, which has already run, until `release`
   * is called. `reached` resolves once the read has answered.
   */
  holdNextPin(): { reached: Promise<void>; release(): void };
  /** Whether main can be read; while false, every read refuses with `unavailable`. */
  mainUp: boolean;
  /** Moves the Repo's clock forward. */
  advance(ms: number): void;
  /** The Repo's clock. */
  now(): number;
  /** The alarm time the object's storage holds, or `null`. */
  storedAlarm(): Promise<number | null>;
  /**
   * Runs what the Repo's alarm handler runs: marks the alarm fired, resumes every module that owes
   * work and waits for the wakes they asked for. Only with `realAlarm`.
   */
  fireAlarm(): Promise<void>;
}

/** Where a harness runs, for a test that stops the object and builds the modules again. */
interface HandoffOptions {
  /** The Repo object whose storage the modules use. */
  stub: DurableObjectStub;
  /** The Artifacts fake, kept across a restart since it stands for a remote service. */
  fake: FakeArtifacts;
  /** Whether wakes reach the object's storage alarm, as the Repo's do, rather than a list only. */
  realAlarm: boolean;
}

/**
 * Runs `body` in a fresh Repo with the real claims, inbox, decisions, train and authorization
 * modules. Artifacts is the fake behind the real adapter; main, the check definitions, merging and
 * check runs are fakes the train reaches through its ports.
 */
function withHandoff<T>(
  body: (setup: Setup) => Promise<T>,
  install: (train: TrainPort) => TrainPort = (train) => train,
  options: HandoffOptions = {
    stub: env.REPO.getByName(crypto.randomUUID()),
    fake: new FakeArtifacts(),
    realAlarm: false,
  },
): Promise<T> {
  const { stub, fake, realAlarm } = options;
  return runInDurableObject(stub, async (_instance, state) => {
    const mainRepo = await mainRepoName(REPO);
    if (!fake.repos.has(mainRepo)) fake.seed(mainRepo, [ROOT, MAIN]);
    const log = EventLog.open(state.storage, REPO, fake.clock);
    const wakes: number[] = [];
    // A failed alarm write fails `fireAlarm`, since `settle` throws for it.
    const alarm = new EarliestAlarm(state.storage, () => {});
    if (realAlarm) await alarm.load();
    const context = {
      repoId: REPO,
      storage: state.storage,
      log,
      clock: fake.clock,
      env,
      wake: (at: number) => {
        wakes.push(at);
        if (realAlarm) void alarm.request(at);
      },
    };
    const composed: ClaimPin[][] = [];
    const started: CheckAttempt[] = [];
    let held: { reach(): void; released: Promise<void> } | null = null;
    const base = composeRepo(context);
    const claims = createClaims(context, () => ports);
    const inbox = createInbox(context);
    const decisions = createDecisions(context, () => ports);
    const train = createTrain(context, () => ports);
    const authorization = createAuthorization(context, {
      attemptOutcome: (attemptId) => train.attemptOutcome(attemptId),
      currentGeneration: (claimId) => claims.currentGeneration(claimId),
      currentVersions: (claimId) => decisions.currentVersions(claimId),
    });
    const ports: RepoPorts = {
      ...base,
      artifacts: createArtifactsAdapter(
        { ...context, namespace: fake },
        { ...ARTIFACTS_LIMITS, callTimeoutMs: 50 },
      ),
      claims: {
        ...claims,
        async pin(claimId) {
          const answer = await claims.pin(claimId);
          const hold = held;
          held = null;
          if (hold !== null) {
            hold.reach();
            await hold.released;
          }
          return answer;
        },
      },
      inbox,
      decisions,
      train: install(train),
      authorization,
      mainWriter: {
        ...base.mainWriter,
        head: async () => (setup.mainUp ? ok(MAIN) : fail("unavailable", "Main cannot be read.")),
      },
      checks: {
        definitions: async (main) =>
          ok([{ name: "test", source: main, digest: "d".repeat(64), acceptance: null }]),
        start: async (attempt) => {
          started.push(attempt);
          return ok({ attemptId: attempt.attemptId });
        },
      },
      merge: {
        compose: async (_main, pins) => {
          composed.push(pins);
          return ok({ kind: "clean", candidate: candidateOf(pins) });
        },
      },
    };
    const push = async (claimId: string, commit: string) => {
      const repo = fake.repos.get(await forkRepoName(REPO, claimId));
      if (repo === undefined) throw new Error("no such fork");
      repo.commits.push(commit);
    };
    let asked = 0;
    const setup: Setup = {
      sql: state.storage.sql,
      log,
      claims,
      inbox,
      decisions,
      train,
      wakes,
      composed,
      started,
      entries: () =>
        train.entries(64).map((entry) => ({
          commit: entry.pin.commit,
          state: entry.state,
          next: entry.nextCommit,
        })),
      async open(...commits) {
        const grant: GrantFor<"issue.file"> = {
          kind: "human",
          userId: OWNER,
          repoId: REPO,
          grantId: crypto.randomUUID(),
          action: { kind: "issue.file", title: "Add uploads", body: "Do it." },
        };
        const filed = await claims.fileIssue(grant);
        if (!filed.ok) throw new Error(`filing refused: ${filed.code}`);
        const claimed = await claims.work(agent(1));
        if (!claimed.ok) throw new Error(`claim refused: ${claimed.code}`);
        for (const commit of commits) await push(claimed.value.claim.claimId, commit);
        return claimed.value.claim;
      },
      async decide(claimId, existing) {
        let decisionId = existing;
        if (decisionId === undefined) {
          asked += 1;
          const question = await decisions.ask(agent(1), claimId, {
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
        const current = decisions
          .currentVersions(claimId)
          ?.find((d) => d.decisionId === decisionId);
        const recorded = await decisions.record({
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
      async ackAll() {
        const delivered = await inbox.pending(agent(1), 16);
        if (!delivered.ok) throw new Error(`pending refused: ${delivered.code}`);
        for (const { item } of delivered.value.items) {
          const acked = await inbox.ack(agent(1), item, "Follow the decision.");
          if (!acked.ok) throw new Error(`ack refused: ${acked.code}`);
        }
      },
      push,
      holdNextPin() {
        const reached = signal();
        const released = signal();
        held = { reach: reached.resolve, released: released.promise };
        return { reached: reached.promise, release: released.resolve };
      },
      mainUp: true,
      advance: (ms) => fake.advance(ms),
      now: () => fake.clock(),
      storedAlarm: () => state.storage.getAlarm(),
      async fireAlarm() {
        if (!realAlarm) throw new Error("this harness has no storage alarm");
        alarm.fired();
        await resumeAll(REPO, resumables(ports));
        await alarm.settle();
      },
    };
    return body(setup);
  });
}

/** A promise and the call that resolves it. */
function signal(): { promise: Promise<void>; resolve(): void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

function claimState(sql: SqlStorage, claimId: string): string {
  return sql
    .exec<{ state: string }>("SELECT state FROM claims_claims WHERE claim_id = ?", claimId)
    .one().state;
}

describe("ready hands its pin to the train", () => {
  it("queues the pin in ready's transaction and the alarm's drive schedules it", async () => {
    await withHandoff(async (setup) => {
      const claim = await setup.open(WORK);
      const before = setup.wakes.length;

      const ready = await setup.claims.ready(agent(1), claim.claimId, {
        generation: 1,
        commit: WORK,
      });

      expect(ready).toMatchObject({ ok: true, value: { repeated: false } });
      expect(setup.entries()).toEqual([{ commit: WORK, state: "queued", next: null }]);
      // The pin asks for the alarm, and nothing drives before the alarm does.
      expect(setup.wakes.length).toBe(before + 1);
      expect(setup.composed).toEqual([]);

      await setup.train.resume();

      const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: WORK };
      expect(setup.composed).toEqual([[pin]]);
      expect(setup.started).toHaveLength(1);
      expect(setup.started[0]).toMatchObject({ expectedMain: MAIN, pins: [pin], decisions: [] });
      expect(setup.entries()).toEqual([{ commit: WORK, state: "batched", next: null }]);
    });
  });

  it("drives a committed pin from the Repo's alarm after the object restarts before any drive", async () => {
    // The clock runs an hour ahead, so the runtime never fires the stored alarm on its own; the
    // test fires it as the Repo's handler does, once the object has been rebuilt from storage.
    const options: HandoffOptions = {
      stub: env.REPO.getByName(crypto.randomUUID()),
      fake: new FakeArtifacts(Date.now() + 60 * 60_000),
      realAlarm: true,
    };
    const { claimId, readyAt } = await withHandoff(
      async (setup) => {
        const claim = await setup.open(WORK);
        const at = setup.now();
        const ready = await setup.claims.ready(agent(1), claim.claimId, {
          generation: 1,
          commit: WORK,
        });
        expect(ready).toMatchObject({ ok: true, value: { repeated: false } });
        expect(setup.composed).toEqual([]);
        expect(setup.started).toEqual([]);
        return { claimId: claim.claimId, readyAt: at };
      },
      undefined,
      options,
    );

    // The object stops after ready committed and before anything drove the train.
    await evictDurableObject(options.stub);

    await withHandoff(
      async (setup) => {
        // The alarm was written with ready's transaction and survived the restart.
        const stored = await setup.storedAlarm();
        expect(stored).not.toBeNull();
        expect(stored).toBeLessThanOrEqual(readyAt);
        expect(setup.entries()).toEqual([{ commit: WORK, state: "queued", next: null }]);

        await setup.fireAlarm();

        const pin: ClaimPin = { claimId, generation: 1, commit: WORK };
        expect(setup.composed).toEqual([[pin]]);
        expect(setup.started).toHaveLength(1);
        expect(setup.started[0]).toMatchObject({ expectedMain: MAIN, pins: [pin] });
        expect(setup.entries()).toEqual([{ commit: WORK, state: "batched", next: null }]);

        // A later alarm while the check runs neither batches the pin again nor starts another run.
        await setup.fireAlarm();
        expect(setup.composed).toHaveLength(1);
        expect(setup.started).toHaveLength(1);
      },
      undefined,
      options,
    );
  });

  it("queues nothing for a repeated ready of the same pin", async () => {
    await withHandoff(async (setup) => {
      const claim = await setup.open(WORK);
      const request = { generation: 1, commit: WORK };
      expect((await setup.claims.ready(agent(1), claim.claimId, request)).ok).toBe(true);
      await setup.train.resume();
      const wakes = setup.wakes.length;

      const again = await setup.claims.ready(agent(1), claim.claimId, request);

      expect(again).toMatchObject({ ok: true, value: { repeated: true } });
      expect(setup.entries()).toEqual([{ commit: WORK, state: "batched", next: null }]);
      expect(setup.wakes.length).toBe(wakes);
      expect(setup.composed).toHaveLength(1);
    });
  });

  it("records no ready when the train's queue is full, and pins once it has room", async () => {
    await withHandoff(async (setup) => {
      const claim = await setup.open(WORK);
      setup.sql.exec("DELETE FROM train_wake");
      for (let n = 0; n < MAX_QUEUE; n += 1) {
        const other = { claimId: `clm_filler${String(n).padStart(4, "0")}`, generation: 1 };
        insertEntry(setup.sql, { ...other, commit: ROOT }, 1, 0);
      }
      const head = setup.log.head();
      const request = { generation: 1, commit: WORK };

      expect(await setup.claims.ready(agent(1), claim.claimId, request)).toMatchObject({
        ok: false,
        code: "busy",
      });
      expect(claimState(setup.sql, claim.claimId)).toBe("working");
      expect(setup.log.head()).toBe(head);
      expect(setup.entries().filter((entry) => entry.commit === WORK)).toEqual([]);

      setup.sql.exec("DELETE FROM train_queue WHERE claim_id = 'clm_filler0000'");
      expect(await setup.claims.ready(agent(1), claim.claimId, request)).toMatchObject({
        ok: true,
        value: { repeated: false },
      });
      expect(claimState(setup.sql, claim.claimId)).toBe("ready");
    });
  });

  it("records no ready while the train is missing", async () => {
    await withHandoff(
      async (setup) => {
        const claim = await setup.open(WORK);
        const head = setup.log.head();

        expect(
          await setup.claims.ready(agent(1), claim.claimId, { generation: 1, commit: WORK }),
        ).toMatchObject({ ok: false, code: "unavailable" });
        expect(claimState(setup.sql, claim.claimId)).toBe("working");
        expect(setup.log.head()).toBe(head);
      },
      () => unavailableTrain,
    );
  });
});

/** Agent 1's claim, ready at `WORK` under version 1 of a decision. */
async function readyUnderFirst(setup: Setup) {
  const claim = await setup.open(WORK);
  const first = await setup.decide(claim.claimId);
  await setup.ackAll();
  const ready = await setup.claims.ready(agent(1), claim.claimId, {
    generation: 1,
    commit: WORK,
  });
  expect(ready.ok).toBe(true);
  return { claim, first };
}

describe("a re-ready after a superseded decision", () => {
  it("queues the same commit again after the train dropped the superseded pin", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);
      const second = await setup.decide(claim.claimId, first.decisionId);

      // The train's read finds the pin superseded: the claim reopens and the entry is dropped.
      await setup.train.resume();
      expect(claimState(setup.sql, claim.claimId)).toBe("working");
      expect(setup.entries()).toEqual([{ commit: WORK, state: "dropped", next: null }]);
      expect(setup.composed).toEqual([]);

      await setup.ackAll();
      const ready = await setup.claims.ready(agent(1), claim.claimId, {
        generation: 1,
        commit: WORK,
      });
      expect(ready).toMatchObject({ ok: true, value: { repeated: false } });
      expect(setup.entries()).toEqual([{ commit: WORK, state: "queued", next: null }]);

      await setup.train.resume();

      const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: WORK };
      expect(setup.composed).toEqual([[pin]]);
      expect(setup.started.at(-1)).toMatchObject({ pins: [pin], decisions: [second] });
    });
  });

  it("keeps a same-commit re-ready queued while the drive that read the old episode drops it", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);
      const second = await setup.decide(claim.claimId, first.decisionId);
      // Main is down for the old drive, so after its drop step it stops before forming a batch.
      setup.mainUp = false;

      // The drive's read finds the pin superseded and reopens the claim; its answer is held.
      const hold = setup.holdNextPin();
      const drive = setup.train.resume();
      await hold.reached;
      expect(claimState(setup.sql, claim.claimId)).toBe("working");

      // The holder acknowledges the new version and marks the same commit ready again.
      await setup.ackAll();
      const ready = await setup.claims.ready(agent(1), claim.claimId, {
        generation: 1,
        commit: WORK,
      });
      expect(ready).toMatchObject({ ok: true, value: { repeated: false } });

      // The old drive resumes with its superseded answer and drops nothing it did not read.
      hold.release();
      await drive;

      expect(claimState(setup.sql, claim.claimId)).toBe("ready");
      expect(setup.entries()).toEqual([{ commit: WORK, state: "queued", next: null }]);
      expect(setup.composed).toEqual([]);
      const wake = readWake(setup.sql);
      expect(wake).not.toBeNull();
      expect(setup.wakes.at(-1)).toBe(wake?.dueAt);

      // The next drive schedules the pin under the new version.
      setup.mainUp = true;
      setup.advance(Math.max((wake?.dueAt ?? 0) - setup.now(), 0));
      await setup.train.resume();

      const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: WORK };
      expect(setup.composed).toEqual([[pin]]);
      expect(setup.started.at(-1)).toMatchObject({ pins: [pin], decisions: [second] });
      expect(setup.entries()).toEqual([{ commit: WORK, state: "batched", next: null }]);
    });
  });

  it("schedules the new commit once the batch formed for the old one fails authorization", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);
      await setup.train.resume();
      const old = setup.started[0];
      if (old === undefined) throw new Error("no check was started for the first pin");
      expect(old.decisions).toEqual([first]);

      const second = await setup.decide(claim.claimId, first.decisionId);
      // The holder's status read reopens the claim; it adapts, acknowledges and marks it ready.
      expect(await setup.claims.activeClaim(agent(1))).toMatchObject({
        ok: true,
        value: { state: "working" },
      });
      await setup.push(claim.claimId, LATER);
      await setup.ackAll();
      const ready = await setup.claims.ready(agent(1), claim.claimId, {
        generation: 1,
        commit: LATER,
      });
      expect(ready).toMatchObject({ ok: true, value: { repeated: false } });
      expect(setup.entries()).toEqual([{ commit: WORK, state: "batched", next: LATER }]);

      // The old batch's check passes, but authorization refuses the superseded version.
      const recorded = await setup.train.recordCheck({
        attemptId: old.attemptId,
        candidate: old.candidate,
        result: "pass",
        logDigest: null,
        finishedAt: old.createdAt,
      });
      expect(recorded.ok).toBe(true);

      expect(setup.train.batches(2).map((batch) => batch.failure)).toEqual([
        null,
        "authorization_refused",
      ]);
      const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: LATER };
      expect(setup.composed.at(-1)).toEqual([pin]);
      expect(setup.started.at(-1)).toMatchObject({ pins: [pin], decisions: [second] });
      expect(setup.entries()).toEqual([{ commit: LATER, state: "batched", next: null }]);
    });
  });

  it("schedules a same-commit re-ready under the new version when the old batch's check fails", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);
      await setup.train.resume();
      const old = setup.started[0];
      if (old === undefined) throw new Error("no check was started for the first pin");
      expect(old.decisions).toEqual([first]);

      // A superseding version reopens the claim; the holder readies the same commit under it.
      const second = await setup.decide(claim.claimId, first.decisionId);
      expect(await setup.claims.activeClaim(agent(1))).toMatchObject({
        ok: true,
        value: { state: "working" },
      });
      await setup.ackAll();
      const ready = await setup.claims.ready(agent(1), claim.claimId, {
        generation: 1,
        commit: WORK,
      });
      expect(ready).toMatchObject({ ok: true, value: { repeated: false } });
      expect(setup.entries()).toEqual([{ commit: WORK, state: "batched", next: null }]);

      // The old attempt fails. It belongs to the old episode, so the new one is not dropped.
      const recorded = await setup.train.recordCheck({
        attemptId: old.attemptId,
        candidate: old.candidate,
        result: "fail",
        logDigest: null,
        finishedAt: old.createdAt,
      });
      expect(recorded.ok).toBe(true);

      expect(setup.train.batches(2).map((batch) => batch.failure)).toEqual([null, "check_fail"]);
      const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: WORK };
      expect(setup.started).toHaveLength(2);
      expect(setup.started.at(-1)).toMatchObject({ pins: [pin], decisions: [second] });
      expect(setup.started.at(-1)?.attemptId).not.toBe(old.attemptId);
      expect(setup.entries()).toEqual([{ commit: WORK, state: "batched", next: null }]);
      expect(claimState(setup.sql, claim.claimId)).toBe("ready");
    });
  });
});

describe("a re-ready while the train's retries have run out", () => {
  it("asks for a drive again, so the new commit is scheduled without another call", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);
      setup.mainUp = false;
      for (let drive = 0; drive <= MAX_WAKE_FAILURES; drive += 1) {
        const wake = readWake(setup.sql);
        if (wake === null || wake.failures === EXHAUSTED_FAILURES) break;
        setup.advance(Math.max(wake.dueAt - setup.now(), 0));
        await setup.train.resume();
      }
      expect(readWake(setup.sql)?.failures).toBe(EXHAUSTED_FAILURES);
      expect(setup.entries()).toEqual([{ commit: WORK, state: "queued", next: null }]);

      // The holder adapts to a newer version while the old entry still waits.
      await setup.decide(claim.claimId, first.decisionId);
      expect((await setup.claims.activeClaim(agent(1))).ok).toBe(true);
      await setup.push(claim.claimId, LATER);
      await setup.ackAll();
      const asked = setup.wakes.length;
      const ready = await setup.claims.ready(agent(1), claim.claimId, {
        generation: 1,
        commit: LATER,
      });
      expect(ready).toMatchObject({ ok: true, value: { repeated: false } });

      // The re-ready restarts the exhausted wake and asks for the alarm; main is back.
      expect(readWake(setup.sql)).toMatchObject({ failures: 0 });
      expect(setup.wakes.length).toBe(asked + 1);
      setup.mainUp = true;
      await setup.train.resume();
      expect(setup.composed).toEqual([[{ claimId: claim.claimId, generation: 1, commit: LATER }]]);
    });
  });
});

describe("a re-ready of a commit that already landed", () => {
  it("is refused after a superseding decision, so no ready skips the new version's check", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);
      await setup.train.resume();
      const attempt = setup.started[0];
      if (attempt === undefined) throw new Error("no check was started");
      // The landing is recorded as the train's main writer would leave it.
      setup.sql.exec(
        "UPDATE train_queue SET state = 'landed' WHERE claim_id = ? AND generation = 1",
        claim.claimId,
      );

      await setup.decide(claim.claimId, first.decisionId);
      expect((await setup.claims.activeClaim(agent(1))).ok).toBe(true);
      await setup.ackAll();
      const head = setup.log.head();

      expect(
        await setup.claims.ready(agent(1), claim.claimId, { generation: 1, commit: WORK }),
      ).toMatchObject({ ok: false, code: "decision_superseded" });
      expect(claimState(setup.sql, claim.claimId)).toBe("working");
      expect(setup.log.head()).toBe(head);

      // Adapted work under a new commit is queued.
      await setup.push(claim.claimId, LATER);
      expect(
        await setup.claims.ready(agent(1), claim.claimId, { generation: 1, commit: LATER }),
      ).toMatchObject({ ok: true, value: { repeated: false } });
      expect(setup.entries()).toEqual([{ commit: LATER, state: "queued", next: null }]);
    });
  });
});
