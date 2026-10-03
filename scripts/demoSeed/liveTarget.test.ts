import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
// These load under plain `node`: their own imports are type-only.
import * as sharedApi from "../../packages/railhead-shared/src/api.ts";
import * as sharedBoard from "../../packages/railhead-shared/src/board-api.ts";
import { describeApproval } from "./cli.ts";
import { FakeBackend, issueEvent, otherEvent, sessionWith, signedFor } from "./fakeBackend.ts";
import { MAX_BUNDLE_BYTES, type MainBundle } from "./history.ts";
import {
  API_PATH,
  ApprovalNeeded,
  BackendFailure,
  LIVE_LIMITS,
  LiveTarget,
  liveApiUrl,
  MAX_EVENT_PAGE,
  MAX_EVENT_PAGES,
  parseSignedApproval,
  WriteUncertain,
  type Approval,
  type LiveLimits,
} from "./liveTarget.ts";
import { loadManifest, SeedRefusal } from "./manifest.ts";
import { ActionStale, DEMO_REF, reset, seed } from "./reconcile.ts";

const root = join(import.meta.dirname, "..", "..");
const manifest = loadManifest(join(root, "fixtures", "demo", "seed.json"));

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);

function bundleAt(head: string): MainBundle {
  return { head, commits: 2, bytes: new Uint8Array([1, 2, 3, 250, 0, 7]) };
}

async function withTarget<T>(
  backend: FakeBackend,
  approval: Approval,
  body: (target: LiveTarget) => Promise<T>,
  limits: LiveLimits = LIVE_LIMITS,
): Promise<T> {
  using session = sessionWith(backend);
  return await body(new LiveTarget(session, approval, limits));
}

/** A backend holding the demo repository with `count` events, none of them issues. */
function withLog(count: number): FakeBackend {
  const backend = new FakeBackend();
  backend.exists = true;
  backend.main = HEAD;
  backend.events = Array.from({ length: count }, (_, i) => otherEvent(i + 1));
  return backend;
}

const WANTED = new Set(["First", "Last"]);

/** The challenge a prepare-only seed of `head` stops with. */
async function preparedSeed(backend: FakeBackend, head: string): Promise<ApprovalNeeded> {
  const error = await withTarget(backend, { kind: "prepare" }, (target) =>
    seed(manifest, bundleAt(head), target, target).then(
      () => assert.fail("the seed should stop after prepare"),
      (thrown: unknown) => thrown,
    ),
  );
  assert.ok(error instanceof ApprovalNeeded);
  return error;
}

function signed(needed: ApprovalNeeded): Approval {
  const { challengeId } = needed.challenge;
  return { kind: "signed", challengeId, assertion: signedFor(challengeId) };
}

test("the restated constants match @railhead/shared", () => {
  assert.equal(API_PATH, sharedApi.API_PATH);
  assert.equal(MAX_EVENT_PAGE, sharedBoard.MAX_EVENT_PAGE);
  assert.equal(MAX_BUNDLE_BYTES, sharedBoard.MAX_DEMO_BUNDLE_BYTES);
});

test("the API URL is the origin's WebSocket session, and anything but an origin is refused", () => {
  assert.equal(liveApiUrl("https://railhead.dev"), "wss://railhead.dev/api");
  assert.equal(liveApiUrl("https://railhead.dev/"), "wss://railhead.dev/api");
  assert.equal(liveApiUrl("http://localhost:8787"), "ws://localhost:8787/api");
  assert.equal(liveApiUrl("http://127.0.0.1:8787"), "ws://127.0.0.1:8787/api");
  for (const origin of [
    "http://railhead.dev",
    "ftp://railhead.dev",
    "wss://railhead.dev",
    "https://railhead.dev/api",
    "https://railhead.dev?x=1",
    "https://owner:secret@railhead.dev",
    "railhead.dev",
    "",
  ]) {
    assert.throws(() => liveApiUrl(origin), SeedRefusal, origin);
  }
});

test("a signed approval file is read field by field, and a malformed one is refused", () => {
  const assertion = signedFor("dsc_1");
  assert.deepEqual(parseSignedApproval({ challengeId: "dsc_1", assertion }), {
    kind: "signed",
    challengeId: "dsc_1",
    assertion,
  });
  // Fields the backend does not take are dropped, not forwarded.
  const extra = parseSignedApproval({
    challengeId: "dsc_1",
    assertion: { ...assertion, userHandle: "dXNlcg", extra: "x" },
    note: "y",
  });
  assert.deepEqual(extra, {
    kind: "signed",
    challengeId: "dsc_1",
    assertion: { ...assertion, userHandle: "dXNlcg" },
  });
  for (const value of [
    null,
    [],
    { challengeId: "dsc_1" },
    { challengeId: "", assertion },
    { challengeId: "dsc 1", assertion },
    { challengeId: 1, assertion },
    { challengeId: "dsc_1", assertion: { ...assertion, signature: "not base64url!" } },
    { challengeId: "dsc_1", assertion: { ...assertion, credentialId: undefined } },
    { challengeId: "dsc_1", assertion: { ...assertion, userHandle: 3 } },
  ]) {
    assert.throws(() => parseSignedApproval(value), SeedRefusal, JSON.stringify(value));
  }
});

test("without an assertion a seed stops after prepare and writes nothing", async () => {
  const backend = new FakeBackend();
  const needed = await preparedSeed(backend, HEAD);

  assert.deepEqual(needed.action, { kind: "demo.seed", head: HEAD });
  assert.equal(needed.challenge.challengeId, "dsc_1");
  assert.deepEqual(backend.prepared, [{ kind: "demo.seed", head: HEAD }]);
  assert.equal(backend.exists, false);
  assert.equal(backend.received.length, 0);
  const lines = describeApproval(needed);
  assert.match(
    lines[0] ?? "",
    /^stopped after prepare: demo\.seed of main a{40} .*nothing was written$/,
  );
  assert.ok(lines.includes("note there is no command-line passkey signer yet (#148)"));
  assert.ok(lines.includes(`challenge ${JSON.stringify(needed.challenge)}`));
  assert.match(lines.at(-1) ?? "", /before 2026-10-03T12:00:00\.000Z.*--assertion FILE$/);
});

test("a signed seed imports main once, sending the bundle's bytes, and a repeat writes nothing", async () => {
  const backend = new FakeBackend();
  const needed = await preparedSeed(backend, HEAD);

  const plan = await withTarget(backend, signed(needed), (target) =>
    seed(manifest, bundleAt(HEAD), target, target),
  );
  assert.equal(plan[0]?.status, "done");
  assert.equal(backend.main, HEAD);
  assert.deepEqual(backend.received, [bundleAt(HEAD).bytes]);

  // Main is in place, so the next run reads it and never asks for a challenge.
  const again = await withTarget(backend, { kind: "prepare" }, (target) =>
    seed(manifest, bundleAt(HEAD), target, target),
  );
  assert.equal(again[0]?.status, "done");
  assert.equal(backend.prepared.length, 1);
  assert.equal(backend.received.length, 1);
});

test("the backend's refusals reach the seed as refusals, and its failures as errors", async () => {
  // A main the read cannot see, at another head: the reconciler's "reset first".
  const stale = new FakeBackend();
  stale.main = OTHER_HEAD;
  const staleNeeded = await preparedSeed(stale, HEAD);
  await assert.rejects(
    withTarget(stale, signed(staleNeeded), (target) =>
      seed(manifest, bundleAt(HEAD), target, target),
    ),
    (error: unknown) =>
      error instanceof SeedRefusal &&
      /holds another main/.test(error.message) &&
      error.cause instanceof ActionStale,
  );
  assert.equal(stale.main, OTHER_HEAD);

  const backend = new FakeBackend();
  const needed = await preparedSeed(backend, HEAD);
  // An assertion signed for another challenge.
  const wrong: Approval = {
    kind: "signed",
    challengeId: needed.challenge.challengeId,
    assertion: signedFor("dsc_9"),
  };
  await assert.rejects(
    withTarget(backend, wrong, (target) => seed(manifest, bundleAt(HEAD), target, target)),
    (error: unknown) => error instanceof SeedRefusal && /proof_invalid/.test(error.message),
  );
  backend.failNextPerform = "internal";
  await assert.rejects(
    withTarget(backend, signed(needed), (target) => seed(manifest, bundleAt(HEAD), target, target)),
    (error: unknown) => error instanceof BackendFailure && /internal/.test(error.message),
  );
  assert.equal(backend.exists, false);
});

test("a target spends its approval on one write and refuses a second", async () => {
  const backend = new FakeBackend();
  const needed = await preparedSeed(backend, HEAD);
  await withTarget(backend, signed(needed), async (target) => {
    await target.seed(DEMO_REF, bundleAt(HEAD));
    await assert.rejects(target.reset(DEMO_REF), /needs another owner passkey assertion/);
  });
  assert.equal(backend.main, HEAD);
});

test("a signed reset deletes the demo repository, and another repository is refused unread", async () => {
  const backend = new FakeBackend();
  backend.exists = true;
  backend.main = HEAD;
  const resetNeeded = await withTarget(backend, { kind: "prepare" }, (target) =>
    reset(DEMO_REF, target).then(
      () => assert.fail("the reset should stop after prepare"),
      (thrown: unknown) => thrown,
    ),
  );
  assert.ok(resetNeeded instanceof ApprovalNeeded);
  assert.deepEqual(resetNeeded.action, { kind: "demo.reset" });
  assert.equal(backend.exists, true);

  assert.equal(await withTarget(backend, signed(resetNeeded), (t) => reset(DEMO_REF, t)), true);
  assert.equal(backend.exists, false);
  assert.equal(backend.main, null);

  await withTarget(backend, { kind: "prepare" }, async (target) => {
    await assert.rejects(target.read({ org: "demo", repo: "other" }), /refusing/);
    await assert.rejects(target.reset({ org: "acme", repo: "upload-app" }), /refusing/);
  });
  assert.equal(backend.prepared.length, 1);
});

test("issues are read from every page of the log, keeping only the titles asked for", async () => {
  const empty = new FakeBackend();
  assert.deepEqual(
    await withTarget(empty, { kind: "prepare" }, (t) => t.issues(DEMO_REF, WANTED)),
    [],
  );

  // More than two pages, with the wanted issues on the first and the last, and another between.
  const count = MAX_EVENT_PAGE * 2 + 3;
  const backend = withLog(count);
  backend.events[0] = issueEvent(1, "First", "one");
  backend.events[MAX_EVENT_PAGE] = issueEvent(MAX_EVENT_PAGE + 1, "Not seeded", "dropped");
  backend.events[count - 1] = issueEvent(count, "Last", "line\n\nline");
  assert.deepEqual(
    await withTarget(backend, { kind: "prepare" }, (t) => t.issues(DEMO_REF, WANTED)),
    [
      { title: "First", body: "one" },
      { title: "Last", body: "line\n\nline" },
    ],
  );

  // A log that stops advancing before its head is an error, not an empty board.
  backend.stall = true;
  await assert.rejects(
    withTarget(backend, { kind: "prepare" }, (t) => t.issues(DEMO_REF, WANTED)),
    /stopped at 0 before its head/,
  );
});

test("a repository reset between the read and the board read fails the plan", async () => {
  const backend = withLog(0);
  backend.onOpenBoard = () => {
    backend.exists = false;
    backend.main = null;
  };
  await assert.rejects(
    withTarget(backend, { kind: "prepare" }, (t) => seed(manifest, bundleAt(HEAD), t, t)),
    (error: unknown) =>
      error instanceof SeedRefusal &&
      error.message ===
        "demo/upload-app changed during planning: it was read, then the board did not find it; run again.",
  );
  assert.equal(backend.prepared.length, 0);
});

test("a board log longer than the page cap stops the plan as incomplete", async () => {
  const cap = MAX_EVENT_PAGES * MAX_EVENT_PAGE;
  // Exactly the cap is read whole.
  const full = withLog(cap);
  full.events[cap - 1] = issueEvent(cap, "Last", "end");
  assert.deepEqual(await withTarget(full, { kind: "prepare" }, (t) => t.issues(DEMO_REF, WANTED)), [
    { title: "Last", body: "end" },
  ]);

  // One event past it is refused, even though the wanted issue is within the first page.
  const over = withLog(cap + 1);
  over.events[0] = issueEvent(1, "First", "one");
  await assert.rejects(
    withTarget(over, { kind: "prepare" }, (t) => t.issues(DEMO_REF, WANTED)),
    (error: unknown) =>
      error instanceof SeedRefusal &&
      error.message ===
        "The board log is too long: stopped reading it past 16384 events, so the plan is incomplete.",
  );
  // So is the seed plan built on it, before anything is written.
  await assert.rejects(
    withTarget(over, { kind: "prepare" }, (t) => seed(manifest, bundleAt(HEAD), t, t)),
    /board log is too long/,
  );
  assert.equal(over.prepared.length, 0);
});

test("a board log that takes longer than the scan budget stops the plan as incomplete", async () => {
  const backend = withLog(MAX_EVENT_PAGE * 4);
  // Each look at the clock is one second later; the budget is two and a half.
  let clock = 0;
  const limits: LiveLimits = { ...LIVE_LIMITS, scanMs: 2500, now: () => (clock += 1000) };
  await assert.rejects(
    withTarget(backend, { kind: "prepare" }, (t) => t.issues(DEMO_REF, WANTED), limits),
    (error: unknown) =>
      error instanceof SeedRefusal &&
      error.message ===
        "The board log is too long: stopped reading it after 2500 ms, so the plan is incomplete.",
  );
  // Within the budget the same log is read whole.
  assert.deepEqual(
    await withTarget(backend, { kind: "prepare" }, (t) => t.issues(DEMO_REF, WANTED)),
    [],
  );
});

test("a write whose answer is lost fails as uncertain and is not repeated", async () => {
  const limits: LiveLimits = { ...LIVE_LIMITS, writeMs: 50 };
  const backend = new FakeBackend();
  const needed = await preparedSeed(backend, HEAD);
  backend.withholdNextAnswer = true;
  await assert.rejects(
    withTarget(backend, signed(needed), (t) => seed(manifest, bundleAt(HEAD), t, t), limits),
    (error: unknown) =>
      error instanceof WriteUncertain &&
      error.action.kind === "demo.seed" &&
      error.message === "demoSeed.perform did not answer within 50 ms.",
  );
  // The backend applied it once, and nothing sent it again.
  assert.deepEqual(backend.performed, ["demo.seed"]);
  assert.equal(backend.main, HEAD);
});

test("an unavailable backend is a failure with its sentence, not a refusal", async () => {
  const backend = new FakeBackend();
  const needed = await preparedSeed(backend, HEAD);
  backend.failNextPerform = "unavailable";
  await assert.rejects(
    withTarget(backend, signed(needed), (target) => target.seed(DEMO_REF, bundleAt(HEAD))),
    (error: unknown) =>
      error instanceof BackendFailure &&
      error.message ===
        "demo.seed failed with unavailable: The fake backend refused with unavailable.",
  );
  assert.equal(backend.exists, false);
});

test("the CLI reports a backend it cannot reach in one line and exits 1", async () => {
  // A port that was just free: nothing listens on it.
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  await new Promise((done) => server.close(done));

  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "cli.ts"), "reset", "--target", `http://127.0.0.1:${address.port}`],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "demoSeed failed: WebSocket connection failed.\n");
});
