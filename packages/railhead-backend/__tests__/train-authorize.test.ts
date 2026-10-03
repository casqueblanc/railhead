import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_LIST_LENGTH, type ClaimId, type DecisionRef } from "@railhead/shared/events";
import type { EpisodePin, ReadyPin } from "../src/contracts/claims";
import type { ReadyGate } from "../src/contracts/inbox";
import type { PortErrorCode, PortResult } from "../src/contracts/result";
import type {
  AuthorizationPort,
  CheckAttempt,
  CheckReport,
  MergeIntentRecord,
} from "../src/contracts/train";
import { unavailableAuthorization, UnavailableError } from "../src/contracts/unavailable";
import { EventLog } from "../src/repo/eventLog";
import type { RepoStorage } from "../src/repo/storage";
import {
  createAuthorization,
  TRAIN_ACTOR,
  type AuthorizationReaders,
} from "../src/train/authorize";

const REPO = "rep_demo01";
const NOW = 1_790_000_000_000;
const ATTEMPT = "chk_attempt01";
const INTENT = "int_intent01";
const MAIN = "a".repeat(40);
const CANDIDATE = "c".repeat(40);
const DEC_FORMAT: DecisionRef = { decisionId: "dec_format01", version: 1 };
const DEC_LIMIT: DecisionRef = { decisionId: "dec_limit001", version: 2 };

function claimId(n: number): ClaimId {
  return `clm_claim${String(n).padStart(3, "0")}`;
}

function pin(n: number, generation = 1): EpisodePin {
  return { claimId: claimId(n), generation, commit: String(n % 10).repeat(40), episode: 1 };
}

function attempt(overrides: Partial<CheckAttempt> = {}): CheckAttempt {
  return {
    attemptId: ATTEMPT,
    expectedMain: MAIN,
    candidate: CANDIDATE,
    pins: [pin(1), pin(2, 3)],
    definition: { name: "upload", source: MAIN, digest: "d".repeat(64), acceptance: null },
    decisions: [DEC_FORMAT, DEC_LIMIT],
    createdAt: NOW - 60_000,
    ...overrides,
  };
}

function report(overrides: Partial<CheckReport> = {}): CheckReport {
  return {
    attemptId: ATTEMPT,
    candidate: CANDIDATE,
    result: "pass",
    logDigest: "e".repeat(64),
    finishedAt: NOW - 1_000,
    ...overrides,
  };
}

/** Current state the readers answer from, which a test changes to model a concurrent write. */
class World implements AuthorizationReaders {
  attempts = new Map<string, { attempt: CheckAttempt; report: CheckReport | null }>();
  generations = new Map<ClaimId, number>();
  versions = new Map<ClaimId, DecisionRef[] | null>();
  ready = new Map<ClaimId, ReadyPin | null>();
  /** Each claim's ready gate; a claim missing here is clear. */
  gates = new Map<ClaimId, ReadyGate | null>();
  calls = 0;

  constructor(stored: CheckAttempt = attempt(), stored_report: CheckReport | null = report()) {
    this.attempts.set(stored.attemptId, { attempt: stored, report: stored_report });
    for (const stored_pin of stored.pins) {
      this.generations.set(stored_pin.claimId, stored_pin.generation);
      this.versions.set(stored_pin.claimId, stored.decisions);
      this.ready.set(stored_pin.claimId, {
        pin: stored_pin,
        episode: stored_pin.episode,
        decisions: stored.decisions,
      });
    }
  }

  /** Records `refs` as the claim's current versions and its pin as marked ready under them. */
  decide(id: ClaimId, refs: DecisionRef[]): void {
    this.versions.set(id, refs);
    const ready = this.ready.get(id);
    if (ready !== undefined && ready !== null) this.ready.set(id, { ...ready, decisions: refs });
  }

  attemptOutcome(attemptId: string): { attempt: CheckAttempt; report: CheckReport | null } | null {
    this.calls += 1;
    return this.attempts.get(attemptId) ?? null;
  }

  currentGeneration(id: ClaimId): number | null {
    this.calls += 1;
    return this.generations.get(id) ?? null;
  }

  currentVersions(id: ClaimId): DecisionRef[] | null {
    this.calls += 1;
    return this.versions.get(id) ?? null;
  }

  readyPin(id: ClaimId): ReadyPin | null {
    this.calls += 1;
    return this.ready.get(id) ?? null;
  }

  readyGateNow(id: ClaimId, generation: number): ReadyGate | null {
    this.calls += 1;
    if (this.generations.get(id) !== generation) return null;
    const gate = this.gates.get(id);
    return gate === undefined ? { kind: "clear" } : gate;
  }
}

/** Readers of a missing module: they know nothing. */
const UNKNOWN: AuthorizationReaders = {
  attemptOutcome: () => null,
  currentGeneration: () => null,
  currentVersions: () => null,
  readyPin: () => null,
  readyGateNow: () => null,
};

function freshStub(): DurableObjectStub {
  return env.REPO.getByName(crypto.randomUUID());
}

interface Harness {
  storage: RepoStorage;
  log: EventLog;
  authorize: (attemptId?: string) => Promise<PortResult<MergeIntentRecord>>;
  intent: (intentId: string) => Promise<PortResult<MergeIntentRecord>>;
  port: AuthorizationPort;
}

function harness(storage: RepoStorage, readers: AuthorizationReaders): Harness {
  const log = EventLog.open(storage, REPO, () => NOW);
  const port = createAuthorization({ storage, log, clock: () => NOW }, readers, () => INTENT);
  return {
    storage,
    log,
    authorize: (attemptId = ATTEMPT) => port.authorize(attemptId),
    intent: (intentId) => port.intent(intentId),
    port,
  };
}

function withHarness<R>(
  readers: AuthorizationReaders,
  body: (h: Harness) => Promise<R>,
  stub: DurableObjectStub = freshStub(),
): Promise<R> {
  return runInDurableObject(stub, (_instance, state) => body(harness(state.storage, readers)));
}

function intentRows(storage: RepoStorage): number {
  return storage.sql.exec("SELECT intent_id FROM merge_intents").toArray().length;
}

/** Authorizes once and asserts it was refused with `code`, writing neither a record nor an event. */
async function expectRefused(h: Harness, code: PortErrorCode, attemptId = ATTEMPT): Promise<void> {
  const result = await h.authorize(attemptId);
  expect(result).toEqual({ ok: false, code, message: expect.any(String) });
  expect(intentRows(h.storage)).toBe(0);
  expect(h.log.head()).toBe(0);
}

function expectedRecord(): MergeIntentRecord {
  return {
    intentId: INTENT,
    expectedMain: MAIN,
    candidate: CANDIDATE,
    pins: [pin(1), pin(2, 3)],
    decisions: [DEC_FORMAT, DEC_LIMIT],
    checkAttemptId: ATTEMPT,
    status: "authorized",
    attempts: 0,
    main: null,
    authorizedAt: NOW,
    updatedAt: NOW,
  };
}

describe("authorize", () => {
  it("records the intent and its train.intent event in one transaction", async () => {
    await withHarness(new World(), async (h) => {
      const result = await h.authorize();

      expect(result).toEqual({ ok: true, value: expectedRecord() });
      expect(intentRows(h.storage)).toBe(1);
      expect(await h.intent(INTENT)).toEqual({ ok: true, value: expectedRecord() });
      // The public event carries every field of the record the board needs, each equal to the
      // record's; generations, status and attempts stay in the durable record.
      expect(h.log.replay(0, 10).events).toEqual([
        {
          v: 1,
          seq: 1,
          at: NOW,
          repo: REPO,
          actor: TRAIN_ACTOR,
          type: "train.intent",
          data: {
            intentId: INTENT,
            expectedMain: MAIN,
            candidate: CANDIDATE,
            claims: [claimId(1), claimId(2)],
            decisions: [DEC_FORMAT, DEC_LIMIT],
            checkRunId: ATTEMPT,
          },
        },
      ]);
    });
  });

  it("returns the same intent to a caller that lost the first response", async () => {
    const world = new World();
    await withHarness(world, async (h) => {
      const first = await h.authorize();
      // State moves after authorization; the repeat neither re-checks nor writes a second intent.
      world.generations.set(claimId(1), 2);
      world.versions.set(claimId(1), [{ ...DEC_FORMAT, version: 2 }, DEC_LIMIT]);
      const calls = world.calls;
      const second = await h.authorize();

      expect(second).toEqual(first);
      expect(world.calls).toBe(calls);
      expect(intentRows(h.storage)).toBe(1);
      expect(h.log.head()).toBe(1);
    });
  });

  it("keeps the intent across eviction, and a new instance returns the same one", async () => {
    const stub = freshStub();
    const world = new World();
    await withHarness(world, (h) => h.authorize(), stub);
    await evictDurableObject(stub);

    await withHarness(
      UNKNOWN,
      async (h) => {
        expect(await h.intent(INTENT)).toEqual({ ok: true, value: expectedRecord() });
        expect(await h.authorize()).toEqual({ ok: true, value: expectedRecord() });
        expect(h.log.head()).toBe(1);
      },
      stub,
    );
  });

  it("stores only the decisions current now, dropping one no longer required", async () => {
    const world = new World();
    world.decide(claimId(1), [DEC_FORMAT]);
    world.decide(claimId(2), []);
    await withHarness(world, async (h) => {
      const result = await h.authorize();
      expect(result).toEqual({ ok: true, value: { ...expectedRecord(), decisions: [DEC_FORMAT] } });
    });
  });
});

describe("authorize refuses invalid input", () => {
  it("refuses an id that is not a check run identifier", async () => {
    const world = new World();
    await withHarness(world, async (h) => {
      await expectRefused(h, "invalid_request", "int_attempt01");
      await expectRefused(h, "invalid_request", "chk_");
      expect(world.calls).toBe(0);
    });
  });

  it("refuses an unknown attempt", async () => {
    await withHarness(new World(), (h) => expectRefused(h, "not_found", "chk_unknown01"));
  });

  it("refuses to read an intent by a malformed or unknown id", async () => {
    await withHarness(new World(), async (h) => {
      expect(await h.intent("chk_attempt01")).toMatchObject({ ok: false, code: "invalid_request" });
      expect(await h.intent("int_unknown01")).toMatchObject({ ok: false, code: "not_found" });
    });
  });
});

describe("authorize requires the exact passing check", () => {
  it.each([
    ["no report yet", null],
    ["a failing report", report({ result: "fail" })],
    ["a report that could not run", report({ result: "error" })],
  ])("refuses %s", async (_name, stored) => {
    await withHarness(new World(attempt(), stored), (h) => expectRefused(h, "check_not_passed"));
  });

  it.each([
    ["names another attempt", report({ attemptId: "chk_attempt02" })],
    ["ran on another candidate", report({ candidate: "b".repeat(40) })],
    ["finished before the attempt existed", report({ finishedAt: NOW - 60_001 })],
  ])("refuses a forged runner result that %s", async (_name, forged) => {
    await withHarness(new World(attempt(), forged), (h) => expectRefused(h, "check_mismatch"));
  });

  it("refuses a stored attempt filed under another id", async () => {
    const world = new World();
    const stored = world.attempts.get(ATTEMPT);
    if (stored === undefined) throw new Error("fixture missing");
    world.attempts.set("chk_attempt02", stored);
    await withHarness(world, (h) => expectRefused(h, "check_mismatch", "chk_attempt02"));
  });
});

describe("authorize fences claim generations", () => {
  it("refuses when a claim changed owner after the check was scheduled", async () => {
    const world = new World();
    world.generations.set(claimId(2), 4);
    await withHarness(world, (h) => expectRefused(h, "stale_generation"));
  });

  it("refuses when a claim is unknown or closed", async () => {
    const world = new World();
    world.generations.delete(claimId(1));
    await withHarness(world, (h) => expectRefused(h, "stale_generation"));
  });

  it("authorizes a refused attempt once state is current again, then only once", async () => {
    const world = new World();
    world.generations.set(claimId(2), 4);
    await withHarness(world, async (h) => {
      await expectRefused(h, "stale_generation");
      world.generations.set(claimId(2), 3);
      expect(await h.authorize()).toEqual({ ok: true, value: expectedRecord() });
      expect(h.log.head()).toBe(1);
    });
  });
});

describe("authorize fences ready pins", () => {
  it("refuses when a claim is no longer ready, or is ready with another commit", async () => {
    const world = new World();
    world.ready.set(claimId(1), null);
    await withHarness(world, async (h) => {
      await expectRefused(h, "decision_superseded");
      world.ready.set(claimId(1), {
        pin: { ...pin(1), commit: "9".repeat(40) },
        episode: 2,
        decisions: [],
      });
      await expectRefused(h, "decision_superseded");
    });
  });

  it("refuses a claim readied again with the same commit in a later episode", async () => {
    const world = new World();
    // Reopened and readied again with the checked commit: only the episode moved.
    world.ready.set(claimId(1), { pin: pin(1), episode: 2, decisions: [DEC_FORMAT, DEC_LIMIT] });
    await withHarness(world, (h) => expectRefused(h, "decision_superseded"));
  });

  it("reads an intent stored before pins carried episodes as episode 0, which no claim is in", async () => {
    await withHarness(new World(), async (h) => {
      expect((await h.authorize()).ok).toBe(true);
      h.storage.sql.exec(
        "UPDATE merge_intents SET pins = json_remove(pins, '$[0].episode', '$[1].episode')",
      );
      const read = await h.intent(INTENT);
      expect(read.ok && read.value.pins).toEqual([
        { ...pin(1), episode: 0 },
        { ...pin(2, 3), episode: 0 },
      ]);

      h.storage.sql.exec("UPDATE merge_intents SET pins = json_set(pins, '$[0].episode', 'one')");
      await expect(h.intent(INTENT)).rejects.toThrow("unreadable pins");
    });
  });

  it("refuses a pin marked ready under an older version than the check was scheduled under", async () => {
    // The attempt and the current state name version 2, but the pin was marked ready under 1.
    const current = { ...DEC_FORMAT, version: 2 };
    const world = new World(attempt({ decisions: [current, DEC_LIMIT] }));
    world.ready.set(claimId(1), { pin: pin(1), episode: 1, decisions: [DEC_FORMAT, DEC_LIMIT] });
    await withHarness(world, (h) => expectRefused(h, "decision_superseded"));
  });
});

describe("authorize fences the inbox gate", () => {
  it("refuses while an item affecting a claim is unacknowledged, then authorizes once it clears", async () => {
    // A rework obligation under the version the check ran under: no pin or version moved.
    const world = new World();
    world.gates.set(claimId(2), { kind: "blocked", items: [7] });
    await withHarness(world, async (h) => {
      await expectRefused(h, "unacked_decision");
      world.gates.delete(claimId(2));
      expect(await h.authorize()).toEqual({ ok: true, value: expectedRecord() });
    });
  });

  it("refuses as unavailable while the inbox cannot answer", async () => {
    const world = new World();
    world.gates.set(claimId(1), null);
    await withHarness(world, (h) => expectRefused(h, "unavailable"));
  });
});

describe("authorize fences decisions", () => {
  it("refuses when a decision got a new version during the check", async () => {
    const world = new World();
    world.versions.set(claimId(2), [DEC_FORMAT, { ...DEC_LIMIT, version: 3 }]);
    await withHarness(world, (h) => expectRefused(h, "decision_superseded"));
  });

  it("refuses when a decision the check was not scheduled under became required", async () => {
    const world = new World();
    world.versions.set(claimId(1), [
      DEC_FORMAT,
      DEC_LIMIT,
      { decisionId: "dec_newrule1", version: 1 },
    ]);
    await withHarness(world, (h) => expectRefused(h, "decision_superseded"));
  });

  it("refuses when two claims report different versions of one decision", async () => {
    const stored = attempt({ decisions: [DEC_FORMAT] });
    const world = new World(stored);
    world.versions.set(claimId(2), [{ ...DEC_FORMAT, version: 2 }]);
    await withHarness(world, (h) => expectRefused(h, "decision_superseded"));
  });

  it("refuses an acceptance check whose decision is no longer current", async () => {
    const stored = attempt({
      definition: {
        name: "upload-acceptance",
        source: MAIN,
        digest: "d".repeat(64),
        acceptance: { decision: { ...DEC_LIMIT, version: 1 }, option: "reject" },
      },
    });
    await withHarness(new World(stored), (h) => expectRefused(h, "decision_superseded"));
  });

  it("authorizes an acceptance check that proves the current version", async () => {
    const stored = attempt({
      definition: {
        name: "upload-acceptance",
        source: MAIN,
        digest: "d".repeat(64),
        acceptance: { decision: DEC_LIMIT, option: "reject" },
      },
    });
    await withHarness(new World(stored), async (h) => {
      expect(await h.authorize()).toMatchObject({ ok: true, value: { status: "authorized" } });
    });
  });

  it("refuses when a claim's decision requirements are unknown", async () => {
    const world = new World();
    world.versions.set(claimId(1), null);
    await withHarness(world, (h) => expectRefused(h, "decision_superseded"));
  });
});

describe("authorize bounds the pins", () => {
  it("refuses an attempt with no pins", async () => {
    await withHarness(new World(attempt({ pins: [] })), (h) => expectRefused(h, "check_mismatch"));
  });

  it("refuses an attempt that composes one claim twice", async () => {
    const stored = attempt({ pins: [pin(1), pin(1)] });
    await withHarness(new World(stored), (h) => expectRefused(h, "check_mismatch"));
  });

  it(`authorizes ${MAX_LIST_LENGTH} pins and refuses one more`, async () => {
    const full = Array.from({ length: MAX_LIST_LENGTH }, (_, n) => pin(n + 1));
    await withHarness(new World(attempt({ pins: full })), async (h) => {
      const result = await h.authorize();
      expect(result.ok && result.value.pins).toEqual(full);
    });
    const over = Array.from({ length: MAX_LIST_LENGTH + 1 }, (_, n) => pin(n + 1));
    await withHarness(new World(attempt({ pins: over })), (h) =>
      expectRefused(h, "check_mismatch"),
    );
  });
});

describe("authorize fails closed", () => {
  it("never authorizes while the modules it reads are missing", async () => {
    await withHarness(UNKNOWN, (h) => expectRefused(h, "not_found"));
  });

  it("writes nothing when a reader throws", async () => {
    const world = new World();
    world.currentVersions = () => {
      throw new Error("decisions storage failed");
    };
    await withHarness(world, async (h) => {
      await expect(h.authorize()).rejects.toThrow("decisions storage failed");
      expect(intentRows(h.storage)).toBe(0);
      expect(h.log.head()).toBe(0);
    });
  });

  it("rolls the record back when its event is refused", async () => {
    const stored = attempt({ expectedMain: "not-a-commit" });
    await withHarness(new World(stored), async (h) => {
      await expect(h.authorize()).rejects.toMatchObject({ code: "invalid_event" });
      expect(intentRows(h.storage)).toBe(0);
      expect(h.log.head()).toBe(0);
    });
  });
});

describe("record and recordWrite", () => {
  const OTHER = "b".repeat(40);

  it("reads the stored intent, and nothing for an unknown or malformed id", async () => {
    await withHarness(new World(), async (h) => {
      expect(h.port.record(INTENT)).toBeNull();
      await h.authorize();
      expect(h.port.record(INTENT)).toEqual(expectedRecord());
      expect(h.port.record("int_unknown01")).toBeNull();
      expect(h.port.record("chk_attempt01")).toBeNull();
    });
  });

  it("records progress only against the attempts it expects, then settles once", async () => {
    await withHarness(new World(), async (h) => {
      await h.authorize();
      const counted = h.port.recordWrite(INTENT, 0, {
        status: "authorized",
        attempts: 1,
        main: null,
      });
      expect(counted).toEqual({ ...expectedRecord(), attempts: 1 });
      // A writer that read the intent before that attempt was counted changes nothing.
      expect(
        h.port.recordWrite(INTENT, 0, { status: "updated", attempts: 1, main: CANDIDATE }),
      ).toBeNull();

      const settled = h.port.recordWrite(INTENT, 1, {
        status: "updated",
        attempts: 1,
        main: CANDIDATE,
      });
      expect(settled).toEqual({
        ...expectedRecord(),
        status: "updated",
        attempts: 1,
        main: CANDIDATE,
      });
      // A settled intent never changes again.
      expect(
        h.port.recordWrite(INTENT, 1, { status: "rejected", attempts: 1, main: OTHER }),
      ).toBeNull();
      expect(h.port.record(INTENT)).toEqual(settled);
      // Only authorization appended an event; settling is the writer's event to append.
      expect(h.log.head()).toBe(1);
    });
  });

  it("refuses a change it cannot store faithfully", async () => {
    await withHarness(new World(), async (h) => {
      await h.authorize();
      h.port.recordWrite(INTENT, 0, { status: "authorized", attempts: 2, main: null });
      for (const change of [
        { status: "authorized" as const, attempts: 1, main: null },
        { status: "updated" as const, attempts: 2, main: null },
        { status: "rejected" as const, attempts: 2, main: "not-a-commit" },
        { status: "authorized" as const, attempts: 2.5, main: null },
      ]) {
        expect(h.port.recordWrite(INTENT, 2, change)).toBeNull();
      }
      expect(
        h.port.recordWrite("int_unknown01", 0, { status: "authorized", attempts: 1, main: null }),
      ).toBeNull();
      expect(
        h.port.recordWrite("bad", 0, { status: "authorized", attempts: 1, main: null }),
      ).toBeNull();
      expect(h.port.record(INTENT)).toEqual({ ...expectedRecord(), attempts: 2 });
    });
  });

  it("rolls its caller's transaction back while the module is missing", async () => {
    await withHarness(new World(), async (h) => {
      expect(unavailableAuthorization.record(INTENT)).toBeNull();
      expect(() =>
        h.log.transaction((tx) => {
          tx.append(TRAIN_ACTOR, {
            type: "train.main",
            data: { intentId: INTENT, outcome: "updated", main: CANDIDATE },
          });
          return unavailableAuthorization.recordWrite(INTENT, 0, {
            status: "updated",
            attempts: 1,
            main: CANDIDATE,
          });
        }),
      ).toThrow(UnavailableError);
      expect(h.log.head()).toBe(0);
    });
  });
});
