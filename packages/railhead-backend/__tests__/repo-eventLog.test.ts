import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  MAX_ISSUE_BODY_LENGTH,
  type Actor,
  type EventPayload,
} from "@railhead/shared/events";
import {
  EVENT_LOG_OWNER,
  EventLog,
  EventLogError,
  MAX_REPLAY_EVENTS,
  MAX_REPLAY_JSON_LENGTH,
  type EventLogErrorCode,
} from "../src/repo/eventLog";
import { migrate, type RepoStorage } from "../src/repo/storage";

const REPO = "rep_demo01";
const NOW = 1_790_000_000_000;
const HUMAN: Actor = { kind: "human", id: "usr_lemarier" };
const AGENT: Actor = { kind: "agent", id: "agt_atlas01" };
const STATE_TABLE = "CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY) STRICT";

function issue(n: number, body = ""): EventPayload {
  return {
    type: "issue.filed",
    data: { issueId: `iss_issue${String(n).padStart(4, "0")}`, title: `Issue ${n}`, body },
  };
}

function freshStub(): DurableObjectStub {
  return env.REPO.getByName(crypto.randomUUID());
}

/** Runs `body` against the storage of `stub`, or of a Durable Object no other test touches. */
function withStorage<R>(
  body: (storage: RepoStorage) => R,
  stub: DurableObjectStub = freshStub(),
): Promise<R> {
  return runInDurableObject(stub, (_instance, state) => body(state.storage));
}

function openLog(storage: RepoStorage, clock: () => number = () => NOW): EventLog {
  return EventLog.open(storage, REPO, clock);
}

function rowCount(storage: RepoStorage, table: string): number {
  return storage.sql.exec(`SELECT * FROM ${table}`).toArray().length;
}

function refusal(code: EventLogErrorCode): unknown {
  return expect.objectContaining({ name: "EventLogError", code });
}

function seqs(page: { events: { seq: number }[] }): number[] {
  return page.events.map((event) => event.seq);
}

describe("EventLog transactions", () => {
  it("commits state and events together, numbering events from 1", async () => {
    await withStorage((storage) => {
      storage.sql.exec(STATE_TABLE);
      const log = openLog(storage);

      const committed = log.transaction((tx) => {
        tx.sql.exec("INSERT INTO claims (id) VALUES ('clm_42abcd')");
        tx.append(HUMAN, issue(1));
        tx.append(HUMAN, issue(2));
        return "opened";
      });

      expect(committed.value).toBe("opened");
      expect(committed.events).toEqual([
        { v: EVENT_SCHEMA_VERSION, seq: 1, at: NOW, repo: REPO, actor: HUMAN, ...issue(1) },
        { v: EVENT_SCHEMA_VERSION, seq: 2, at: NOW, repo: REPO, actor: HUMAN, ...issue(2) },
      ]);
      expect(rowCount(storage, "claims")).toBe(1);
      expect(log.head()).toBe(2);
      expect(log.replay(0, 10)).toEqual({ events: committed.events, head: 2 });
    });
  });

  it("continues numbering across transactions", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      log.transaction((tx) => tx.append(HUMAN, issue(1)));

      const second = log.transaction((tx) => tx.append(HUMAN, issue(2)));

      expect(second.value.seq).toBe(2);
      expect(second.events.map((event) => event.seq)).toEqual([2]);
    });
  });

  it("commits a state-only transaction with no events", async () => {
    await withStorage((storage) => {
      storage.sql.exec(STATE_TABLE);
      const log = openLog(storage);

      const committed = log.transaction((tx) => {
        tx.sql.exec("INSERT INTO claims (id) VALUES ('clm_42abcd')");
        return 1;
      });

      expect(committed).toEqual({ value: 1, events: [] });
      expect(rowCount(storage, "claims")).toBe(1);
      expect(log.head()).toBe(0);
    });
  });

  it("rolls back state and events when the body throws, and emits nothing", async () => {
    await withStorage((storage) => {
      storage.sql.exec(STATE_TABLE);
      const log = openLog(storage);
      log.transaction((tx) => tx.append(HUMAN, issue(1)));
      const failure = new Error("ownership check failed");
      let committed: unknown = "not returned";

      expect(() => {
        committed = log.transaction((tx) => {
          tx.sql.exec("INSERT INTO claims (id) VALUES ('clm_42abcd')");
          tx.append(HUMAN, issue(2));
          tx.append(HUMAN, issue(3));
          throw failure;
        });
      }).toThrow(failure);

      expect(committed).toBe("not returned");
      expect(rowCount(storage, "claims")).toBe(0);
      expect(log.head()).toBe(1);
      expect(rowCount(storage, "events")).toBe(1);
      // The rolled-back numbers are reused, so the log stays gapless.
      expect(log.transaction((tx) => tx.append(HUMAN, issue(4))).value.seq).toBe(2);
      expect(seqs(log.replay(0, 10))).toEqual([1, 2]);
    });
  });

  it("refuses an event an agent may not record and rolls back the whole transaction", async () => {
    await withStorage((storage) => {
      storage.sql.exec(STATE_TABLE);
      const log = openLog(storage);

      expect(() =>
        log.transaction((tx) => {
          tx.sql.exec("INSERT INTO claims (id) VALUES ('clm_42abcd')");
          tx.append(AGENT, issue(1));
          tx.append(AGENT, { type: "agent.revoked", data: { agentId: "agt_other01" } });
        }),
      ).toThrow(refusal("invalid_event"));

      expect(rowCount(storage, "claims")).toBe(0);
      expect(log.head()).toBe(0);
    });
  });

  it("refuses an actor with a malformed identifier", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      const actors: Actor[] = [
        { kind: "agent", id: "usr_lemarier" },
        { kind: "human", id: "usr_" },
        { kind: "system", id: "sys_Train" },
      ];

      for (const actor of actors) {
        expect(() => log.transaction((tx) => tx.append(actor, issue(1)))).toThrow(
          refusal("invalid_event"),
        );
      }
      expect(log.head()).toBe(0);
    });
  });

  it("refuses an event whose payload breaks an invariant", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      const tooLong = issue(1, "x".repeat(MAX_ISSUE_BODY_LENGTH + 1));

      expect(() => log.transaction((tx) => tx.append(HUMAN, tooLong))).toThrow(
        refusal("invalid_event"),
      );
      expect(() =>
        log.transaction((tx) =>
          tx.append(HUMAN, { type: "agent.confirmed", data: { agentId: "clm_42abcd" } }),
        ),
      ).toThrow(/agentId is not a agent identifier/);
      expect(log.head()).toBe(0);
    });
  });

  it("refuses an event when the clock does not give a positive time", async () => {
    await withStorage((storage) => {
      const log = openLog(storage, () => 0);

      expect(() => log.transaction((tx) => tx.append(HUMAN, issue(1)))).toThrow(
        refusal("invalid_event"),
      );
      expect(log.head()).toBe(0);
    });
  });

  it("refuses a transaction started inside another", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);

      expect(() =>
        log.transaction((tx) => {
          tx.append(HUMAN, issue(1));
          log.transaction((inner) => inner.append(HUMAN, issue(2)));
        }),
      ).toThrow(refusal("invalid_transaction"));

      expect(log.head()).toBe(0);
      expect(log.transaction((tx) => tx.append(HUMAN, issue(3))).value.seq).toBe(1);
    });
  });

  it("refuses an append through a transaction that has ended", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      const { value: leaked } = log.transaction((tx) => ({ tx }));

      expect(() => leaked.tx.append(HUMAN, issue(1))).toThrow(refusal("invalid_transaction"));
      expect(log.head()).toBe(0);
    });
  });

  it("takes the head from events stored before the head row existed", async () => {
    await withStorage((storage) => {
      // The first schema step alone, as a log written before the head row was added.
      migrate(storage, EVENT_LOG_OWNER, [
        "CREATE TABLE events (seq INTEGER PRIMARY KEY CHECK (seq > 0), body TEXT NOT NULL) STRICT",
      ]);
      const stored = {
        v: EVENT_SCHEMA_VERSION,
        seq: 1,
        at: NOW,
        repo: REPO,
        actor: HUMAN,
        ...issue(1),
      };
      storage.sql.exec("INSERT INTO events (seq, body) VALUES (1, ?)", JSON.stringify(stored));

      const log = openLog(storage);

      expect(log.head()).toBe(1);
      expect(log.transaction((tx) => tx.append(HUMAN, issue(2))).value.seq).toBe(2);
      expect(log.replay(0, 10)).toMatchObject({ events: [stored, { seq: 2 }], head: 2 });
    });
  });

  it("refuses to open a log for an invalid repository id", async () => {
    await withStorage((storage) => {
      for (const repo of ["", "rep_x", "agt_demo01", "rep_demo-01"]) {
        expect(() => EventLog.open(storage, repo)).toThrow(EventLogError);
        expect(() => EventLog.open(storage, repo)).toThrow(refusal("invalid_repo"));
      }
    });
  });
});

describe("EventLog replay", () => {
  it("has no gaps after the Durable Object restarts", async () => {
    const stub = freshStub();
    await withStorage((storage) => {
      const log = openLog(storage);
      log.transaction((tx) => [1, 2, 3].map((n) => tx.append(HUMAN, issue(n))));
    }, stub);

    await evictDurableObject(stub);

    const page = await withStorage((storage) => {
      const log = openLog(storage);
      expect(log.head()).toBe(3);
      log.transaction((tx) => [4, 5].map((n) => tx.append(HUMAN, issue(n))));
      return log.replay(0, 10);
    }, stub);
    expect(seqs(page)).toEqual([1, 2, 3, 4, 5]);
    expect(page.events.map((event) => event.type === "issue.filed" && event.data.title)).toEqual([
      "Issue 1",
      "Issue 2",
      "Issue 3",
      "Issue 4",
      "Issue 5",
    ]);
    expect(page.head).toBe(5);
  });

  it("pages from a cursor until it reaches the head", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      log.transaction((tx) => [1, 2, 3, 4, 5].map((n) => tx.append(HUMAN, issue(n))));

      expect(log.replay(0, 2)).toMatchObject({ head: 5 });
      expect(seqs(log.replay(0, 2))).toEqual([1, 2]);
      expect(seqs(log.replay(2, 2))).toEqual([3, 4]);
      expect(seqs(log.replay(4, 2))).toEqual([5]);
      expect(log.replay(5, 2)).toEqual({ events: [], head: 5 });
    });
  });

  it("returns an empty page for an empty log", async () => {
    await withStorage((storage) => {
      expect(openLog(storage).replay(0, MAX_REPLAY_EVENTS)).toEqual({ events: [], head: 0 });
    });
  });

  it("serves exactly the largest page and refuses a larger one", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      const count = MAX_REPLAY_EVENTS + 1;
      log.transaction((tx) =>
        Array.from({ length: count }, (_, i) => tx.append(HUMAN, issue(i + 1))),
      );

      expect(log.replay(0, MAX_REPLAY_EVENTS).events).toHaveLength(MAX_REPLAY_EVENTS);
      expect(() => log.replay(0, MAX_REPLAY_EVENTS + 1)).toThrow(refusal("replay_too_large"));
    });
  });

  it("stops a page before it exceeds the JSON budget, then continues", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      const body = "x".repeat(MAX_ISSUE_BODY_LENGTH);
      const count = Math.ceil(MAX_REPLAY_JSON_LENGTH / MAX_ISSUE_BODY_LENGTH) + 2;
      log.transaction((tx) =>
        Array.from({ length: count }, (_, i) => tx.append(HUMAN, issue(i + 1, body))),
      );

      const first = log.replay(0, MAX_REPLAY_EVENTS);
      const json = first.events.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
      expect(first.events.length).toBeGreaterThan(0);
      expect(first.events.length).toBeLessThan(count);
      expect(json).toBeLessThanOrEqual(MAX_REPLAY_JSON_LENGTH);

      const rest = log.replay(first.events.length, MAX_REPLAY_EVENTS);
      expect([...seqs(first), ...seqs(rest)]).toEqual(
        Array.from({ length: count }, (_, i) => i + 1),
      );
    });
  });

  it("refuses a malformed cursor or limit", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      log.transaction((tx) => tx.append(HUMAN, issue(1)));

      for (const [after, limit] of [
        [-1, 10],
        [0.5, 10],
        [Number.NaN, 10],
        [Number.MAX_SAFE_INTEGER + 1, 10],
        [0, 0],
        [0, 1.5],
        [0, -1],
      ] as const) {
        expect(() => log.replay(after, limit)).toThrow(refusal("invalid_request"));
      }
    });
  });

  it("refuses a cursor past the head", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      log.transaction((tx) => tx.append(HUMAN, issue(1)));

      expect(() => log.replay(2, 10)).toThrow(refusal("cursor_ahead"));
    });
  });

  it("refuses to serve a log with a missing event", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      log.transaction((tx) => [1, 2, 3].map((n) => tx.append(HUMAN, issue(n))));
      storage.sql.exec("DELETE FROM events WHERE seq = 2");

      expect(seqs(log.replay(2, 10))).toEqual([3]);
      expect(() => log.replay(0, 10)).toThrow(refusal("corrupt_log"));
      expect(() => log.replay(1, 10)).toThrow(refusal("corrupt_log"));
    });
  });

  it("refuses to serve a log whose last event is missing", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      log.transaction((tx) => [1, 2, 3].map((n) => tx.append(HUMAN, issue(n))));
      storage.sql.exec("DELETE FROM events WHERE seq = 3");

      expect(log.head()).toBe(3);
      expect(seqs(log.replay(0, 2))).toEqual([1, 2]);
      expect(() => log.replay(0, 10)).toThrow(refusal("corrupt_log"));
      expect(() => log.replay(2, 10)).toThrow(refusal("corrupt_log"));
    });
  });

  it("does not serve a stored row past the committed head", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      log.transaction((tx) => tx.append(HUMAN, issue(1)));
      storage.sql.exec("UPDATE event_head SET seq = 0 WHERE id = 1");

      expect(log.replay(0, 10)).toEqual({ events: [], head: 0 });
    });
  });

  it("refuses to read a log that has lost its head", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      storage.sql.exec("DELETE FROM event_head");

      expect(() => log.head()).toThrow(refusal("corrupt_log"));
      expect(() => log.transaction((tx) => tx.append(HUMAN, issue(1)))).toThrow(
        refusal("corrupt_log"),
      );
      expect(rowCount(storage, "events")).toBe(0);
    });
  });

  it("refuses to serve an event with an unsupported schema version", async () => {
    await withStorage((storage) => {
      const log = openLog(storage);
      log.transaction((tx) => tx.append(HUMAN, issue(1)));
      storage.sql.exec("UPDATE events SET body = json_set(body, '$.v', 2) WHERE seq = 1");

      expect(() => log.replay(0, 10)).toThrow(refusal("corrupt_log"));
    });
  });
});
