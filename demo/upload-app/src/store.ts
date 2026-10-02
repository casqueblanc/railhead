import { DurableObject } from "cloudflare:workers";
import { PART_BYTES } from "./limits";

/** What a committed upload holds: its size, its SHA-256 in hex and how many rows store it. */
export interface StoredUpload {
  size: number;
  sha256: string;
  parts: number;
}

/**
 * One uploaded file, stored as rows of at most {@link PART_BYTES} bytes. A file is readable only
 * after `commit` confirms every row arrived; until then it can be written or discarded.
 */
export class UploadStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS parts (idx INTEGER PRIMARY KEY, data BLOB NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS upload (id INTEGER PRIMARY KEY CHECK (id = 0), size INTEGER NOT NULL, sha256 TEXT NOT NULL, parts INTEGER NOT NULL)",
    );
  }

  /** Stores row `index`. Fails once the upload is committed or when the row is too large. */
  putPart(index: number, bytes: Uint8Array): void {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new RangeError("Part index must be a non-negative integer.");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > PART_BYTES) {
      throw new RangeError(`A part holds between 1 and ${PART_BYTES} bytes.`);
    }
    if (this.describe() !== null) throw new Error("The upload is already committed.");
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO parts (idx, data) VALUES (?, ?)",
      index,
      bytes,
    );
  }

  /**
   * Makes the upload readable after checking that rows 0..n-1 are present, with no gap, and
   * together hold exactly `size` bytes.
   */
  commit(size: number, sha256: string): StoredUpload {
    if (this.describe() !== null) throw new Error("The upload is already committed.");
    const row = this.ctx.storage.sql
      .exec<{ count: number; maxIdx: number | null; total: number | null }>(
        "SELECT COUNT(*) AS count, MAX(idx) AS maxIdx, SUM(LENGTH(data)) AS total FROM parts",
      )
      .one();
    const parts = row.count;
    if (parts === 0 || row.maxIdx !== parts - 1 || row.total !== size) {
      throw new Error("The stored parts do not add up to the declared upload.");
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO upload (id, size, sha256, parts) VALUES (0, ?, ?, ?)",
      size,
      sha256,
      parts,
    );
    return { size, sha256, parts };
  }

  /** Deletes everything stored for this upload, committed or not. */
  discard(): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM parts");
      this.ctx.storage.sql.exec("DELETE FROM upload");
    });
  }

  /** The committed upload, or `null` when nothing has been committed. */
  describe(): StoredUpload | null {
    const rows = this.ctx.storage.sql
      .exec<{ size: number; sha256: string; parts: number }>(
        "SELECT size, sha256, parts FROM upload WHERE id = 0",
      )
      .toArray();
    const row = rows[0];
    return row === undefined ? null : { size: row.size, sha256: row.sha256, parts: row.parts };
  }

  /** Row `index` of a committed upload. */
  readPart(index: number): Uint8Array {
    const upload = this.describe();
    if (upload === null) throw new Error("The upload is not committed.");
    const rows = this.ctx.storage.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM parts WHERE idx = ?", index)
      .toArray();
    const row = rows[0];
    if (row === undefined) throw new RangeError(`Part ${index} does not exist.`);
    return new Uint8Array(row.data);
  }
}
