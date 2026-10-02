import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { StorageError, atomically, migrate, type RepoStorage } from "../src/repo/storage";

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
