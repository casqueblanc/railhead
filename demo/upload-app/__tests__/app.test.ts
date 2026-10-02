import { SELF, env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { firstDifference, generateBody } from "../acceptance/bodies";
import type { UploadStore } from "../src/store";

const ORIGIN = "https://upload.invalid";
const LIMIT = 10_000_000;

function upload(body: BodyInit | null, headers: HeadersInit = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/uploads`, { method: "POST", body, headers });
}

/** A body of `size` bytes sent as a stream, so the request carries no Content-Length. */
function streamed(size: number): ReadableStream<Uint8Array> {
  const bytes = generateBody(size, 3);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + 700_000));
      offset += 700_000;
    },
  });
}

/** Rows written by uploads that were never committed. Every refused upload must leave none. */
async function orphanedRows(): Promise<number> {
  let orphaned = 0;
  for (const id of await listDurableObjectIds(env.UPLOADS)) {
    orphaned += await runInDurableObject(env.UPLOADS.get(id), (instance: UploadStore, state) =>
      instance.describe() === null
        ? state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM parts").one().n
        : 0,
    );
  }
  return orphaned;
}

/** Runs `body` against a fresh store's instance, without an RPC hop. */
function withStore(body: (store: UploadStore) => void): Promise<void> {
  const stub = env.UPLOADS.get(env.UPLOADS.idFromName(crypto.randomUUID()));
  return runInDurableObject(stub, (instance: UploadStore) => body(instance));
}

describe("upload page", () => {
  it("serves the form", async () => {
    const response = await SELF.fetch(`${ORIGIN}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain('<form id="upload">');
  });
});

describe("POST /api/uploads", () => {
  it("accepts exactly 10 MB and returns its size and digest", async () => {
    const body = generateBody(LIMIT, 4);
    const response = await upload(body);
    expect(response.status).toBe(201);
    const result = await response.json<{ id: string; size: number; sha256: string }>();
    expect(result.size).toBe(LIMIT);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
    expect(result.sha256).toBe(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""));

    const stored = await SELF.fetch(`${ORIGIN}/api/uploads/${result.id}`);
    expect(stored.headers.get("x-upload-sha256")).toBe(result.sha256);
    // Compared by index: a deep equality over 10^7 elements exhausts the test isolate's heap.
    expect(firstDifference(new Uint8Array(await stored.arrayBuffer()), body)).toBe(-1);
  });

  it("refuses one byte over 10 MB declared in Content-Length", async () => {
    const response = await upload(generateBody(LIMIT + 1, 5));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Files above 10 MB are not accepted" });
  });

  it("refuses a streamed body once it passes 10 MB and deletes the rows it wrote", async () => {
    const response = await upload(streamed(LIMIT + 1));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Files above 10 MB are not accepted" });
    expect(await orphanedRows()).toBe(0);
  });

  it("stores a streamed body of exactly 10 MB", async () => {
    const response = await upload(streamed(LIMIT));
    expect(response.status).toBe(201);
    expect((await response.json<{ size: number }>()).size).toBe(LIMIT);
  });

  it("refuses an empty file without storing anything", async () => {
    const before = (await listDurableObjectIds(env.UPLOADS)).length;
    const response = await upload(new Uint8Array());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "The file is empty." });
    expect((await listDurableObjectIds(env.UPLOADS)).length).toBe(before);
  });

  it("refuses other methods", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/uploads`);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("GET /api/uploads/:id", () => {
  it("returns 404 for an id that was never stored", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/uploads/${crypto.randomUUID()}`);
    expect(response.status).toBe(404);
  });

  it("returns 400 for a malformed id", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/uploads/not-an-id`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid upload id." });
  });

  it("returns 404 for unknown paths", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/uploads/chunked/x/parts/0`)).status).toBe(404);
  });
});

describe("UploadStore", () => {
  it("commits contiguous parts and reads them back", async () => {
    await withStore((store) => {
      store.putPart(0, new Uint8Array([1, 2]));
      store.putPart(1, new Uint8Array([3]));
      expect(store.commit(3, "digest")).toEqual({ size: 3, sha256: "digest", parts: 2 });
      expect([...store.readPart(1)]).toEqual([3]);
    });
  });

  it("refuses to commit with a missing part or a wrong size", async () => {
    await withStore((store) => {
      store.putPart(0, new Uint8Array([1]));
      store.putPart(2, new Uint8Array([3]));
      expect(() => store.commit(2, "digest")).toThrow("do not add up");
    });
    await withStore((store) => {
      store.putPart(0, new Uint8Array([1]));
      expect(() => store.commit(2, "digest")).toThrow("do not add up");
      expect(store.describe()).toBeNull();
    });
  });

  it("refuses writes after commit and reads before it", async () => {
    await withStore((store) => {
      store.putPart(0, new Uint8Array([1]));
      expect(() => store.readPart(0)).toThrow("not committed");
      store.commit(1, "digest");
      expect(() => store.putPart(1, new Uint8Array([2]))).toThrow("already committed");
    });
  });

  it("refuses empty, oversized and negative parts", async () => {
    await withStore((store) => {
      expect(() => store.putPart(0, new Uint8Array())).toThrow(RangeError);
      expect(() => store.putPart(0, new Uint8Array(1024 * 1024 + 1))).toThrow(RangeError);
      expect(() => store.putPart(-1, new Uint8Array([1]))).toThrow(RangeError);
    });
  });

  it("discards committed and uncommitted rows", async () => {
    await withStore((store) => {
      store.putPart(0, new Uint8Array([1]));
      store.commit(1, "digest");
      store.discard();
      expect(store.describe()).toBeNull();
      store.putPart(0, new Uint8Array([2]));
      store.discard();
      expect(() => store.commit(1, "digest")).toThrow("do not add up");
    });
  });
});
