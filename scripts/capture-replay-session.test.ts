// The capture script end to end: a real Cap'n Web session over a WebSocket to an in-process board
// endpoint serving a populated log, the file it writes, and that file opened by the replay page's
// own `openReplay`. The endpoint stands in for the backend; this is evidence for the script, not a
// capture of a deployed run.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { RpcSession, RpcTarget, type RpcTransport } from "capnweb";
import { WebSocketServer, type WebSocket } from "ws";

const root = join(import.meta.dirname, "..");
const script = join(import.meta.dirname, "capture-replay.mjs");

// The board's modules import their siblings without an extension, as Vite resolves them. `node`
// needs the extension, so this test supplies it.
registerHooks({
  resolve: (specifier, context, nextResolve) => {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && extname(specifier) === "") {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A module of the board, loaded by path so this package's type check does not compile it. */
const load = async (path: string): Promise<Record<string, unknown>> => {
  const loaded: unknown = await import(pathToFileURL(join(root, path)).href);
  assert.ok(isRecord(loaded));
  return loaded;
};

const { API_PATH } = await load("packages/railhead-shared/src/api.ts");
assert.equal(typeof API_PATH, "string");

const callable = (value: unknown) => {
  if (typeof value !== "function") throw new Error("not a function");
  return (...args: unknown[]): unknown => Reflect.apply(value, undefined, args);
};

/** Fewer events per page than the client asks for, so the capture must page. */
const SERVED_PAGE = 7;

/** A Cap'n Web transport over a `ws` server socket. */
const transportOf = (socket: WebSocket): RpcTransport => {
  const inbox: string[] = [];
  const waiting: { resolve: (message: string) => void; reject: (error: Error) => void }[] = [];
  let closed: Error | null = null;
  socket.on("message", (data, isBinary) => {
    const message = isBinary ? "" : String(data);
    const next = waiting.shift();
    if (next === undefined) inbox.push(message);
    else next.resolve(message);
  });
  socket.on("close", () => {
    closed = new Error("socket closed");
    for (const next of waiting.splice(0)) next.reject(closed);
  });
  return {
    send: (message) => socket.send(message),
    receive: () => {
      const message = inbox.shift();
      if (message !== undefined) return Promise.resolve(message);
      if (closed !== null) return Promise.reject(closed);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    abort: () => socket.close(),
  };
};

/** Serves `log` as repository demo/upload-app, as the backend's `openBoard` and `readEvents` do. */
const startBoard = async (repo: string, log: readonly unknown[]) => {
  const pages: number[] = [];
  class Board extends RpcTarget {
    readEvents(cursor: number, limit: number) {
      const events = log.slice(cursor, cursor + Math.min(limit, SERVED_PAGE));
      pages.push(cursor);
      return {
        ok: true,
        value: { repo, events, cursor: cursor + events.length, head: log.length },
      };
    }
  }
  class Api extends RpcTarget {
    openBoard(org: string, name: string) {
      return org === "demo" && name === "upload-app"
        ? { ok: true, value: new Board() }
        : { ok: false, code: "not_found", message: "no such repository" };
    }
  }
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: String(API_PATH) });
  const sessions: RpcSession[] = [];
  server.on("connection", (socket) => {
    sessions.push(new RpcSession(transportOf(socket), new Api()));
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(isRecord(address) && typeof address.port === "number");
  return {
    port: address.port,
    pages,
    close: () => {
      for (const client of server.clients) client.terminate();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const runScript = (args: readonly string[]) =>
  new Promise<{ code: number | null; stderr: string }>((resolve) => {
    execFile(process.execPath, [script, ...args], { timeout: 20_000 }, (error, _out, stderr) =>
      resolve({
        code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
        stderr,
      }),
    );
  });

test("captures a served log into a file the replay page opens to the same board", async () => {
  const { decisionReversal } = await load("fixtures/board/decisionReversal.ts");
  assert.ok(isRecord(decisionReversal) && Array.isArray(decisionReversal.events));
  const events: unknown[] = decisionReversal.events;
  const first = events[0];
  assert.ok(isRecord(first) && typeof first.repo === "string");
  const repo = first.repo;
  // A field the event contract never defined, standing in for anything the backend might add.
  const served = events.map((event) => ({
    ...(isRecord(event) ? event : {}),
    token: "s3cr3t-field",
  }));

  const board = await startBoard(repo, served);
  const dir = mkdtempSync(join(tmpdir(), "capture-replay-session-"));
  try {
    const out = join(dir, "run.json");
    const before = Date.now();
    const result = await runScript([
      "--origin",
      `http://capture:s3cr3t-pass@127.0.0.1:${board.port}/ignored?token=s3cr3t-query`,
      "--repo",
      "demo/upload-app",
      "--out",
      out,
    ]);
    const after = Date.now();
    const origin = `http://127.0.0.1:${board.port}`;
    assert.equal(
      result.stderr,
      `captured ${events.length} events of demo/upload-app from ${origin} into ${out}\n`,
    );
    assert.equal(result.code, 0);
    assert.equal(board.pages.length, Math.ceil(events.length / SERVED_PAGE));
    assert.deepEqual(readdirSync(dir), ["run.json"]);

    const text = readFileSync(out, "utf8");
    assert.doesNotMatch(text, /s3cr3t|capture:/);
    const file: unknown = JSON.parse(text);
    assert.ok(isRecord(file) && isRecord(file.source));
    const { capturedAt } = file.source;
    assert.ok(typeof capturedAt === "number" && capturedAt >= before && capturedAt <= after);
    assert.deepEqual(file, {
      format: "railhead.replay",
      version: 1,
      source: { kind: "captured", origin, org: "demo", name: "upload-app", capturedAt },
      repo,
      head: events.length,
      events,
    });

    const { openReplay } = await load(
      "packages/railhead-frontend/src/features/replay/replayLog.ts",
    );
    const { emptyBoardState, foldEvents } = await load(
      "packages/railhead-frontend/src/features/board/boardState.ts",
    );
    const opened = callable(openReplay)(text);
    assert.ok(isRecord(opened) && opened.ok === true && isRecord(opened.replay));
    assert.deepEqual(
      opened.replay.final,
      callable(foldEvents)(callable(emptyBoardState)(repo), events),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await board.close();
  }
});

test("reports the backend's refusal to open the repository and writes nothing", async () => {
  const board = await startBoard("rep_synthrepo", []);
  const dir = mkdtempSync(join(tmpdir(), "capture-replay-session-"));
  try {
    const out = join(dir, "run.json");
    const result = await runScript([
      "--origin",
      `http://127.0.0.1:${board.port}`,
      "--repo",
      "demo/other-app",
      "--out",
      out,
    ]);
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      "capture-replay: the backend refused to open demo/other-app (not_found)\n",
    );
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await board.close();
  }
});
