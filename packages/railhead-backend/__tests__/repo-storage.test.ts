import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  StorageError,
  atomically,
  migrate,
  EarliestAlarm,
  type RepoStorage,
} from "../src/repo/storage";

/** Runs `body` against the storage of a Durable Object no other test touches. */
function withStorage<R>(body: (storage: RepoStorage) => R): Promise<R> {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, (_instance, state) => body(state.storage));
}

function tableNames(storage: RepoStorage): string[] {
  return storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .toArray()
    .map((row) => row.name);
}

function versionOf(storage: RepoStorage, owner: string): number | null {
  const rows = storage.sql
    .exec<{ version: number }>("SELECT version FROM railhead_migrations WHERE owner = ?", owner)
    .toArray();
  return rows[0]?.version ?? null;
}

const CREATE_A = "CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT";
const CREATE_B = "CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT";

describe("migrate", () => {
  it("applies each step once and records the version", async () => {
    await withStorage((storage) => {
      expect(migrate(storage, "feature", [CREATE_A])).toBe(1);
      expect(migrate(storage, "feature", [CREATE_A])).toBe(0);
      expect(migrate(storage, "feature", [CREATE_A, CREATE_B])).toBe(1);

      expect(tableNames(storage)).toEqual(["a", "b", "railhead_migrations"]);
      expect(versionOf(storage, "feature")).toBe(2);
    });
  });

  it("keeps each owner's version separate", async () => {
    await withStorage((storage) => {
      migrate(storage, "first", [CREATE_A]);

      expect(migrate(storage, "second", [CREATE_B])).toBe(1);
      expect(versionOf(storage, "first")).toBe(1);
      expect(versionOf(storage, "second")).toBe(1);
    });
  });

  it("does nothing for an owner with no steps", async () => {
    await withStorage((storage) => {
      expect(migrate(storage, "feature", [])).toBe(0);
      expect(versionOf(storage, "feature")).toBeNull();
    });
  });

  it("refuses an owner name that is not a lowercase identifier, writing nothing", async () => {
    await withStorage((storage) => {
      for (const owner of ["", "Feature", "1st", "a-b", "x".repeat(65)]) {
        expect(() => migrate(storage, owner, [CREATE_A])).toThrow(
          expect.objectContaining({ code: "invalid_owner" }),
        );
      }
      expect(tableNames(storage)).toEqual([]);
    });
  });

  it("refuses to run older code against a newer schema", async () => {
    await withStorage((storage) => {
      migrate(storage, "feature", [CREATE_A, CREATE_B]);

      expect(() => migrate(storage, "feature", [CREATE_A])).toThrow(StorageError);
      expect(() => migrate(storage, "feature", [CREATE_A])).toThrow(
        expect.objectContaining({ code: "schema_ahead" }),
      );
      expect(versionOf(storage, "feature")).toBe(2);
    });
  });

  it("rolls back every step when one fails, then succeeds once fixed", async () => {
    await withStorage((storage) => {
      expect(() =>
        migrate(storage, "feature", [CREATE_A, "INSERT INTO missing VALUES (1)"]),
      ).toThrow(/no such table/);
      expect(tableNames(storage)).toEqual([]);

      expect(migrate(storage, "feature", [CREATE_A, CREATE_B])).toBe(2);
      expect(tableNames(storage)).toEqual(["a", "b", "railhead_migrations"]);
    });
  });
});

describe("atomically", () => {
  it("commits the writes of a body that returns", async () => {
    await withStorage((storage) => {
      storage.sql.exec(CREATE_A);

      const value = atomically(storage, () => {
        storage.sql.exec("INSERT INTO a (id) VALUES (1), (2)");
        return "done";
      });

      expect(value).toBe("done");
      expect(storage.sql.exec("SELECT id FROM a ORDER BY id").toArray()).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
    });
  });

  it("rolls back every write of a body that throws and rethrows its error", async () => {
    await withStorage((storage) => {
      storage.sql.exec(CREATE_A);
      const failure = new Error("state check failed");

      expect(() =>
        atomically(storage, () => {
          storage.sql.exec("INSERT INTO a (id) VALUES (1)");
          throw failure;
        }),
      ).toThrow(failure);

      expect(storage.sql.exec("SELECT id FROM a").toArray()).toEqual([]);
    });
  });

  it("does not accept a body that returns a promise", async () => {
    await withStorage((storage) => {
      // @ts-expect-error -- a transaction commits when its body returns, so it cannot await.
      atomically(storage, async () => 1);
    });
  });
});

describe("EarliestAlarm", () => {
  it("sets an unset alarm, keeps an earlier one and moves a later one earlier", async () => {
    const stub = env.REPO.getByName(crypto.randomUUID());
    // An hour away and more, so no alarm fires during the test.
    const base = Date.now() + 3_600_000;
    const alarms = await runInDurableObject(stub, async (_instance, state) => {
      const alarm = new EarliestAlarm(state.storage, () => {});
      await alarm.load();
      const seen: (number | null)[] = [];
      for (const at of [base + 2_000, base + 5_000, base + 2_000, base + 1_000]) {
        alarm.request(at);
        await alarm.settle();
        seen.push(await state.storage.getAlarm());
      }
      await state.storage.deleteAlarm();
      return seen;
    });
    expect(alarms).toEqual([base + 2_000, base + 2_000, base + 2_000, base + 1_000]);
  });

  it("commits an alarm asked for inside a transaction with its rows, before any await", async () => {
    const stub = env.REPO.getByName(crypto.randomUUID());
    const at = Date.now() + 3_600_000;
    await runInDurableObject(stub, async (_instance, state) => {
      const alarm = new EarliestAlarm(state.storage, () => {});
      await alarm.load();
      state.storage.sql.exec("CREATE TABLE owed (id INTEGER PRIMARY KEY)");
      state.storage.transactionSync(() => {
        state.storage.sql.exec("INSERT INTO owed (id) VALUES (1)");
        alarm.request(at);
      });
    });
    // A fresh instance reads only what storage committed.
    await evictDurableObject(stub);
    const after = await runInDurableObject(stub, async (_instance, state) => {
      const committed = {
        rows: state.storage.sql.exec("SELECT id FROM owed").toArray(),
        alarm: await state.storage.getAlarm(),
      };
      await state.storage.deleteAlarm();
      return committed;
    });
    expect(after).toEqual({ rows: [{ id: 1 }], alarm: at });
  });

  it("reads the stored alarm on load, so a later request leaves it in place", async () => {
    const stub = env.REPO.getByName(crypto.randomUUID());
    const base = Date.now() + 3_600_000;
    const stored = await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(base);
      const alarm = new EarliestAlarm(state.storage, () => {});
      await alarm.load();
      alarm.request(base + 1_000);
      await alarm.settle();
      const kept = await state.storage.getAlarm();
      await state.storage.deleteAlarm();
      return kept;
    });
    expect(stored).toBe(base);
  });

  it("resolves each request with whether storage holds an alarm no later than it asked", async () => {
    const stub = env.REPO.getByName(crypto.randomUUID());
    const base = Date.now() + 3_600_000;
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const errors: unknown[] = [];
      const alarm = new EarliestAlarm(state.storage, (error) => errors.push(error));
      await alarm.load();
      const set = await alarm.request(base + 1_000);
      // Covered by the alarm already set: nothing is written, and that write's outcome is answered.
      const covered = await alarm.request(base + 2_000);
      const refused = await alarm.request(0);
      // The refused write left nothing remembered, so the same time is written again, and set.
      const retried = await alarm.request(base);
      const stored = await state.storage.getAlarm();
      await state.storage.deleteAlarm();
      return { set, covered, refused, retried, stored, errors: errors.length };
    });
    expect(result).toEqual({
      set: true,
      covered: true,
      refused: false,
      retried: true,
      stored: base,
      errors: 1,
    });
  });

  it("reports a refused write from settle until the alarm fires, and writes again after it", async () => {
    const stub = env.REPO.getByName(crypto.randomUUID());
    const base = Date.now() + 3_600_000;
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const errors: unknown[] = [];
      const alarm = new EarliestAlarm(state.storage, (error) => errors.push(error));
      await alarm.load();
      alarm.request(0);
      const refused = await alarm.settle().then(
        () => null,
        (error: unknown) => error,
      );
      const unset = await state.storage.getAlarm();
      // The refused time is not remembered, so a later time is written.
      alarm.request(base);
      const stillFailed = await alarm.settle().then(
        () => false,
        () => true,
      );
      alarm.fired();
      alarm.request(base + 1_000);
      await alarm.settle();
      const after = await state.storage.getAlarm();
      await state.storage.deleteAlarm();
      return { errors, refused, unset, stillFailed, after };
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBeInstanceOf(TypeError);
    expect(result.refused).toBeInstanceOf(Error);
    expect(result.unset).toBeNull();
    expect(result.stillFailed).toBe(true);
    // After firing nothing is set, so a later time than the last request is written too.
    expect(result.after).toBe(base + 1_000);
  });
});
