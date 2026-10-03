import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { MainBundle } from "./history.ts";
import { loadManifest, SeedRefusal, type SeedManifest } from "./manifest.ts";
import { MemoryTarget } from "./memoryTarget.ts";
import {
  ActionStale,
  describeIssues,
  describePlan,
  planReset,
  planSeed,
  reset,
  seed,
  type BoardIssues,
} from "./reconcile.ts";

const manifest = loadManifest(
  join(import.meta.dirname, "..", "..", "fixtures", "demo", "seed.json"),
);
const demo = { org: "demo", repo: "upload-app" };

/** A bundle header naming `refs` and a stub pack: enough for the target to read its head. */
function bundleOf(head: string, refs = `${head} refs/heads/main\n`): MainBundle {
  return {
    head,
    commits: 4,
    bytes: new TextEncoder().encode(`# v2 git bundle\n${refs}\nPACK`),
  };
}

const history = bundleOf("a".repeat(40));

/** Files the manifest's issues as the owner would on the board. */
function fileSeededIssues(
  target: MemoryTarget,
  titles = manifest.issues.map((i) => i.title),
): void {
  for (const issue of manifest.issues) {
    if (titles.includes(issue.title))
      target.fileAsOwner(demo, { title: issue.title, body: issue.body });
  }
}

test("a seed creates the repository with main in one action, and leaves the issues to the owner", async () => {
  const target = new MemoryTarget();

  const plan = await seed(manifest, history, target, target);

  assert.deepEqual(
    plan.map((planned) => planned.status),
    ["done", "missing", "missing", "missing"],
  );
  assert.deepEqual(await target.read(demo), { main: history.head });
  assert.deepEqual(await target.issues(demo), []);
  // The port offers no way to file one: filing needs the owner's passkey assertion.
  assert.equal("fileIssue" in target, false);
});

test("a repeated seed reconciles to the same state and writes nothing", async () => {
  const target = new MemoryTarget();
  await seed(manifest, history, target, target);
  fileSeededIssues(target);
  const before = { state: await target.read(demo), issues: await target.issues(demo) };

  // Armed: a second write would throw, so passing shows the plan found everything done.
  target.fail("seed");
  const again = await seed(manifest, history, target, target);

  assert.ok(again.every((planned) => planned.status === "done"));
  assert.deepEqual({ state: await target.read(demo), issues: await target.issues(demo) }, before);
  assert.equal(before.issues.length, 3);
});

test("a seed reports which issues the owner has filed and which remain", async () => {
  const target = new MemoryTarget();
  await seed(manifest, history, target, target);
  fileSeededIssues(target, [manifest.issues[0]?.title ?? ""]);

  const plan = await seed(manifest, history, target, target);

  assert.deepEqual(
    plan.map((planned) => planned.status),
    ["done", "done", "missing", "missing"],
  );
  assert.equal((await target.issues(demo)).length, 1);
});

test("a seed that failed leaves no repository, and the next run completes it", async () => {
  const target = new MemoryTarget();
  target.fail("seed");

  await assert.rejects(seed(manifest, history, target, target), /seed failed/);
  assert.equal(await target.read(demo), null);
  assert.deepEqual(target.names(), []);

  await seed(manifest, history, target, target);
  assert.deepEqual(await target.read(demo), { main: history.head });
});

test("a repository left without main is refused as stale until a reset", async () => {
  const target = new MemoryTarget();
  target.leaveWithoutMain(demo);

  await assert.rejects(
    seed(manifest, history, target, target),
    /demo\/upload-app exists without a main: a reset did not finish/,
  );
  await assert.rejects(target.seed(demo, history), ActionStale);
  await assert.rejects(target.seed(demo, history), /has main at nothing, not a{40}/);
  assert.deepEqual(await target.read(demo), { main: null });

  await reset(manifest, target);
  await seed(manifest, history, target, target);
  assert.deepEqual(await target.read(demo), { main: history.head });
});

test("a seed whose response was lost finds main in place and does not seed again", async () => {
  const target = new MemoryTarget();
  target.loseResponseOf("seed");

  await assert.rejects(seed(manifest, history, target, target), /seed response lost/);
  assert.equal((await target.read(demo))?.main, history.head);

  // Armed again: a second seed would throw, so passing shows the plan found main done.
  target.fail("seed");
  const plan = await seed(manifest, history, target, target);
  assert.equal(plan[0]?.status, "done");
  assert.equal((await target.read(demo))?.main, history.head);
});

test("seeding only creates main: the same head succeeds and another is stale", async () => {
  const target = new MemoryTarget();
  await target.seed(demo, history);

  await target.seed(demo, history);
  assert.equal((await target.read(demo))?.main, history.head);

  const other = bundleOf("b".repeat(40));
  await assert.rejects(target.seed(demo, other), ActionStale);
  await assert.rejects(target.seed(demo, other), /has main at a{40}, not b{40}/);
  assert.equal((await target.read(demo))?.main, history.head);
});

test("seeding from a bundle that is not main alone at the approved head writes nothing", async () => {
  const target = new MemoryTarget();
  const a = "a".repeat(40);
  const b = "b".repeat(40);

  for (const bundle of [
    // Main at another head than the one approved.
    { ...bundleOf(b), head: a },
    // A ref beside main.
    bundleOf(a, `${a} HEAD\n${a} refs/heads/main\n`),
    // A prerequisite: the bundle lacks history the target would need.
    bundleOf(a, `-${b}\n${a} refs/heads/main\n`),
    // Another branch.
    bundleOf(a, `${a} refs/heads/dev\n`),
    // No header at all.
    { head: a, commits: 1, bytes: new Uint8Array([0x50, 0x41, 0x43, 0x4b]) },
  ]) {
    await assert.rejects(target.seed(demo, bundle), /not main alone/);
  }
  assert.equal(await target.read(demo), null);
});

test("a seed over another main is refused and writes nothing", async () => {
  const target = new MemoryTarget();
  await seed(manifest, bundleOf("b".repeat(40)), target, target);
  const before = await target.read(demo);

  await assert.rejects(seed(manifest, history, target, target), /already has main at b{40}/);
  assert.deepEqual(await target.read(demo), before);
});

test("an issue body that differs by one byte is an owner edit, not a refusal", async () => {
  const [first] = manifest.issues;
  assert.ok(first !== undefined);
  const edited = new MemoryTarget();
  await edited.seed(demo, history);
  // A hand copy that lost the trailing period.
  const copied = { title: first.title, body: first.body.slice(0, -1) };
  edited.fileAsOwner(demo, copied);

  const plan = await seed(manifest, history, edited, edited);
  assert.deepEqual(
    plan.map(({ step, status }) => [step.target, status]),
    [
      ["demo/upload-app@main", "done"],
      ["demo/upload-app#seed-1", "differs"],
      ["demo/upload-app#seed-2", "missing"],
      ["demo/upload-app#seed-3", "missing"],
    ],
  );
  assert.equal(
    describePlan(plan)[1],
    'edit owner edits issue demo/upload-app#seed-1 to the seeded body: "Warn before uploading a file above the size limit"',
  );
  assert.equal((await edited.read(demo))?.main, history.head);
  assert.deepEqual(await edited.issues(demo), [copied]);
});

test("a seeded issue filed twice is reported with its count, not as done", async () => {
  const [first] = manifest.issues;
  assert.ok(first !== undefined);
  const target = new MemoryTarget();
  await target.seed(demo, history);
  fileSeededIssues(target);
  // The owner filed it again after the first response was lost: same title, same body.
  target.fileAsOwner(demo, { title: first.title, body: first.body });

  const plan = await seed(manifest, history, target, target);

  assert.deepEqual(
    plan.map(({ step, status, filed }) => [step.target, status, filed]),
    [
      ["demo/upload-app@main", "done", undefined],
      ["demo/upload-app#seed-1", "duplicate", 2],
      ["demo/upload-app#seed-2", "done", 1],
      ["demo/upload-app#seed-3", "done", 1],
    ],
  );
  assert.equal(
    describePlan(plan)[1],
    'dup  owner keeps one issue demo/upload-app#seed-1 with the seeded body and closes the other 1 of 2: "Warn before uploading a file above the size limit"',
  );
  // The payload is printed so the owner can tell which copy to keep.
  assert.deepEqual(describeIssues(plan).slice(0, 2), [
    "--- issue demo/upload-app#seed-1 title",
    first.title,
  ]);
  assert.equal(describeIssues(plan).filter((line) => line.startsWith("--- end issue")).length, 1);
  // Nothing is closed or filed for the owner.
  assert.equal((await target.issues(demo)).length, 4);
});

test("a duplicate is reported even when one copy differs, and three copies count as three", async () => {
  const [first] = manifest.issues;
  assert.ok(first !== undefined);
  const target = new MemoryTarget();
  await target.seed(demo, history);
  target.fileAsOwner(demo, { title: first.title, body: first.body });
  target.fileAsOwner(demo, { title: first.title, body: "A hand copy." });

  const twice = await planSeed(manifest, history, target, target);
  assert.deepEqual([twice[1]?.status, twice[1]?.filed], ["duplicate", 2]);

  target.fileAsOwner(demo, { title: first.title, body: first.body });
  const thrice = await planSeed(manifest, history, target, target);
  assert.match(describePlan(thrice)[1] ?? "", /closes the other 2 of 3:/);
});

test("issues the seed did not file are left alone", async () => {
  const target = new MemoryTarget();
  await target.seed(demo, history);
  target.fileAsOwner(demo, { title: "Filed by the owner", body: "Keep me." });
  fileSeededIssues(target);

  await seed(manifest, history, target, target);

  const issues = await target.issues(demo);
  assert.equal(issues.length, 4);
  assert.deepEqual(issues[0], { title: "Filed by the owner", body: "Keep me." });
});

test("reset deletes the demo repository and keeps every other one", async () => {
  const target = new MemoryTarget();
  for (const other of [
    { org: "demo", repo: "upload-app-2" },
    { org: "acme", repo: "upload-app" },
    { org: "demo", repo: "other" },
  ]) {
    await target.seed(other, history);
    target.fileAsOwner(other, { title: "Unrelated", body: "Untouched." });
  }
  await seed(manifest, history, target, target);

  assert.equal(await reset(manifest, target), true);

  assert.equal(await target.read(demo), null);
  assert.deepEqual(target.names(), ["acme/upload-app", "demo/other", "demo/upload-app-2"]);
  assert.deepEqual(await target.issues({ org: "acme", repo: "upload-app" }), [
    { title: "Unrelated", body: "Untouched." },
  ]);
});

test("reset of an absent repository reports nothing deleted, and seed after reset rebuilds the same state", async () => {
  const target = new MemoryTarget();

  assert.equal(await reset(manifest, target), false);
  assert.deepEqual(target.names(), []);

  await seed(manifest, history, target, target);
  const first = await target.read(demo);
  target.fail("reset");
  await assert.rejects(reset(manifest, target), /reset failed/);
  assert.deepEqual(await target.read(demo), first);

  assert.equal(await reset(manifest, target), true);
  await seed(manifest, history, target, target);
  assert.deepEqual(await target.read(demo), first);
});

test("reset always calls the target, so a main left by a failed seed at another head is cleared", async () => {
  const target = new MemoryTarget();
  target.failAfterImport();
  await assert.rejects(seed(manifest, history, target, target), /seed failed after importing main/);
  // Main is imported but the repository was never initialized: `read` reports nothing.
  assert.equal(await target.read(demo), null);
  assert.deepEqual(target.names(), ["demo/upload-app"]);

  // A seed at another head plans a seed; the target's stale answer reaches the owner as a refusal.
  const other = bundleOf("b".repeat(40));
  await assert.rejects(seed(manifest, other, target, target), (error) => {
    assert.ok(error instanceof SeedRefusal);
    assert.equal(error.message, "demo/upload-app@main holds another main. Reset it first.");
    assert.ok(error.cause instanceof ActionStale);
    assert.match(error.cause.message, /has main at a{40}, not b{40}/);
    return true;
  });
  assert.equal(await target.read(demo), null);

  assert.deepEqual(describePlan(planReset(manifest)), ["todo delete repository demo/upload-app"]);
  assert.equal(await reset(manifest, target), true);
  assert.deepEqual(target.names(), []);

  const plan = await seed(manifest, other, target, target);
  assert.equal(plan[0]?.status, "done");
  assert.deepEqual(await target.read(demo), { main: other.head });
});

test("a seed at the same head completes a repository a failed seed left hidden", async () => {
  const target = new MemoryTarget();
  target.failAfterImport();
  await assert.rejects(seed(manifest, history, target, target), /seed failed after importing main/);
  assert.equal(await target.read(demo), null);
  assert.deepEqual(await target.issues(demo), []);

  await seed(manifest, history, target, target);
  assert.deepEqual(await target.read(demo), { main: history.head });
  assert.deepEqual(target.names(), ["demo/upload-app"]);
});

test("a manifest pointed at another repository is refused before the target is read", async () => {
  const target = new MemoryTarget();
  const other: SeedManifest = { ...manifest, org: "acme" };
  await target.seed({ org: "acme", repo: "upload-app" }, history);

  await assert.rejects(seed(other, history, target, target), SeedRefusal);
  await assert.rejects(reset(other, target), SeedRefusal);
  await assert.rejects(planSeed(other, history, target, target), /refusing "acme\/upload-app"/);
  assert.deepEqual(target.names(), ["acme/upload-app"]);
});

test("the issue payloads print verbatim for every issue the owner still has to file or edit", async () => {
  const [first, second, third] = manifest.issues;
  assert.ok(first !== undefined && second !== undefined && third !== undefined);
  const target = new MemoryTarget();
  await target.seed(demo, history);
  target.fileAsOwner(demo, { title: first.title, body: first.body });
  target.fileAsOwner(demo, { title: second.title, body: `${second.body} ` });

  const lines = describeIssues(await planSeed(manifest, history, target, target));
  assert.deepEqual(lines, [
    "--- issue demo/upload-app#seed-2 title",
    second.title,
    "--- issue demo/upload-app#seed-2 body",
    // The manifest's body, which the owner pastes over the board's.
    ...second.body.split("\n"),
    "--- end issue demo/upload-app#seed-2",
    "--- issue demo/upload-app#seed-3 title",
    third.title,
    "--- issue demo/upload-app#seed-3 body",
    ...third.body.split("\n"),
    "--- end issue demo/upload-app#seed-3",
  ]);
  // The printed body is the manifest's, unescaped, with its paragraph breaks as blank lines.
  const body = lines.slice(
    lines.indexOf("--- issue demo/upload-app#seed-2 body") + 1,
    lines.indexOf("--- end issue demo/upload-app#seed-2"),
  );
  assert.equal(body.join("\n"), second.body);
  assert.ok(body.includes(""));
  assert.ok(body.every((line) => !line.includes("\\n") && !line.startsWith('"')));
});

test("a filed issue reads as filed, not as an owner step", async () => {
  const target = new MemoryTarget();
  await seed(manifest, history, target, target);
  fileSeededIssues(target, [manifest.issues[0]?.title ?? ""]);

  assert.deepEqual(describePlan(await planSeed(manifest, history, target, target)), [
    `ok   seed repository demo/upload-app@main = ${history.head}`,
    'ok   issue demo/upload-app#seed-1 is filed: "Warn before uploading a file above the size limit"',
    'todo owner files issue demo/upload-app#seed-2: "Let people upload files larger than 10 MB"',
    'todo owner files issue demo/upload-app#seed-3: "Let people delete an upload"',
  ]);
});

test("no payload prints once every issue is filed as seeded", async () => {
  const target = new MemoryTarget();
  await target.seed(demo, history);
  for (const { title, body } of manifest.issues) target.fileAsOwner(demo, { title, body });

  assert.deepEqual(describeIssues(await planSeed(manifest, history, target, target)), []);
  assert.deepEqual(describeIssues(planReset(manifest)), []);
});

test("a dry run names every target", async () => {
  const empty = new MemoryTarget();
  const lines = describePlan(await planSeed(manifest, history, empty, empty));

  assert.deepEqual(lines, [
    `todo seed repository demo/upload-app@main = ${history.head}`,
    'todo owner files issue demo/upload-app#seed-1: "Warn before uploading a file above the size limit"',
    'todo owner files issue demo/upload-app#seed-2: "Let people upload files larger than 10 MB"',
    'todo owner files issue demo/upload-app#seed-3: "Let people delete an upload"',
  ]);
});

test("a plan refuses a board reset and seeded again at the same main after its scan", async () => {
  const target = new MemoryTarget();
  await target.seed(demo, history);
  fileSeededIssues(target);
  // Another operator resets and seeds the same head between the scan and the second reads, so the
  // issues scanned belong to a board that no longer exists.
  const board: BoardIssues = {
    async scan(ref, titles) {
      const scanned = await target.scan(ref, titles);
      await target.reset(demo);
      await target.seed(demo, history);
      return scanned;
    },
    history: (ref) => target.history(ref),
  };
  await assert.rejects(
    planSeed(manifest, history, target, board),
    (error: unknown) =>
      error instanceof SeedRefusal &&
      error.message === "The repository demo/upload-app changed during planning; run again.",
  );
  assert.deepEqual(await target.read(demo), { main: history.head });
  assert.deepEqual(await target.issues(demo), []);

  // Undisturbed, the same board plans with every issue to file and no refusal.
  const plan = await planSeed(manifest, history, target, target);
  assert.deepEqual(
    plan.map((step) => step.status),
    ["done", "missing", "missing", "missing"],
  );
});
