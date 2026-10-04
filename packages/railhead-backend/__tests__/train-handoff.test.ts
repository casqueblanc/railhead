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
import type { CheckAttempt, MainRefPort, TrainPort } from "../src/contracts/train";
import {
  UnavailableError,
  unavailableClaims,
  unavailableTrain,
} from "../src/contracts/unavailable";
import { CLAIM_LEASE_MS, createClaims } from "../src/modules/claims/module";
import { createDecisions, MAX_QUESTIONS_PER_CLAIM } from "../src/modules/decisions/decisions";
import { createInbox } from "../src/modules/inbox/inbox";
import { createMainWriter } from "../src/modules/mainWriter/mainWriter";
import {
  createTrain,
  EXHAUSTED_FAILURES,
  MAX_QUEUE,
  MAX_WAKE_FAILURES,
  QUESTION_BASE_MS,
  type Train,
} from "../src/modules/train/scheduler";
import { insertEntry, readWake, settleEntry } from "../src/modules/train/store";
import { composeRepo, resumables, resumeAll, type RepoPorts } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { EarliestAlarm, type AlarmStorage } from "../src/repo/storage";
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
  /** Every merge intent the main writer was asked to publish, oldest first. */
  published: string[];
  /** The claim's queue entries and their states. */
  entries(): { commit: string; state: string; next: string | null }[];
  /** Files an issue and claims it for agent 1, with `commits` pushed to its fork. */
  open(...commits: string[]): Promise<ClaimView>;
  /** Files an issue and claims it for agent `n`, with `commits` pushed to its fork. */
  openFor(n: number, ...commits: string[]): Promise<ClaimView>;
  /** Whether the decisions port the other modules reach can read a claim's current versions. */
  versionsKnown: boolean;
  /**
   * While set, the merge port answers a conflict between these two pins on `conflictPath` for any
   * pin list holding both, rather than a clean candidate.
   */
  conflict: [ClaimPin, ClaimPin] | null;
  /** The path the merge port names for that conflict. */
  conflictPath: string;
  /** Records the next version of `decisionId`, asking the question first when it is `undefined`. */
  decide(claimId: string, decisionId?: string): Promise<DecisionRef>;
  /** Acknowledges every inbox item agent `n`, 1 unless given, has pending. */
  ackAll(n?: number): Promise<void>;
  /** Pushes `commit` to the claim's fork. */
  push(claimId: string, commit: string): Promise<void>;
  /**
   * Holds the answer of the train's next `claims.pin` read, which has already run, until `release`
   * is called. `reached` resolves once the read has answered.
   */
  holdNextPin(): { reached: Promise<void>; release(): void };
  /** Makes reads of main wait until the returned function releases them. */
  holdMain(): { reached: Promise<void>; release: () => void };
  /** Makes the next update of main wait, once applied, until the returned function releases it. */
  holdUpdate(): { reached: Promise<void>; release: () => void };
  /** The Artifacts fake behind the adapter. */
  fake: FakeArtifacts;
  /** The commit main is at. */
  main(): CommitSha;
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
  /** How many of the first storage alarm writes reject, as a storage fault would. */
  failedAlarmWrites?: number;
}

/**
 * Runs `body` in a fresh Repo with the real claims, inbox, decisions, train and authorization
 * modules. Artifacts is the fake behind the real adapter; the real main writer moves a fake main
 * ref; the check definitions, merging and check runs are fakes the train reaches through its ports.
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
  const { stub, fake, realAlarm, failedAlarmWrites = 0 } = options;
  return runInDurableObject(stub, async (_instance, state) => {
    const mainRepo = await mainRepoName(REPO);
    if (!fake.repos.has(mainRepo)) fake.seed(mainRepo, [ROOT, MAIN]);
    const log = EventLog.open(state.storage, REPO, fake.clock);
    const wakes: number[] = [];
    // A failed alarm write fails `fireAlarm`, since `settle` throws for it.
    let failing = failedAlarmWrites;
    const alarmStorage: AlarmStorage = {
      getAlarm: (alarmOptions) => state.storage.getAlarm(alarmOptions),
      setAlarm: async (at, alarmOptions) => {
        if (failing > 0) {
          failing -= 1;
          throw new Error("alarm write failed");
        }
        return state.storage.setAlarm(at, alarmOptions);
      },
    };
    const alarm = new EarliestAlarm(alarmStorage, () => {});
    if (realAlarm) await alarm.load();
    const context = {
      repoId: REPO,
      storage: state.storage,
      log,
      clock: fake.clock,
      env,
      wake: async (at: number) => {
        wakes.push(at);
        return realAlarm ? alarm.request(at) : true;
      },
    };
    let mainGate: { reached: () => void; released: Promise<void> } | null = null;
    const composed: ClaimPin[][] = [];
    const started: CheckAttempt[] = [];
    const published: string[] = [];
    let held: { reach(): void; released: Promise<void> } | null = null;
    let updateGate: { reach(): void; released: Promise<void> } | null = null;
    const base = composeRepo(context);
    // Main moves only by a conditional update, as the main writer's ref allows.
    let mainAt: CommitSha = MAIN;
    const mainRef: MainRefPort = {
      read: async () => (setup.mainUp ? ok(mainAt) : fail("unavailable", "Main cannot be read.")),
      update: async (expected, next) => {
        if (mainAt !== expected) return ok({ kind: "rejected", actual: mainAt });
        mainAt = next;
        const gate = updateGate;
        updateGate = null;
        if (gate !== null) {
          gate.reach();
          await gate.released;
        }
        return ok({ kind: "updated" });
      },
    };
    const writer = createMainWriter(
      context,
      () => ({
        authorization,
        attemptOutcome: (attemptId) => train.attemptOutcome(attemptId),
        currentGeneration: (claimId) => claims.currentGeneration(claimId),
        currentVersions: (claimId) => decisions.currentVersions(claimId),
        readyPin: (claimId) => claims.readyPin(claimId),
        readyGateNow: (claimId, generation) => inbox.readyGateNow(claimId, generation),
      }),
      mainRef,
    );
    const claims = createClaims(context, () => ports);
    const inbox = createInbox(context);
    const decisions = createDecisions(context, () => ports);
    const train = createTrain(context, () => ports);
    const authorization = createAuthorization(context, {
      attemptOutcome: (attemptId) => train.attemptOutcome(attemptId),
      currentGeneration: (claimId) => claims.currentGeneration(claimId),
      currentVersions: (claimId) => decisions.currentVersions(claimId),
      readyPin: (claimId) => claims.readyPin(claimId),
      readyGateNow: (claimId, generation) => inbox.readyGateNow(claimId, generation),
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
      decisions: {
        ...decisions,
        currentVersions: (claimId) =>
          setup.versionsKnown ? decisions.currentVersions(claimId) : null,
      },
      train: install(train),
      authorization,
      mainWriter: {
        head: async () => {
          if (mainGate !== null) {
            mainGate.reached();
            await mainGate.released;
          }
          return mainRef.read();
        },
        publish: async (intentId) => {
          published.push(intentId);
          return writer.publish(intentId);
        },
      },
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
        compose: async (_main, pins) => {
          composed.push(pins);
          const pair = setup.conflict;
          if (pair !== null && pair.every((one) => pins.some((pin) => samePin(pin, one)))) {
            return ok({ kind: "conflict", pins: pair, paths: [setup.conflictPath] });
          }
          return ok({ kind: "clean", candidate: candidateOf(pins) });
        },
        discard: async () => ok({ removed: 1 }),
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
      published,
      entries: () =>
        train.entries(64).map((entry) => ({
          commit: entry.pin.commit,
          state: entry.state,
          next: entry.nextCommit,
        })),
      open: (...commits) => setup.openFor(1, ...commits),
      async openFor(n, ...commits) {
        const grant: GrantFor<"issue.file"> = {
          kind: "human",
          userId: OWNER,
          repoId: REPO,
          grantId: crypto.randomUUID(),
          action: { kind: "issue.file", title: "Add uploads", body: "Do it." },
        };
        const filed = await claims.fileIssue(grant);
        if (!filed.ok) throw new Error(`filing refused: ${filed.code}`);
        const claimed = await claims.work(agent(n));
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
      async ackAll(n = 1) {
        const delivered = await inbox.pending(agent(n), 16);
        if (!delivered.ok) throw new Error(`pending refused: ${delivered.code}`);
        for (const { item } of delivered.value.items) {
          const acked = await inbox.ack(agent(n), item, "Follow the decision.");
          if (!acked.ok) throw new Error(`ack refused: ${acked.code}`);
        }
      },
      push,
      versionsKnown: true,
      conflict: null,
      conflictPath: "src/upload.ts",
      fake,
      holdNextPin() {
        const reached = signal();
        const released = signal();
        held = { reach: reached.resolve, released: released.promise };
        return { reached: reached.promise, release: released.resolve };
      },
      holdMain() {
        const reached = signal();
        const released = signal();
        mainGate = { reached: reached.resolve, released: released.promise };
        return {
          reached: reached.promise,
          release: () => {
            mainGate = null;
            released.resolve();
          },
        };
      },
      holdUpdate() {
        const reached = signal();
        const released = signal();
        updateGate = { reach: reached.resolve, released: released.promise };
        return { reached: reached.promise, release: released.resolve };
      },
      main: () => mainAt,
      mainUp: true,
      advance: (ms) => fake.advance(ms),
      now: () => fake.clock(),
      storedAlarm: () => state.storage.getAlarm(),
      async fireAlarm() {
        if (!realAlarm) throw new Error("this harness has no storage alarm");
        alarm.fired();
        await resumeAll(context, resumables(ports));
        await alarm.settle();
      },
    };
    return body(setup);
  });
}

function samePin(left: ClaimPin, right: ClaimPin): boolean {
  return (
    left.claimId === right.claimId &&
    left.generation === right.generation &&
    left.commit === right.commit
  );
}

/** A promise and the function that settles it. */
function signal(): { promise: Promise<void>; resolve: () => void } {
  let settle: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: () => settle?.() };
}

function leaseOf(sql: SqlStorage, claimId: string): number | null {
  return sql
    .exec<{ lease_until: number | null }>(
      "SELECT lease_until FROM claims_claims WHERE claim_id = ?",
      claimId,
    )
    .one().lease_until;
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
      // The pin asks for the alarm, and ready confirms that wake once the pin commits. Before it,
      // ready's transaction asks for the renewed lease and the owed revocation, due now as well.
      // Nothing drives before the alarm does.
      const due = readWake(setup.sql)?.dueAt;
      expect(setup.wakes.slice(before)).toEqual([leaseOf(setup.sql, claim.claimId), due, due, due]);
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

  it("revokes the fork's tokens when ready's alarm write fails, and a repeat arms the wake", async () => {
    // The clock runs an hour ahead, so the runtime never fires a stored alarm on its own. The first
    // five alarm writes reject: the claim's lease when it opens, the renewed lease and the owed
    // revocation ready's transaction asks for, ready's own after revoking, and the repeat's.
    const options: HandoffOptions = {
      stub: env.REPO.getByName(crypto.randomUUID()),
      fake: new FakeArtifacts(Date.now() + 60 * 60_000),
      realAlarm: true,
      failedAlarmWrites: 5,
    };
    await withHandoff(
      async (setup) => {
        const claim = await setup.open(WORK);
        const request = { generation: 1, commit: WORK };

        // A write token granted before ready, as a push still in flight would hold.
        const fork = await forkRepoName(REPO, claim.claimId);
        const inFlight = setup.fake.mintFor(fork, "write", 600);

        // The pin commits, but no alarm holds its drive, so ready does not report success.
        expect(await setup.claims.ready(agent(1), claim.claimId, request)).toMatchObject({
          ok: false,
          code: "unavailable",
        });
        expect(claimState(setup.sql, claim.claimId)).toBe("ready");
        // The fork's tokens were still revoked, so the in-flight push cannot update the fork.
        expect(setup.fake.accepts(inFlight.plaintext)).toBe(false);
        expect(setup.fake.liveTokens(fork)).toEqual([]);
        expect(setup.entries()).toEqual([{ commit: WORK, state: "queued", next: null }]);
        expect(readWake(setup.sql)).toMatchObject({ failures: 0 });
        expect(await setup.storedAlarm()).toBeNull();
        const head = setup.log.head();

        // A repeat finds the entry live and asks for the wake again; that write fails too.
        expect(await setup.claims.ready(agent(1), claim.claimId, request)).toMatchObject({
          ok: false,
          code: "unavailable",
        });
        expect(await setup.storedAlarm()).toBeNull();

        const repaired = await setup.claims.ready(agent(1), claim.claimId, request);
        expect(repaired).toMatchObject({ ok: true, value: { repeated: true } });
        const due = readWake(setup.sql)?.dueAt;
        expect(due).toBeDefined();
        expect(await setup.storedAlarm()).toBe(due);
        // The repeats recorded no second ready and queued no second entry.
        expect(setup.log.head()).toBe(head);
        expect(setup.entries()).toEqual([{ commit: WORK, state: "queued", next: null }]);
        expect(setup.composed).toEqual([]);

        await setup.fireAlarm();

        const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: WORK };
        expect(setup.composed).toEqual([[pin]]);
        expect(setup.started).toHaveLength(1);
        expect(setup.entries()).toEqual([{ commit: WORK, state: "batched", next: null }]);
      },
      undefined,
      options,
    );
  });

  it("arms the wake when ready's revocation fails, and a repeat revokes", async () => {
    const options: HandoffOptions = {
      stub: env.REPO.getByName(crypto.randomUUID()),
      fake: new FakeArtifacts(Date.now() + 60 * 60_000),
      realAlarm: true,
    };
    await withHandoff(
      async (setup) => {
        const claim = await setup.open(WORK);
        const request = { generation: 1, commit: WORK };
        const fork = await forkRepoName(REPO, claim.claimId);
        const inFlight = setup.fake.mintFor(fork, "write", 600);
        setup.fake.failRevocations(100);

        const refused = await setup.claims.ready(agent(1), claim.claimId, request);
        expect(refused.ok).toBe(false);
        expect(claimState(setup.sql, claim.claimId)).toBe("ready");
        expect(setup.fake.accepts(inFlight.plaintext)).toBe(true);
        // The failed revocation did not skip the wake: the pin's drive is scheduled.
        const due = readWake(setup.sql)?.dueAt;
        expect(due).toBeDefined();
        expect(await setup.storedAlarm()).toBe(due);

        setup.fake.failRevocations(0);
        const repeated = await setup.claims.ready(agent(1), claim.claimId, request);
        expect(repeated).toMatchObject({ ok: true, value: { repeated: true } });
        expect(setup.fake.accepts(inFlight.plaintext)).toBe(false);
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
      // The repeat asks again only for the wake the train already owes.
      expect(setup.wakes.slice(wakes)).toEqual([readWake(setup.sql)?.dueAt]);
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

  it("queues a ready pin the train never received when the ready is repeated, once", async () => {
    await withHandoff(async (setup) => {
      const claim = await setup.open(WORK);
      const request = { generation: 1, commit: WORK };
      expect((await setup.claims.ready(agent(1), claim.claimId, request)).ok).toBe(true);
      // A ready claim with no queue entry, as a pin whose handoff was lost would leave it.
      setup.sql.exec("DELETE FROM train_queue");
      setup.sql.exec("DELETE FROM train_wake");
      const head = setup.log.head();

      const repaired = await setup.claims.ready(agent(1), claim.claimId, request);
      const again = await setup.claims.ready(agent(1), claim.claimId, request);

      expect(repaired).toMatchObject({ ok: true, value: { repeated: true } });
      expect(again).toMatchObject({ ok: true, value: { repeated: true } });
      expect(setup.log.head()).toBe(head);
      expect(setup.entries()).toEqual([{ commit: WORK, state: "queued", next: null }]);
      expect(readWake(setup.sql)).not.toBeNull();

      await setup.train.resume();
      const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: WORK };
      expect(setup.composed).toEqual([[pin]]);
      expect(setup.started).toHaveLength(1);
      expect(setup.entries()).toEqual([{ commit: WORK, state: "batched", next: null }]);
    });
  });

  it("queues a pin again on a repeated ready once a late obligation that dropped it is acknowledged", async () => {
    await withHandoff(async (setup) => {
      const claim = await setup.open(WORK);
      const first = await setup.decide(claim.claimId);
      const second = await setup.decide(claim.claimId, first.decisionId);
      await setup.ackAll();
      const request = { generation: 1, commit: WORK };
      expect((await setup.claims.ready(agent(1), claim.claimId, request)).ok).toBe(true);

      // Work that relied on the replaced version lands: rework is owed under the current version,
      // so the gate blocks without a new decision version.
      setup.log.transaction((tx) =>
        setup.decisions.relied(tx, claim.claimId, 1, [
          { decisionId: first.decisionId, version: 1 },
        ]),
      );
      expect(setup.decisions.currentVersions(claim.claimId)).toEqual([second]);
      await setup.train.resume();
      expect(claimState(setup.sql, claim.claimId)).toBe("ready");
      expect(setup.entries()).toEqual([{ commit: WORK, state: "dropped", next: null }]);
      expect(setup.composed).toEqual([]);

      await setup.ackAll();
      const head = setup.log.head();
      const repaired = await setup.claims.ready(agent(1), claim.claimId, request);
      const again = await setup.claims.ready(agent(1), claim.claimId, request);

      expect(repaired).toMatchObject({ ok: true, value: { repeated: true } });
      expect(again).toMatchObject({ ok: true, value: { repeated: true } });
      expect(setup.log.head()).toBe(head);
      expect(setup.entries()).toEqual([{ commit: WORK, state: "queued", next: null }]);

      await setup.train.resume();
      const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: WORK };
      expect(setup.composed).toEqual([[pin]]);
      expect(setup.started).toHaveLength(1);
      expect(setup.started[0]).toMatchObject({ pins: [pin], decisions: [second] });
      expect(setup.entries()).toEqual([{ commit: WORK, state: "batched", next: null }]);
    });
  });

  it("leaves a parked pin held on a repeated ready", async () => {
    await withHandoff(async (setup) => {
      const claim = await setup.open(WORK);
      const request = { generation: 1, commit: WORK };
      expect((await setup.claims.ready(agent(1), claim.claimId, request)).ok).toBe(true);
      const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: WORK };
      settleEntry(setup.sql, pin, "parked", "conflict", setup.now());
      setup.sql.exec("DELETE FROM train_wake");

      const again = await setup.claims.ready(agent(1), claim.claimId, request);

      expect(again).toMatchObject({ ok: true, value: { repeated: true } });
      expect(setup.entries()).toEqual([{ commit: WORK, state: "parked", next: null }]);
      expect(readWake(setup.sql)).toBeNull();
    });
  });

  it("queues nothing for a repeated ready whose pin a newer decision superseded", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);
      setup.sql.exec("DELETE FROM train_queue");
      await setup.decide(claim.claimId, first.decisionId);

      // The repeat reopens the superseded pin and is refused at the unacknowledged version.
      expect(
        await setup.claims.ready(agent(1), claim.claimId, { generation: 1, commit: WORK }),
      ).toMatchObject({ ok: false, code: "unacked_decision" });
      expect(claimState(setup.sql, claim.claimId)).toBe("working");
      expect(setup.entries()).toEqual([]);
    });
  });

  it("refuses a repeated ready while the train is missing, and queues it once it returns", async () => {
    let missing = false;
    await withHandoff(
      async (setup) => {
        const claim = await setup.open(WORK);
        const request = { generation: 1, commit: WORK };
        expect((await setup.claims.ready(agent(1), claim.claimId, request)).ok).toBe(true);
        // A ready claim with no queue entry, as a pin whose handoff was lost would leave it.
        setup.sql.exec("DELETE FROM train_queue");
        setup.sql.exec("DELETE FROM train_wake");
        const head = setup.log.head();
        missing = true;

        expect(await setup.claims.ready(agent(1), claim.claimId, request)).toMatchObject({
          ok: false,
          code: "unavailable",
        });
        expect(claimState(setup.sql, claim.claimId)).toBe("ready");
        expect(setup.log.head()).toBe(head);
        expect(setup.entries()).toEqual([]);
        expect(readWake(setup.sql)).toBeNull();

        missing = false;
        expect(await setup.claims.ready(agent(1), claim.claimId, request)).toMatchObject({
          ok: true,
          value: { repeated: true },
        });
        expect(await setup.claims.ready(agent(1), claim.claimId, request)).toMatchObject({
          ok: true,
          value: { repeated: true },
        });
        expect(setup.log.head()).toBe(head);
        expect(setup.entries()).toEqual([{ commit: WORK, state: "queued", next: null }]);
        expect(readWake(setup.sql)).not.toBeNull();

        await setup.train.resume();
        const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: WORK };
        expect(setup.composed).toEqual([[pin]]);
        expect(setup.started).toHaveLength(1);
      },
      (train) => ({
        ...train,
        holdsLiveEntry: (claimId, generation) =>
          missing
            ? unavailableTrain.holdsLiveEntry(claimId, generation)
            : train.holdsLiveEntry(claimId, generation),
        queue: (tx, pin, episode) =>
          missing ? unavailableTrain.queue(tx, pin, episode) : train.queue(tx, pin, episode),
      }),
    );
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

describe("a conflicting pair", () => {
  const OTHER = "6".repeat(40);
  const REDONE = "9".repeat(40);

  it("asks the owner once, and the answer returns both claims to their agents and the train", async () => {
    await withHandoff(async (setup) => {
      const first = await setup.openFor(1, WORK);
      const second = await setup.openFor(2, OTHER);
      setup.conflict = [
        { claimId: first.claimId, generation: 1, commit: WORK },
        { claimId: second.claimId, generation: 1, commit: OTHER },
      ];
      for (const [n, claim, commit] of [
        [1, first, WORK],
        [2, second, OTHER],
      ] as const) {
        const ready = await setup.claims.ready(agent(n), claim.claimId, { generation: 1, commit });
        expect(ready.ok).toBe(true);
      }
      const before = setup.log.head();

      await setup.train.resume();

      const asked = setup.log.replay(before, 64).events;
      expect(asked.map((event) => event.type)).toEqual(["train.conflict", "question.asked"]);
      expect(asked[1]).toMatchObject({
        actor: { kind: "system", id: "sys_train" },
        data: { claimId: first.claimId },
      });
      const [conflict] = setup.train.conflicts(1);
      expect(conflict).toMatchObject({ state: "asked" });
      const decisionId = conflict?.decisionId;
      if (decisionId == null) throw new Error("no question was asked");
      expect(setup.entries().map((entry) => entry.state)).toEqual(["parked", "parked"]);
      // Another alarm asks nothing more.
      await setup.train.resume();
      expect(setup.log.head()).toBe(before + 2);

      const wakes = setup.wakes.length;
      const recorded = await setup.decisions.record({
        kind: "human",
        userId: OWNER,
        repoId: REPO,
        grantId: crypto.randomUUID(),
        action: {
          kind: "decision.record",
          decisionId,
          option: "keep_first",
          expectedVersion: null,
        },
      });
      expect(recorded).toEqual(ok({ decisionId, version: 1 }));
      // The answer asks for the alarm and reaches both agents.
      expect(setup.wakes.length).toBeGreaterThan(wakes);
      const queued = setup.log
        .replay(before + 2, 64)
        .events.filter((event) => event.type === "inbox.queued");
      // Delivery follows the claim ids, which are random, so compare in agent order.
      const delivered = queued
        .map((event) => event.data)
        .toSorted((left, right) => left.agentId.localeCompare(right.agentId));
      expect(delivered).toMatchObject([
        { agentId: agent(1).agentId, claimId: first.claimId },
        { agentId: agent(2).agentId, claimId: second.claimId },
      ]);

      // The alarm returns the pair to the queue; reading the superseded pins reopens both claims.
      await setup.train.resume();
      expect(setup.train.conflicts(1)).toMatchObject([{ state: "answered" }]);
      expect(claimState(setup.sql, first.claimId)).toBe("working");
      expect(claimState(setup.sql, second.claimId)).toBe("working");
      expect(setup.entries().map((entry) => entry.state)).toEqual(["dropped", "dropped"]);

      // The first agent keeps its change; the second redoes its own to fit. Both land together.
      setup.conflict = null;
      await setup.ackAll(1);
      await setup.ackAll(2);
      await setup.push(second.claimId, REDONE);
      expect(
        (await setup.claims.ready(agent(1), first.claimId, { generation: 1, commit: WORK })).ok,
      ).toBe(true);
      expect(
        (await setup.claims.ready(agent(2), second.claimId, { generation: 1, commit: REDONE })).ok,
      ).toBe(true);
      await setup.train.resume();

      const answer = { decisionId, version: 1 };
      expect(setup.composed.at(-1)).toEqual([
        { claimId: first.claimId, generation: 1, commit: WORK },
        { claimId: second.claimId, generation: 1, commit: REDONE },
      ]);
      expect(setup.started.at(-1)).toMatchObject({ decisions: [answer] });
    });
  });

  it.each([
    ["a newline", "src/up\nload.ts"],
    ["a tab", "src/up\tload.ts"],
  ])(
    "merges the pair one at a time, unparked and unasked, when the conflicted path holds %s",
    async (_name, path) => {
      await withHandoff(async (setup) => {
        const first = await setup.openFor(1, WORK);
        const second = await setup.openFor(2, OTHER);
        const pins: [ClaimPin, ClaimPin] = [
          { claimId: first.claimId, generation: 1, commit: WORK },
          { claimId: second.claimId, generation: 1, commit: OTHER },
        ];
        setup.conflict = pins;
        setup.conflictPath = path;
        for (const [n, pin] of [
          [1, pins[0]],
          [2, pins[1]],
        ] as const) {
          const ready = await setup.claims.ready(agent(n), pin.claimId, {
            generation: 1,
            commit: pin.commit,
          });
          expect(ready.ok).toBe(true);
        }
        const before = setup.log.head();

        await setup.train.resume();

        // No question can name the path, so nothing is parked, asked or recorded about it, and the
        // batch fails as a compose the train cannot use: each pin is merged alone instead.
        const types = setup.log.replay(before, 64).events.map((event) => event.type);
        expect(types).not.toContain("train.conflict");
        expect(types).not.toContain("question.asked");
        expect(setup.train.conflicts(8)).toEqual([]);
        expect(setup.train.batches(2).at(-1)).toMatchObject({
          state: "failed",
          failure: "compose_unsupported",
        });
        expect(setup.composed).toEqual([pins, [pins[0]]]);
        expect(sortedEntries(setup).map((entry) => entry.state)).toEqual(["batched", "queued"]);

        // Each lands in turn.
        await pass(setup);
        expect(setup.composed.at(-1)).toEqual([pins[1]]);
        await pass(setup);
        expect(sortedEntries(setup).map((entry) => entry.state)).toEqual(["landed", "landed"]);
        expect(setup.published).toHaveLength(2);
      });
    },
  );

  it("keeps the question owed with the wake armed when a claim's decision quota is spent", async () => {
    await withHandoff(async (setup) => {
      const first = await setup.openFor(1, WORK);
      const second = await setup.openFor(2, OTHER);
      setup.conflict = [
        { claimId: first.claimId, generation: 1, commit: WORK },
        { claimId: second.claimId, generation: 1, commit: OTHER },
      ];
      for (const [n, claim, commit] of [
        [1, first, WORK],
        [2, second, OTHER],
      ] as const) {
        const ready = await setup.claims.ready(agent(n), claim.claimId, { generation: 1, commit });
        expect(ready.ok).toBe(true);
      }
      // Unanswered dependencies stand in for the decisions that spent the first claim's quota.
      for (let n = 0; n < MAX_QUESTIONS_PER_CLAIM; n += 1) {
        setup.sql.exec(
          `INSERT INTO decision_claims (decision_id, claim_id, agent_id, generation)
           VALUES (?, ?, ?, 1)`,
          `dec_spent${String(n).padStart(6, "0")}`,
          first.claimId,
          agent(1).agentId,
        );
      }
      const before = setup.log.head();

      await setup.train.resume();

      // The pair is parked without a question, and the question stays owed with its wake armed.
      const types = setup.log.replay(before, 64).events.map((event) => event.type);
      expect(types).toEqual(["train.conflict"]);
      const [owing] = setup.train.conflicts(1);
      expect(owing).toMatchObject({ state: "asking", decisionId: null, failures: 1 });
      if (owing === undefined) throw new Error("no pair was parked");
      expect(owing.retryAt - owing.updatedAt).toBe(QUESTION_BASE_MS);
      expect(readWake(setup.sql)).toEqual({ dueAt: owing.retryAt, failures: 0 });
      expect(setup.wakes).toContain(owing.retryAt);
      expect(setup.entries().map((entry) => entry.state)).toEqual(["parked", "parked"]);

      // Once the claim can take another decision, the alarm at the retry time asks the question.
      setup.sql.exec("DELETE FROM decision_claims WHERE decision_id LIKE 'dec_spent%'");
      setup.advance(owing.retryAt - setup.now());
      await setup.train.resume();

      const asked = setup.log.replay(before + 1, 64).events;
      expect(asked.map((event) => event.type)).toEqual(["question.asked"]);
      expect(asked[0]).toMatchObject({ actor: { kind: "system", id: "sys_train" } });
      expect(setup.train.conflicts(1)).toMatchObject([{ state: "asked", failures: 1 }]);
      expect(readWake(setup.sql)).toBeNull();
    });
  });
});

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

  it("forms no batch for a pin a decision superseded after the train read it", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);

      // The train reads the pin under version 1; a version 2 is recorded before the batch forms.
      const hold = setup.holdNextPin();
      const drive = setup.train.resume();
      await hold.reached;
      await setup.decide(claim.claimId, first.decisionId);
      hold.release();
      await drive;

      // The next read reopens the superseded claim and drops its entry. Nothing was checked,
      // authorized or published for the old pin.
      expect(setup.train.batches(8)).toEqual([]);
      expect(setup.composed).toEqual([]);
      expect(setup.started).toEqual([]);
      expect(setup.published).toEqual([]);
      const events = setup.log.replay(0, 64).events.map((event) => event.type);
      expect(events).not.toContain("train.intent");
      expect(events).not.toContain("train.main");
      expect(events.at(-1)).toBe("claim.reopened");
      expect(claimState(setup.sql, claim.claimId)).toBe("working");
      expect(setup.entries()).toEqual([{ commit: WORK, state: "dropped", next: null }]);
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

describe("a decision recorded while the train forms a batch", () => {
  it("forms no batch for the superseded pin, and the train drops it", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);
      const main = setup.holdMain();
      const driving = setup.train.resume();
      await main.reached;

      // The pin and its requirements were read under version 1; version 2 lands before main does.
      await setup.decide(claim.claimId, first.decisionId);
      main.release();
      await driving;

      expect(setup.train.batches(8)).toEqual([]);
      expect(setup.composed).toEqual([]);
      expect(setup.entries()).toEqual([{ commit: WORK, state: "dropped", next: null }]);
      expect(claimState(setup.sql, claim.claimId)).toBe("working");
    });
  });

  it("refuses to authorize a batch whose decision was superseded after it formed", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);
      await setup.train.resume();
      const attempt = setup.started[0];
      if (attempt === undefined) throw new Error("no check was started");
      expect(attempt.decisions).toEqual([first]);

      await setup.decide(claim.claimId, first.decisionId);
      const recorded = await setup.train.recordCheck({
        attemptId: attempt.attemptId,
        candidate: attempt.candidate,
        result: "pass",
        logDigest: null,
        finishedAt: attempt.createdAt,
      });

      expect(recorded.ok).toBe(true);
      expect(setup.train.batches(8)).toMatchObject([
        { state: "failed", failure: "authorization_refused", intentId: null },
      ]);
      expect(setup.sql.exec("SELECT COUNT(*) AS n FROM merge_intents").one().n).toBe(0);
      expect(setup.log.replay(0, 256).events.map((event) => event.type)).not.toContain(
        "train.intent",
      );
      // The retried pin was superseded, so the train's read reopened the claim and dropped it.
      expect(claimState(setup.sql, claim.claimId)).toBe("working");
      expect(setup.entries()).toEqual([{ commit: WORK, state: "dropped", next: null }]);
    });
  });
});

describe("an obligation queued after the batch formed", () => {
  it("authorizes and writes nothing until the agent acknowledges, then lands the pin", async () => {
    await withHandoff(async (setup) => {
      const claim = await setup.open(WORK);
      const first = await setup.decide(claim.claimId);
      const second = await setup.decide(claim.claimId, first.decisionId);
      await setup.ackAll();
      const request = { generation: 1, commit: WORK };
      expect((await setup.claims.ready(agent(1), claim.claimId, request)).ok).toBe(true);
      await setup.train.resume();
      const old = setup.started[0];
      if (old === undefined) throw new Error("no check was started for the pin");
      expect(old.decisions).toEqual([second]);

      // Work that relied on the replaced version lands while the batch is checking: rework is
      // owed under the version the check runs under, so neither the pin nor its versions move.
      setup.log.transaction((tx) =>
        setup.decisions.relied(tx, claim.claimId, 1, [
          { decisionId: first.decisionId, version: 1 },
        ]),
      );
      expect(setup.decisions.currentVersions(claim.claimId)).toEqual([second]);
      expect(claimState(setup.sql, claim.claimId)).toBe("ready");

      const recorded = await setup.train.recordCheck({
        attemptId: old.attemptId,
        candidate: old.candidate,
        result: "pass",
        logDigest: null,
        finishedAt: old.createdAt,
      });
      expect(recorded.ok).toBe(true);

      const events = () => setup.log.replay(0, 128).events.map((event) => event.type);
      expect(setup.train.batches(8).map((batch) => batch.failure)).toEqual([
        "authorization_refused",
      ]);
      expect(events()).not.toContain("train.intent");
      expect(events()).not.toContain("train.main");
      expect(setup.published).toEqual([]);
      expect(setup.main()).toBe(MAIN);
      expect(setup.entries()).toEqual([{ commit: WORK, state: "dropped", next: null }]);
      expect(claimState(setup.sql, claim.claimId)).toBe("ready");

      // The agent acknowledges and repeats its ready; the pin is checked again and lands.
      await setup.ackAll();
      expect(await setup.claims.ready(agent(1), claim.claimId, request)).toMatchObject({
        ok: true,
        value: { repeated: true },
      });
      await setup.train.resume();
      const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: WORK };
      const again = setup.started[1];
      if (again === undefined) throw new Error("the pin was not checked again");
      expect(again).toMatchObject({ pins: [pin], decisions: [second] });
      expect(again.attemptId).not.toBe(old.attemptId);
      expect(
        (
          await setup.train.recordCheck({
            attemptId: again.attemptId,
            candidate: again.candidate,
            result: "pass",
            logDigest: null,
            finishedAt: again.createdAt,
          })
        ).ok,
      ).toBe(true);
      await setup.train.resume();

      expect(setup.published).toHaveLength(1);
      expect(setup.main()).toBe(again.candidate);
      expect(events().filter((type) => type === "train.intent")).toHaveLength(1);
      expect(setup.entries()).toEqual([{ commit: WORK, state: "landed", next: null }]);
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

      // The re-ready restarts the exhausted wake and asks for the alarm, after the renewed lease and
      // the owed revocation; main is back.
      const restarted = readWake(setup.sql);
      expect(restarted).toMatchObject({ failures: 0 });
      expect(setup.wakes.slice(asked)).toEqual([
        leaseOf(setup.sql, claim.claimId),
        restarted?.dueAt,
        restarted?.dueAt,
        restarted?.dueAt,
      ]);
      setup.mainUp = true;
      await setup.train.resume();
      expect(setup.composed).toEqual([[{ claimId: claim.claimId, generation: 1, commit: LATER }]]);
    });
  });
});

describe("a re-ready of a commit that already landed", () => {
  it("answers a repeat of the landed episode as done, with no refusal or new work", async () => {
    await withHandoff(async (setup) => {
      const { claim } = await readyUnderFirst(setup);
      await setup.train.resume();
      const attempt = setup.started[0];
      if (attempt === undefined) throw new Error("no check was started");
      const recorded = await setup.train.recordCheck({
        attemptId: attempt.attemptId,
        candidate: attempt.candidate,
        result: "pass",
        logDigest: null,
        finishedAt: attempt.createdAt,
      });
      expect(recorded.ok).toBe(true);
      await setup.train.resume();
      expect(setup.published).toHaveLength(1);
      expect(setup.entries()).toEqual([{ commit: WORK, state: "landed", next: null }]);
      expect(setup.train.batches(8).map((batch) => batch.state)).toEqual(["landed"]);

      // The holder's first answer was lost; it repeats the same ready before any decision changes.
      const head = setup.log.head();
      const wakes = setup.wakes.length;
      const wake = readWake(setup.sql);
      expect(
        await setup.claims.ready(agent(1), claim.claimId, { generation: 1, commit: WORK }),
      ).toMatchObject({ ok: true, value: { repeated: true, claim: { state: "merged" } } });
      expect(claimState(setup.sql, claim.claimId)).toBe("merged");
      expect(setup.entries()).toEqual([{ commit: WORK, state: "landed", next: null }]);
      expect(setup.train.batches(8)).toHaveLength(1);
      expect(setup.log.head()).toBe(head);
      expect(setup.wakes.length).toBe(wakes);
      expect(readWake(setup.sql)).toEqual(wake);
    });
  });

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

/** Runs the train until the pin readied last has a started check, passes that check and lands it. */
async function landNext(setup: Setup): Promise<void> {
  await setup.train.resume();
  const attempt = setup.started.at(-1);
  if (attempt === undefined) throw new Error("no check was started");
  const recorded = await setup.train.recordCheck({
    attemptId: attempt.attemptId,
    candidate: attempt.candidate,
    result: "pass",
    logDigest: null,
    finishedAt: attempt.createdAt,
  });
  expect(recorded.ok).toBe(true);
  await setup.train.resume();
}

function eventTypes(setup: Setup): string[] {
  return setup.log.replay(0, 256).events.map((event) => event.type);
}

describe("a landed claim", () => {
  it("is merged with the landed commit, so its agent's next work gets a second issue", async () => {
    await withHandoff(async (setup) => {
      const { claim } = await readyUnderFirst(setup);
      await landNext(setup);
      const landedAt = setup.main();
      expect(landedAt).not.toBe(MAIN);
      expect(claimState(setup.sql, claim.claimId)).toBe("merged");
      expect(await setup.claims.activeClaim(agent(1))).toEqual(ok(null));
      expect(await setup.claims.lastClosed(agent(1))).toEqual(
        ok({
          claimId: claim.claimId,
          issueId: claim.issueId,
          generation: 1,
          reason: { kind: "merged", commit: landedAt },
          closedAt: setup.now(),
        }),
      );

      const second = await setup.open();
      expect(second.claimId).not.toBe(claim.claimId);
      expect(second.issueId).not.toBe(claim.issueId);
      expect(second.state).toBe("working");
      expect(claimState(setup.sql, claim.claimId)).toBe("merged");
    });
  });

  it("appends claim.merged in the landing, after main moved", async () => {
    await withHandoff(async (setup) => {
      const { claim } = await readyUnderFirst(setup);
      await landNext(setup);
      const events = setup.log.replay(0, 256).events;
      const moved = events.findIndex((event) => event.type === "train.main");
      const merged = events.findIndex((event) => event.type === "claim.merged");
      expect(moved).toBeGreaterThan(-1);
      expect(merged).toBeGreaterThan(moved);
      expect(events[merged]).toMatchObject({
        actor: { kind: "system" },
        data: { claimId: claim.claimId, generation: 1, commit: setup.main() },
      });
    });
  });

  it("stays ready, with no claim.merged, when it is readied again while its batch publishes", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);
      const update = setup.holdUpdate();
      const landing = landNext(setup);
      await update.reached;

      // Main has moved. A superseding version reopens the claim and the holder readies the same
      // commit under it, so the batch's result belongs to the old episode.
      await setup.decide(claim.claimId, first.decisionId);
      await setup.ackAll();
      const again = await setup.claims.ready(agent(1), claim.claimId, {
        generation: 1,
        commit: WORK,
      });
      expect(again).toMatchObject({ ok: true, value: { repeated: false } });
      update.release();
      await landing;

      const published = setup.main();
      expect(published).not.toBe(MAIN);
      const types = eventTypes(setup);
      expect(types).toContain("train.main");
      expect(types).not.toContain("claim.merged");
      expect(claimState(setup.sql, claim.claimId)).toBe("ready");
      expect(await setup.claims.lastClosed(agent(1))).toEqual(ok(null));
      // The renewed pin went back to the train, to be checked under the new version.
      expect(setup.entries()).toEqual([{ commit: WORK, state: "batched", next: null }]);
      expect(setup.started.length).toBeGreaterThan(1);
    });
  });

  it("refuses a push and a new ready, while a fetch of its fork still works", async () => {
    await withHandoff(async (setup) => {
      const { claim } = await readyUnderFirst(setup);
      await landNext(setup);
      const head = setup.log.head();
      const target = { kind: "fork", claimId: claim.claimId } as const;

      expect(
        await setup.claims.authorizeGit({ principal: agent(1), target, operation: "push" }),
      ).toMatchObject({ ok: false, code: "claim_closed" });
      expect(
        await setup.claims.authorizeGit({ principal: agent(1), target, operation: "fetch" }),
      ).toMatchObject({ ok: true, value: { scope: "read" } });
      await setup.push(claim.claimId, LATER);
      expect(
        await setup.claims.ready(agent(1), claim.claimId, { generation: 1, commit: LATER }),
      ).toMatchObject({ ok: false, code: "claim_closed" });
      expect(claimState(setup.sql, claim.claimId)).toBe("merged");
      expect(setup.log.head()).toBe(head);
    });
  });

  it("reopens on a superseding decision while its holder is free, and lands the rework", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);
      await landNext(setup);
      const landedAt = setup.main();

      const second = await setup.decide(claim.claimId, first.decisionId);
      const events = setup.log.replay(0, 256).events;
      const reopened = events.at(-1);
      expect(reopened).toMatchObject({
        type: "claim.reopened",
        data: {
          claimId: claim.claimId,
          generation: 1,
          reason: "decision_superseded",
          decisions: [second],
        },
      });
      // In the transaction that recorded the version and queued it to the holder.
      expect(events.at(-2)?.type).toBe("inbox.queued");
      expect(claimState(setup.sql, claim.claimId)).toBe("working");
      expect(await setup.claims.activeClaim(agent(1))).toMatchObject({
        ok: true,
        value: { claimId: claim.claimId, state: "working", readyCommit: null },
      });

      // The holder adapts: it pushes, acknowledges the new version and readies the rework.
      expect(
        await setup.claims.authorizeGit({
          principal: agent(1),
          target: { kind: "fork", claimId: claim.claimId },
          operation: "push",
        }),
      ).toMatchObject({ ok: true, value: { scope: "write", fence: { generation: 1 } } });
      await setup.push(claim.claimId, LATER);
      await setup.ackAll();
      expect(
        await setup.claims.ready(agent(1), claim.claimId, { generation: 1, commit: LATER }),
      ).toMatchObject({ ok: true, value: { repeated: false, claim: { state: "ready" } } });

      await landNext(setup);
      expect(setup.main()).not.toBe(landedAt);
      expect(setup.published).toHaveLength(2);
      expect(claimState(setup.sql, claim.claimId)).toBe("merged");
      expect(await setup.claims.lastClosed(agent(1))).toMatchObject({
        ok: true,
        value: { claimId: claim.claimId, reason: { kind: "merged", commit: setup.main() } },
      });
    });
  });

  it("waits for rework while its holder works another claim, and reopens once that one lands", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);
      await landNext(setup);
      const busy = await setup.open(LATER);

      const second = await setup.decide(claim.claimId, first.decisionId);
      expect(eventTypes(setup)).not.toContain("claim.reopened");
      expect(claimState(setup.sql, claim.claimId)).toBe("merged");
      expect(await setup.claims.activeClaim(agent(1))).toMatchObject({
        ok: true,
        value: { claimId: busy.claimId },
      });
      // The version reached the holder's inbox for the merged claim all the same.
      const pending = await setup.inbox.pending(agent(1), 16);
      expect(pending).toMatchObject({
        ok: true,
        value: { items: [{ claimId: claim.claimId, decision: { version: 2 } }] },
      });

      // The holder lands its other claim; that landing reopens the merged one.
      await setup.ackAll();
      expect(
        (await setup.claims.ready(agent(1), busy.claimId, { generation: 1, commit: LATER })).ok,
      ).toBe(true);
      await landNext(setup);
      expect(claimState(setup.sql, busy.claimId)).toBe("merged");
      expect(claimState(setup.sql, claim.claimId)).toBe("working");
      expect(setup.log.replay(0, 256).events.at(-1)).toMatchObject({
        type: "claim.reopened",
        data: {
          claimId: claim.claimId,
          generation: 1,
          reason: "decision_superseded",
          decisions: [second],
        },
      });
      expect(await setup.claims.lastClosed(agent(1))).toMatchObject({
        ok: true,
        value: { claimId: busy.claimId, reason: { kind: "merged" } },
      });
      expect(await setup.claims.work(agent(1))).toMatchObject({
        ok: true,
        value: { claim: { claimId: claim.claimId, state: "working" }, resumed: true },
      });
    });
  });

  it("waits for rework while its holder works another claim, and reopens once that one expires", async () => {
    await withHandoff(async (setup) => {
      const { claim, first } = await readyUnderFirst(setup);
      await landNext(setup);
      const busy = await setup.open();
      await setup.decide(claim.claimId, first.decisionId);
      expect(claimState(setup.sql, claim.claimId)).toBe("merged");

      setup.advance(CLAIM_LEASE_MS);
      // The holder's status read records the lapse, and the merged claim reopens in that transaction.
      expect(await setup.claims.activeClaim(agent(1))).toMatchObject({
        ok: true,
        value: { claimId: claim.claimId, state: "working" },
      });
      expect(claimState(setup.sql, busy.claimId)).toBe("expired");
      expect(eventTypes(setup).slice(-2)).toEqual(["claim.expired", "claim.reopened"]);
      expect(await setup.claims.lastClosed(agent(1))).toMatchObject({
        ok: true,
        value: { claimId: busy.claimId, reason: { kind: "expired" } },
      });
    });
  });

  it("stays merged when a decision another claim depends on changes", async () => {
    await withHandoff(async (setup) => {
      const { claim } = await readyUnderFirst(setup);
      await landNext(setup);
      const other = await setup.open();
      const question = await setup.decide(other.claimId);
      await setup.decide(other.claimId, question.decisionId);
      expect(claimState(setup.sql, claim.claimId)).toBe("merged");
      expect(claimState(setup.sql, other.claimId)).toBe("working");
      expect(eventTypes(setup)).not.toContain("claim.reopened");
    });
  });
});

/** The commit the loser of a conflict pushes after its claim is reopened. */
const REDO = "6".repeat(40);

/** Both claims' entries, ordered by commit. */
function sortedEntries(setup: Setup) {
  return setup.entries().toSorted((left, right) => left.commit.localeCompare(right.commit));
}

/** Claims for agents 1 and 2, readied with `WORK` and `LATER`, that conflict in one batch. */
async function losePair(setup: Setup): Promise<{ winner: ClaimPin; loser: ClaimPin }> {
  const first = await setup.openFor(1, WORK);
  const second = await setup.openFor(2, LATER);
  for (const [n, claim, commit] of [
    [1, first, WORK],
    [2, second, LATER],
  ] as const) {
    const ready = await setup.claims.ready(agent(n), claim.claimId, { generation: 1, commit });
    expect(ready).toMatchObject({ ok: true, value: { repeated: false } });
  }
  const winner: ClaimPin = { claimId: first.claimId, generation: 1, commit: WORK };
  const loser: ClaimPin = { claimId: second.claimId, generation: 1, commit: LATER };
  setup.conflict = [winner, loser];
  await setup.train.resume();
  expect(setup.composed).toEqual([[winner, loser]]);
  expect(sortedEntries(setup)).toEqual([
    { commit: WORK, state: "parked", next: null },
    { commit: LATER, state: "parked", next: null },
  ]);
  return { winner, loser };
}

function reopenLost(setup: Setup, pin: ClaimPin, episode: number): boolean {
  return setup.log.transaction((tx) => setup.claims.reopen(tx, pin, episode, "lost_conflict"))
    .value;
}

function episodeOf(setup: Setup, pin: ClaimPin): number {
  const ready = setup.claims.readyPin(pin.claimId);
  if (ready === null) throw new Error("the claim is not ready");
  return ready.episode;
}

/** Passes the latest check attempt and drives the train to publish it. */
async function pass(setup: Setup): Promise<CheckAttempt> {
  const attempt = setup.started.at(-1);
  if (attempt === undefined) throw new Error("no check was started");
  const recorded = await setup.train.recordCheck({
    attemptId: attempt.attemptId,
    candidate: attempt.candidate,
    result: "pass",
    logDigest: null,
    finishedAt: attempt.createdAt,
  });
  expect(recorded.ok).toBe(true);
  await setup.train.resume();
  return attempt;
}

describe("a ready claim reopened for rework", () => {
  it("lets the loser of a conflict push, ready again and land", async () => {
    await withHandoff(async (setup) => {
      const { winner, loser } = await losePair(setup);
      const episode = episodeOf(setup, loser);
      const pushTo = {
        principal: agent(2),
        target: { kind: "fork", claimId: loser.claimId },
        operation: "push",
      } as const;
      expect(await setup.claims.authorizeGit(pushTo)).toMatchObject({
        ok: false,
        code: "after_ready",
      });

      expect(reopenLost(setup, loser, episode)).toBe(true);

      expect(setup.log.replay(0, 64).events.at(-1)).toMatchObject({
        actor: { kind: "system", id: "sys_claims" },
        type: "claim.reopened",
        data: { claimId: loser.claimId, generation: 1, reason: "lost_conflict", decisions: [] },
      });
      expect(claimState(setup.sql, loser.claimId)).toBe("working");
      expect(setup.claims.readyPin(loser.claimId)).toBeNull();
      // The reopened claim is a lease again, and a push is fenced to the new episode.
      expect(leaseOf(setup.sql, loser.claimId)).toBe(setup.now() + CLAIM_LEASE_MS);
      expect(await setup.claims.authorizeGit(pushTo)).toMatchObject({
        ok: true,
        value: {
          scope: "write",
          fence: { claimId: loser.claimId, generation: 1, episode: episode + 1 },
        },
      });

      await setup.push(loser.claimId, REDO);
      const ready = await setup.claims.ready(agent(2), loser.claimId, {
        generation: 1,
        commit: REDO,
      });
      expect(ready).toMatchObject({ ok: true, value: { repeated: false } });
      // The parked entry is queued again for the new episode, and the redo returns the winner to
      // the queue with it, so the two are merged together again without the owner's answer.
      expect(sortedEntries(setup)).toEqual([
        { commit: WORK, state: "queued", next: null },
        { commit: REDO, state: "queued", next: null },
      ]);

      await setup.train.resume();
      const redone: ClaimPin = { ...loser, commit: REDO };
      expect(setup.composed.at(-1)).toEqual(expect.arrayContaining([winner, redone]));
      expect(setup.composed.at(-1)).toHaveLength(2);
      const attempt = await pass(setup);

      expect(setup.published).toHaveLength(1);
      expect(setup.main()).toBe(attempt.candidate);
      expect(sortedEntries(setup)).toEqual([
        { commit: WORK, state: "landed", next: null },
        { commit: REDO, state: "landed", next: null },
      ]);
    });
  });

  it("refuses the owner's answer to the pair's question once the loser redid its change", async () => {
    await withHandoff(async (setup) => {
      const { winner, loser } = await losePair(setup);
      const [conflict] = setup.train.conflicts(1);
      const decisionId = conflict?.decisionId;
      if (decisionId == null) throw new Error("no question was asked");
      expect(reopenLost(setup, loser, episodeOf(setup, loser))).toBe(true);
      await setup.push(loser.claimId, REDO);
      const ready = await setup.claims.ready(agent(2), loser.claimId, {
        generation: 1,
        commit: REDO,
      });
      expect(ready.ok).toBe(true);
      expect(setup.train.conflicts(1)).toMatchObject([{ state: "redone", decisionId }]);
      const before = setup.log.head();

      const recorded = await setup.decisions.record({
        kind: "human",
        userId: OWNER,
        repoId: REPO,
        grantId: crypto.randomUUID(),
        action: {
          kind: "decision.record",
          decisionId,
          option: "keep_first",
          expectedVersion: null,
        },
      });

      // The question was withdrawn with the redo: nothing is recorded or delivered, and neither
      // claim's pin is superseded by it.
      expect(recorded).toMatchObject({ ok: false, code: "action_stale" });
      expect(setup.log.head()).toBe(before);
      expect(setup.decisions.currentVersions(winner.claimId)).toEqual([]);
      expect(setup.decisions.currentVersions(loser.claimId)).toEqual([]);
      expect(claimState(setup.sql, winner.claimId)).toBe("ready");

      // The pair is merged together again and lands.
      await setup.train.resume();
      const redone: ClaimPin = { ...loser, commit: REDO };
      expect(setup.composed.at(-1)).toEqual(expect.arrayContaining([winner, redone]));
      await pass(setup);
      expect(sortedEntries(setup)).toEqual([
        { commit: WORK, state: "landed", next: null },
        { commit: REDO, state: "landed", next: null },
      ]);
    });
  });

  it("never lands a batch formed for the episode the reopening ended", async () => {
    await withHandoff(async (setup) => {
      const claim = await setup.open(WORK);
      const request = { generation: 1, commit: WORK };
      expect((await setup.claims.ready(agent(1), claim.claimId, request)).ok).toBe(true);
      await setup.train.resume();
      const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: WORK };
      expect(setup.entries()).toEqual([{ commit: WORK, state: "batched", next: null }]);

      // The pin is reopened while its check runs; the check then passes.
      expect(reopenLost(setup, pin, episodeOf(setup, pin))).toBe(true);
      await pass(setup);

      expect(setup.published).toEqual([]);
      expect(setup.main()).toBe(MAIN);
      expect(claimState(setup.sql, claim.claimId)).toBe("working");

      // The reworked commit is scheduled and lands under its own episode.
      await setup.push(claim.claimId, LATER);
      const again = { generation: 1, commit: LATER };
      expect(await setup.claims.ready(agent(1), claim.claimId, again)).toMatchObject({
        ok: true,
        value: { repeated: false },
      });
      await setup.train.resume();
      expect(setup.composed.at(-1)).toEqual([{ ...pin, commit: LATER }]);
      const attempt = await pass(setup);
      expect(setup.main()).toBe(attempt.candidate);
      expect(setup.entries()).toEqual([{ commit: LATER, state: "landed", next: null }]);
    });
  });

  it("never lands a same-commit re-ready on the check of the episode the reopening ended", async () => {
    await withHandoff(async (setup) => {
      const claim = await setup.open(WORK);
      const request = { generation: 1, commit: WORK };
      expect((await setup.claims.ready(agent(1), claim.claimId, request)).ok).toBe(true);
      await setup.train.resume();
      const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: WORK };
      const episode = episodeOf(setup, pin);
      expect(setup.started).toHaveLength(1);
      expect(setup.started[0]?.pins).toEqual([{ ...pin, episode }]);

      // Reopened while its check runs, then readied again with the same commit: a new episode.
      expect(reopenLost(setup, pin, episode)).toBe(true);
      expect(await setup.claims.ready(agent(1), claim.claimId, request)).toMatchObject({
        ok: true,
        value: { repeated: false },
      });
      const renewed = episodeOf(setup, pin);
      expect(renewed).toBeGreaterThan(episode);

      // The old episode's check passes: nothing is authorized or published on it, and the new
      // episode gets a check of its own.
      const old = await pass(setup);
      const types = () => setup.log.replay(0, 128).events.map((event) => event.type);
      expect(types()).not.toContain("train.intent");
      expect(setup.published).toEqual([]);
      expect(setup.main()).toBe(MAIN);
      expect(setup.train.attemptOutcome(old.attemptId)).not.toBeNull();
      expect(setup.started).toHaveLength(2);
      expect(setup.started[1]?.pins).toEqual([{ ...pin, episode: renewed }]);
      expect(setup.entries()).toEqual([{ commit: WORK, state: "batched", next: null }]);

      // Only that check lands it.
      const attempt = await pass(setup);
      expect(attempt.attemptId).not.toBe(old.attemptId);
      expect(types().filter((type) => type === "train.intent")).toHaveLength(1);
      expect(setup.published).toHaveLength(1);
      expect(setup.main()).toBe(attempt.candidate);
      expect(setup.entries()).toEqual([{ commit: WORK, state: "landed", next: null }]);
    });
  });

  it("checks again a batch formed before its pins carried episodes, publishing nothing on it", async () => {
    await withHandoff(async (setup) => {
      const claim = await setup.open(WORK);
      const request = { generation: 1, commit: WORK };
      expect((await setup.claims.ready(agent(1), claim.claimId, request)).ok).toBe(true);
      await setup.train.resume();
      const pin: ClaimPin = { claimId: claim.claimId, generation: 1, commit: WORK };
      const episode = episodeOf(setup, pin);
      // The batch row as it was stored before pins carried their episode.
      setup.sql.exec("UPDATE train_batches SET pins = json_remove(pins, '$[0].episode')");
      const old = setup.started.at(-1);
      if (old === undefined) throw new Error("no check was started");
      expect(setup.train.attemptOutcome(old.attemptId)?.attempt.pins).toEqual([
        { ...pin, episode: 0 },
      ]);

      await pass(setup);
      expect(setup.published).toEqual([]);
      expect(setup.main()).toBe(MAIN);
      expect(setup.started).toHaveLength(2);
      expect(setup.started[1]?.pins).toEqual([{ ...pin, episode }]);

      const attempt = await pass(setup);
      expect(setup.main()).toBe(attempt.candidate);
      expect(setup.entries()).toEqual([{ commit: WORK, state: "landed", next: null }]);
    });
  });

  it("reopens only the exact pin and episode it is given, once", async () => {
    await withHandoff(async (setup) => {
      const { loser } = await losePair(setup);
      const episode = episodeOf(setup, loser);
      const count = () => setup.log.replay(0, 64).events.length;
      const before = count();

      expect(reopenLost(setup, loser, episode - 1)).toBe(false);
      expect(reopenLost(setup, loser, episode + 1)).toBe(false);
      expect(reopenLost(setup, { ...loser, commit: REDO }, episode)).toBe(false);
      expect(reopenLost(setup, { ...loser, generation: 2 }, episode)).toBe(false);
      expect(reopenLost(setup, { ...loser, claimId: "clm_unknown0001" }, episode)).toBe(false);
      expect(count()).toBe(before);
      expect(claimState(setup.sql, loser.claimId)).toBe("ready");

      expect(reopenLost(setup, loser, episode)).toBe(true);
      // A second reopening of the same episode, as from a repeated train pass, changes nothing.
      expect(reopenLost(setup, loser, episode)).toBe(false);
      const types = setup.log.replay(0, 64).events.map((event) => event.type);
      expect(types.filter((type) => type === "claim.reopened")).toHaveLength(1);
      expect(claimState(setup.sql, loser.claimId)).toBe("working");
    });
  });

  it("rolls back while the claim's decision versions are unknown", async () => {
    await withHandoff(async (setup) => {
      const { loser } = await losePair(setup);
      const episode = episodeOf(setup, loser);
      const before = setup.log.replay(0, 64).events.length;
      setup.versionsKnown = false;
      expect(() => reopenLost(setup, loser, episode)).toThrow(UnavailableError);
      setup.versionsKnown = true;

      expect(setup.log.replay(0, 64).events).toHaveLength(before);
      expect(claimState(setup.sql, loser.claimId)).toBe("ready");
      expect(setup.claims.readyPin(loser.claimId)).toMatchObject({ pin: loser, episode });
      // A Repo without the claims module refuses the same way.
      expect(() =>
        setup.log.transaction((tx) =>
          unavailableClaims.reopen(tx, loser, episode, "lost_conflict"),
        ),
      ).toThrow(UnavailableError);
    });
  });
});
