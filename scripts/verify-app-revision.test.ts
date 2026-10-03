import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const script = join(import.meta.dirname, "verify-app-revision.mjs");
const MAIN = "0123456789abcdef0123456789abcdef01234567";
const OLD = "fedcba9876543210fedcba9876543210fedcba98";
const LIMIT = 10_000_000;
const PART = 4_000_000;

/** How the fake app behaves. */
interface FakeApp {
  /** The revision `GET /api/revision` reports, read on each request. */
  revision: () => string;
  /** Accepts files above the limit in one request, as an app with no limit would. */
  noLimit?: boolean;
  /** Serves the chunked routes of option B. */
  chunked?: boolean;
  /** How a file is read back: changed by one byte, cut off after half, or followed by endless bytes. */
  readBack?: "corrupt" | "brokenOff" | "endless";
}

interface Started {
  origin: string;
  /** Every request the fake app received, as `METHOD path`. */
  requests: string[];
  close: () => Promise<void>;
}

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError("expected a Buffer chunk");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/** An in-memory stand-in for the demo app's HTTP interface. */
const startApp = async (app: FakeApp): Promise<Started> => {
  const files = new Map<string, Buffer>();
  const sessions = new Map<string, { parts: Map<number, Buffer> }>();
  const requests: string[] = [];
  let next = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/";
      requests.push(`${request.method ?? ""} ${path}`);
      const body = await readBody(request);
      const part = /^\/api\/uploads\/chunked\/([^/]+)\/parts\/(\d+)$/.exec(path);
      const complete = /^\/api\/uploads\/chunked\/([^/]+)\/complete$/.exec(path);
      const read = /^\/api\/uploads\/([^/]+)$/.exec(path);
      if (path === "/api/revision") return json(response, 200, { revision: app.revision() });
      if (path === "/api/uploads" && request.method === "POST") {
        if (body.byteLength > LIMIT && app.noLimit !== true) {
          return json(response, 413, { error: "Files above 10 MB are not accepted" });
        }
        const id = `up-${(next += 1)}`;
        files.set(id, body);
        return json(response, 201, { id, size: body.byteLength });
      }
      if (app.chunked === true && path === "/api/uploads/chunked" && request.method === "POST") {
        const id = `ch-${(next += 1)}`;
        sessions.set(id, { parts: new Map() });
        return json(response, 201, { id, partSize: PART });
      }
      if (app.chunked === true && part?.[1] !== undefined && request.method === "PUT") {
        sessions.get(part[1])?.parts.set(Number(part[2]), body);
        response.writeHead(204).end();
        return;
      }
      if (app.chunked === true && complete?.[1] !== undefined && request.method === "POST") {
        const session = sessions.get(complete[1]);
        if (session === undefined) return json(response, 404, { error: "Not found." });
        const ordered = [...session.parts.entries()].toSorted(([a], [b]) => a - b);
        const file = Buffer.concat(ordered.map(([, bytes]) => bytes));
        files.set(complete[1], file);
        return json(response, 201, { id: complete[1], size: file.byteLength });
      }
      if (read?.[1] !== undefined && request.method === "GET") {
        const file = files.get(read[1]);
        if (file === undefined) return json(response, 404, { error: "Not found." });
        const served = Buffer.from(file);
        if (app.readBack === "corrupt" && served.byteLength > 0) {
          served[0] = (served[0] ?? 0) ^ 0xff;
        }
        response.writeHead(200, { "content-type": "application/octet-stream" });
        if (app.readBack === "brokenOff") {
          // Headers and half the file reach the verifier before the connection drops.
          response.write(served.subarray(0, served.byteLength / 2), () => {
            setTimeout(() => response.destroy(), 50);
          });
          return;
        }
        if (app.readBack === "endless") {
          const chunk = Buffer.alloc(1_000_000);
          const pour = () => {
            while (!response.destroyed && response.write(chunk));
            if (!response.destroyed) response.once("drain", pour);
          };
          response.once("close", () => response.off("drain", pour));
          pour();
          return;
        }
        response.end(served);
        return;
      }
      return json(response, 404, { error: "Not found." });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const { port } = address;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const run = (args: string[]): Promise<Run> =>
  new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });

interface Observation {
  name: string;
  ok: boolean;
  observed: string;
}

interface VerifyRecord {
  result: string;
  reason: string | null;
  revisionBefore: string | null;
  revisionAfter: string | null;
  observations: Observation[];
}

const stringOrNull = (value: unknown): string | null => {
  assert.ok(value === null || typeof value === "string");
  return value;
};

/** The record the script printed, checked field by field. */
const record = (stdout: string): VerifyRecord => {
  const parsed: unknown = JSON.parse(stdout);
  assert.ok(typeof parsed === "object" && parsed !== null);
  assert.ok("result" in parsed && typeof parsed.result === "string");
  assert.ok("observations" in parsed && Array.isArray(parsed.observations));
  assert.ok("reason" in parsed && "revisionBefore" in parsed && "revisionAfter" in parsed);
  const observations = parsed.observations.map((value: unknown): Observation => {
    assert.ok(typeof value === "object" && value !== null);
    assert.ok("name" in value && typeof value.name === "string");
    assert.ok("ok" in value && typeof value.ok === "boolean");
    assert.ok("observed" in value && typeof value.observed === "string");
    return { name: value.name, ok: value.ok, observed: value.observed };
  });
  return {
    result: parsed.result,
    reason: stringOrNull(parsed.reason),
    revisionBefore: stringOrNull(parsed.revisionBefore),
    revisionAfter: stringOrNull(parsed.revisionAfter),
    observations,
  };
};

const uploads = (requests: string[]) => requests.filter((r) => r.startsWith("POST /api/uploads"));

describe("verify-app-revision", () => {
  let scratch: string;
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "verify-app-revision-"));
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  test("records 9 MB stored and 11 MB refused for option A at the expected main", async () => {
    const app = await startApp({ revision: () => MAIN });
    const out = join(scratch, "a.json");
    try {
      const result = await run([
        "--url",
        `${app.origin}/ignored/path`,
        "--expect",
        MAIN,
        "--option",
        "A",
        "--out",
        out,
      ]);
      assert.equal(result.code, 0, result.stderr);
      const written = record(readFileSync(out, "utf8"));
      assert.deepEqual(written, record(result.stdout));
      assert.equal(written.result, "pass");
      assert.equal(written.revisionBefore, MAIN);
      assert.equal(written.revisionAfter, MAIN);
      const [nine, eleven] = written.observations;
      assert.equal(nine?.name, "9 MB in one request");
      assert.equal(nine?.ok, true);
      assert.match(
        nine?.observed ?? "",
        /^201; read back intact \(9000000 bytes, SHA-256 [0-9a-f]{64}\)$/,
      );
      assert.deepEqual(eleven, {
        name: "11 MB in one request",
        ok: true,
        observed: '413 "Files above 10 MB are not accepted"',
      });
    } finally {
      await app.close();
    }
  });

  test("records 11 MB stored in parts for option B", async () => {
    const app = await startApp({ revision: () => MAIN, chunked: true });
    try {
      const result = await run(["--url", app.origin, "--expect", MAIN, "--option", "B"]);
      assert.equal(result.code, 0, result.stderr);
      const [, eleven] = record(result.stdout).observations;
      assert.equal(eleven?.ok, true);
      assert.match(eleven?.observed ?? "", /^201 in 3 parts; read back intact \(11000000 bytes/);
    } finally {
      await app.close();
    }
  });

  test("fails on an app still at an older commit and uploads nothing", async () => {
    const app = await startApp({ revision: () => OLD });
    try {
      const result = await run(["--url", app.origin, "--expect", MAIN, "--option", "A"]);
      assert.equal(result.code, 1);
      const written = record(result.stdout);
      assert.equal(written.result, "fail");
      assert.equal(written.revisionBefore, OLD);
      assert.deepEqual(written.observations, []);
      assert.match(result.stderr, new RegExp(`reports revision ${OLD}, not ${MAIN}`));
      assert.deepEqual(app.requests, ["GET /api/revision"]);
    } finally {
      await app.close();
    }
  });

  test("fails on an app deployed without a revision", async () => {
    const app = await startApp({ revision: () => "unknown" });
    try {
      const result = await run(["--url", app.origin, "--expect", MAIN, "--option", "A"]);
      assert.equal(result.code, 1);
      assert.equal(record(result.stdout).revisionBefore, "unknown");
      assert.deepEqual(uploads(app.requests), []);
    } finally {
      await app.close();
    }
  });

  test("fails when the deployment changes while the checks run", async () => {
    let reads = 0;
    const app = await startApp({ revision: () => ((reads += 1) === 1 ? MAIN : OLD) });
    try {
      const result = await run(["--url", app.origin, "--expect", MAIN, "--option", "A"]);
      assert.equal(result.code, 1);
      const written = record(result.stdout);
      assert.equal(written.revisionAfter, OLD);
      assert.match(written.reason ?? "", /changed to revision .* during the checks/);
    } finally {
      await app.close();
    }
  });

  test("fails option A on an app that stores 11 MB, and B on one without parts", async () => {
    const noLimit = await startApp({ revision: () => MAIN, noLimit: true });
    const plain = await startApp({ revision: () => MAIN });
    try {
      const a = record(
        (await run(["--url", noLimit.origin, "--expect", MAIN, "--option", "A"])).stdout,
      );
      assert.equal(a.result, "fail");
      assert.deepEqual(a.observations[1], {
        name: "11 MB in one request",
        ok: false,
        observed: "An 11 MB upload returned 201, not 413.",
      });
      const b = await run(["--url", plain.origin, "--expect", MAIN, "--option", "B"]);
      assert.equal(b.code, 1);
      assert.equal(
        record(b.stdout).observations[1]?.observed,
        "POST /api/uploads/chunked returned 404, not 201.",
      );
    } finally {
      await noLimit.close();
      await plain.close();
    }
  });

  test("fails when the stored file reads back different", async () => {
    const app = await startApp({ revision: () => MAIN, readBack: "corrupt" });
    try {
      const result = await run(["--url", app.origin, "--expect", MAIN, "--option", "A"]);
      assert.equal(result.code, 1);
      const [nine] = record(result.stdout).observations;
      assert.equal(nine?.ok, false);
      assert.match(
        nine?.observed ?? "",
        /read back as 9000000 bytes with SHA-256 [0-9a-f]{64}, not the 9000000 bytes sent/,
      );
    } finally {
      await app.close();
    }
  });

  test("records a read-back that breaks off after its headers as a failure", async () => {
    const app = await startApp({ revision: () => MAIN, readBack: "brokenOff" });
    const out = join(scratch, "broken-off.json");
    try {
      const result = await run([
        "--url",
        app.origin,
        "--expect",
        MAIN,
        "--option",
        "A",
        "--out",
        out,
      ]);
      assert.equal(result.code, 1);
      const written = record(readFileSync(out, "utf8"));
      assert.deepEqual(written, record(result.stdout));
      assert.equal(written.result, "fail");
      const [nine, eleven] = written.observations;
      assert.equal(nine?.ok, false);
      assert.match(nine?.observed ?? "", /^Reading upload up-1 back broke off after \d+ bytes: /);
      assert.equal(eleven?.ok, true);
      assert.equal(written.revisionAfter, MAIN);
      assert.match(result.stderr, /does not hold at .*: 9 MB in one request\./);
    } finally {
      await app.close();
    }
  });

  test("stops reading back at the bytes sent when the app answers with more", async () => {
    const app = await startApp({ revision: () => MAIN, readBack: "endless" });
    const out = join(scratch, "endless.json");
    try {
      const result = await run([
        "--url",
        app.origin,
        "--expect",
        MAIN,
        "--option",
        "A",
        "--out",
        out,
      ]);
      assert.equal(result.code, 1);
      const [nine] = record(readFileSync(out, "utf8")).observations;
      assert.deepEqual(nine, {
        name: "9 MB in one request",
        ok: false,
        observed: "Upload up-1 read back as more than the 9000000 bytes sent.",
      });
    } finally {
      await app.close();
    }
  });

  test("fails without uploading when the app cannot be reached", async () => {
    const app = await startApp({ revision: () => MAIN });
    await app.close();
    const result = await run(["--url", app.origin, "--expect", MAIN, "--option", "A"]);
    assert.equal(result.code, 1);
    assert.match(record(result.stdout).reason ?? "", /^GET \/api\/revision failed/);
  });

  test("rejects invalid arguments before any request", async () => {
    const app = await startApp({ revision: () => MAIN });
    try {
      const cases = [
        ["--url", app.origin, "--expect", MAIN.slice(0, 7), "--option", "A"],
        ["--url", app.origin, "--expect", MAIN.toUpperCase(), "--option", "A"],
        ["--url", app.origin, "--expect", MAIN, "--option", "C"],
        ["--url", "ftp://example.invalid", "--expect", MAIN, "--option", "A"],
        ["--url", "not a url", "--expect", MAIN, "--option", "A"],
        ["--expect", MAIN, "--option", "A"],
        ["--url", app.origin, "--expect", MAIN, "--option", "A", "--force"],
      ];
      for (const args of cases) {
        const result = await run(args);
        assert.equal(result.code, 2, args.join(" "));
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /usage: node scripts\/verify-app-revision\.mjs/);
      }
      assert.deepEqual(app.requests, []);
    } finally {
      await app.close();
    }
  });
});
