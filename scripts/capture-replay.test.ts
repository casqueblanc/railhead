import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = join(import.meta.dirname, "capture-replay.mjs");

const run = (args: readonly string[]) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
};

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-replay-"));
  return { out: join(dir, "run.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
};

/** A port nothing listens on: bound, then closed, so a connection is refused at once. */
const closedPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
};

test("prints usage and writes nothing without its arguments", () => {
  const { out, done } = scratch();
  try {
    const result = run(["--origin", "https://railhead.example", "--out", out]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage: node scripts\/capture-replay\.mjs/);
    assert.equal(existsSync(out), false);
  } finally {
    done();
  }
});

for (const [label, args, message] of [
  ["an unknown option", ["--token", "x"], /Unknown option '--token'/],
  ["a non-http origin", ["--origin", "file:///etc", "--repo", "demo/app"], /http or https URL/],
  ["an origin that is not a URL", ["--origin", "railhead", "--repo", "demo/app"], /not a URL/],
  [
    "a repository without an organisation",
    ["--origin", "https://h", "--repo", "app"],
    /<org>\/<name>/,
  ],
  ["a repository with a path", ["--origin", "https://h", "--repo", "demo/app/x"], /<org>\/<name>/],
  ["an upper-case name", ["--origin", "https://h", "--repo", "Demo/app"], /<org>\/<name>/],
] as const) {
  test(`refuses ${label}`, () => {
    const { out, done } = scratch();
    try {
      const result = run([...args, "--out", out]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assert.equal(existsSync(out), false);
    } finally {
      done();
    }
  });
}

test("fails without writing when the backend cannot be reached, and never echoes credentials", async () => {
  const { out, done } = scratch();
  try {
    const port = await closedPort();
    const result = run([
      "--origin",
      `http://capture:s3cr3t-pass@127.0.0.1:${port}/ignored?token=s3cr3t-query`,
      "--repo",
      "demo/upload-app",
      "--out",
      out,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^capture-replay: the session with the backend failed/);
    assert.doesNotMatch(result.stderr + result.stdout, /s3cr3t/);
    assert.equal(existsSync(out), false);
  } finally {
    done();
  }
});

test("refuses an existing output file before contacting the backend", async () => {
  const { out, done } = scratch();
  try {
    writeFileSync(out, "kept");
    const port = await closedPort();
    const result = run([
      "--origin",
      `http://127.0.0.1:${port}`,
      "--repo",
      "demo/app",
      "--out",
      out,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already exists; choose a new file/);
    assert.equal(readFileSync(out, "utf8"), "kept");
  } finally {
    done();
  }
});
