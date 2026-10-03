import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeNewFile, type NewFileIo } from "./write-new-file.ts";

const TEXT = `${JSON.stringify({ events: Array.from({ length: 200 }, (_, seq) => ({ seq })) })}\n`;

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "write-new-file-"));
  return {
    dir,
    out: join(dir, "run.json"),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
};

/** Real file operations, except that writing stores only the first half of the text. */
const halfWriting = (fail: boolean): NewFileIo => ({
  ...fs,
  open: async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode);
    return Object.assign(handle, {
      writeFile: async (data: string) => {
        await handle.write(data.slice(0, data.length / 2));
        if (fail) throw Object.assign(new Error("disk failed"), { code: "EIO" });
      },
    });
  },
});

test("writes the whole text and leaves nothing else in the directory", async () => {
  const { dir, out, done } = scratch();
  try {
    assert.deepEqual(await writeNewFile(out, TEXT), { kind: "written", leftover: null });
    assert.equal(readFileSync(out, "utf8"), TEXT);
    assert.deepEqual(readdirSync(dir), ["run.json"]);
  } finally {
    done();
  }
});

test("a write that fails partway leaves no file, and the same path can be written again", async () => {
  const { dir, out, done } = scratch();
  try {
    assert.deepEqual(await writeNewFile(out, TEXT, halfWriting(true)), {
      kind: "failed",
      code: "EIO",
      leftover: null,
    });
    assert.deepEqual(readdirSync(dir), []);
    assert.deepEqual(await writeNewFile(out, TEXT), { kind: "written", leftover: null });
    assert.equal(readFileSync(out, "utf8"), TEXT);
  } finally {
    done();
  }
});

test("a write that silently stops short is caught by reading it back", async () => {
  const { dir, out, done } = scratch();
  try {
    assert.deepEqual(await writeNewFile(out, TEXT, halfWriting(false)), {
      kind: "failed",
      code: "short_write",
      leftover: null,
    });
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    done();
  }
});

test("never replaces a file that already exists", async () => {
  const { dir, out, done } = scratch();
  try {
    writeFileSync(out, "kept");
    assert.deepEqual(await writeNewFile(out, TEXT), { kind: "exists", leftover: null });
    assert.equal(readFileSync(out, "utf8"), "kept");
    assert.deepEqual(readdirSync(dir), ["run.json"]);
  } finally {
    done();
  }
});

test("fails in a directory that does not exist", async () => {
  const { out, done } = scratch();
  try {
    const missing = join(out, "nested", "run.json");
    assert.deepEqual(await writeNewFile(missing, TEXT), {
      kind: "failed",
      code: "ENOENT",
      leftover: null,
    });
  } finally {
    done();
  }
});

test("names a temporary file it could not remove", async () => {
  const { dir, out, done } = scratch();
  try {
    const result = await writeNewFile(out, TEXT, {
      ...fs,
      rm: async () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
    });
    const leftovers = readdirSync(dir).filter((name) => name !== "run.json");
    assert.equal(leftovers.length, 1);
    assert.match(leftovers[0] ?? "", /^\.run\.json\.[0-9a-f-]{36}\.partial$/);
    assert.deepEqual(result, { kind: "written", leftover: join(dir, leftovers[0] ?? "") });
    assert.equal(readFileSync(out, "utf8"), TEXT);
  } finally {
    done();
  }
});
