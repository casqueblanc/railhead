import assert from "node:assert/strict";
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
  LiveTarget,
  liveApiUrl,
  MAX_EVENT_PAGE,
  parseSignedApproval,
  type Approval,
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
): Promise<T> {
  using session = sessionWith(backend);
  return await body(new LiveTarget(session, approval));
}

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
    (error: unknown) =>
      error instanceof Error && !(error instanceof SeedRefusal) && /internal/.test(error.message),
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

test("issues are read from every page of the log, and a missing repository has none", async () => {
  const backend = new FakeBackend();
  assert.deepEqual(await withTarget(backend, { kind: "prepare" }, (t) => t.issues(DEMO_REF)), []);

  backend.exists = true;
  backend.main = HEAD;
  // More than two pages, with the issues on the first and the last.
  const count = MAX_EVENT_PAGE * 2 + 3;
  backend.events = Array.from({ length: count }, (_, i) => otherEvent(i + 1));
  backend.events[0] = issueEvent(1, "First", "one");
  backend.events[count - 1] = issueEvent(count, "Last", "line\n\nline");
  assert.deepEqual(await withTarget(backend, { kind: "prepare" }, (t) => t.issues(DEMO_REF)), [
    { title: "First", body: "one" },
    { title: "Last", body: "line\n\nline" },
  ]);

  // A log that stops advancing before its head is an error, not an empty board.
  backend.stall = true;
  await assert.rejects(
    withTarget(backend, { kind: "prepare" }, (t) => t.issues(DEMO_REF)),
    /stopped at 0 before its head/,
  );
});
