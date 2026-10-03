import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { MainBundle } from "./history.ts";
import { loadManifest, SeedRefusal, type SeedManifest } from "./manifest.ts";
import { MemoryTarget } from "./memoryTarget.ts";
import { ActionStale, describePlan, planSeed, reset, seed } from "./reconcile.ts";

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

test("a seed creates the repository and imports main, and leaves the issues to the owner", async () => {
  const target = new MemoryTarget();

  const plan = await seed(manifest, history, target);

  assert.deepEqual(
    plan.map((planned) => planned.status),
    ["missing", "missing", "missing", "missing", "missing"],
  );
  assert.deepEqual(await target.read(demo), { main: history.head, issues: [] });
  // The port offers no way to file one: filing needs the owner's passkey assertion.
  assert.equal("fileIssue" in target, false);
});

test("a repeated seed reconciles to the same state and writes nothing", async () => {
  const target = new MemoryTarget();
  await seed(manifest, history, target);
  fileSeededIssues(target);
  const before = await target.read(demo);

  const again = await seed(manifest, history, target);

  assert.ok(again.every((planned) => planned.status === "done"));
  assert.deepEqual(await target.read(demo), before);
  assert.equal(before?.issues.length, 3);
});

test("a seed reports which issues the owner has filed and which remain", async () => {
  const target = new MemoryTarget();
  await seed(manifest, history, target);
  fileSeededIssues(target, [manifest.issues[0]?.title ?? ""]);

  const plan = await seed(manifest, history, target);

  assert.deepEqual(
    plan.map((planned) => planned.status),
    ["done", "done", "done", "missing", "missing"],
  );
  assert.equal((await target.read(demo))?.issues.length, 1);
});

test("a seed that failed before importing main imports it on the next run", async () => {
  const target = new MemoryTarget();
  target.fail("importMain");

  await assert.rejects(seed(manifest, history, target), /importMain failed/);
  assert.deepEqual(await target.read(demo), { main: null, issues: [] });

  await seed(manifest, history, target);
  assert.equal((await target.read(demo))?.main, history.head);
});

test("a seed whose import response was lost finds main in place and does not import again", async () => {
  const target = new MemoryTarget();
  target.loseResponseOf("importMain");

  await assert.rejects(seed(manifest, history, target), /importMain response lost/);
  assert.equal((await target.read(demo))?.main, history.head);

  // Armed again: a second import would throw, so passing shows the plan found main done.
  target.fail("importMain");
  const plan = await seed(manifest, history, target);
  assert.deepEqual(
    plan.slice(0, 2).map((planned) => planned.status),
    ["done", "done"],
  );
  assert.equal((await target.read(demo))?.main, history.head);
});

test("importing main only creates it: the same head succeeds and another is stale", async () => {
  const target = new MemoryTarget();
  await target.createRepo(demo);
  await target.importMain(demo, history);

  await target.importMain(demo, history);
  assert.equal((await target.read(demo))?.main, history.head);

  const other = bundleOf("b".repeat(40));
  await assert.rejects(target.importMain(demo, other), ActionStale);
  await assert.rejects(target.importMain(demo, other), /has main at a{40}, not b{40}/);
  assert.equal((await target.read(demo))?.main, history.head);
});

test("importing a bundle that is not main alone at the approved head writes nothing", async () => {
  const target = new MemoryTarget();
  await target.createRepo(demo);
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
    await assert.rejects(target.importMain(demo, bundle), /not main alone/);
  }
  assert.equal((await target.read(demo))?.main, null);
});

test("a seed over another main or an edited issue is refused and writes nothing", async () => {
  const target = new MemoryTarget();
  await seed(manifest, bundleOf("b".repeat(40)), target);
  const before = await target.read(demo);

  await assert.rejects(seed(manifest, history, target), /already has main at b{40}/);
  assert.deepEqual(await target.read(demo), before);

  const edited = new MemoryTarget();
  await edited.createRepo(demo);
  edited.fileAsOwner(demo, { title: manifest.issues[0]?.title ?? "", body: "Changed." });
  await assert.rejects(seed(manifest, history, edited), /another body/);
  assert.equal((await edited.read(demo))?.main, null);
});

test("issues the seed did not file are left alone", async () => {
  const target = new MemoryTarget();
  await target.createRepo(demo);
  target.fileAsOwner(demo, { title: "Filed by the owner", body: "Keep me." });
  fileSeededIssues(target);

  await seed(manifest, history, target);

  const issues = (await target.read(demo))?.issues ?? [];
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
    await target.createRepo(other);
    target.fileAsOwner(other, { title: "Unrelated", body: "Untouched." });
  }
  await seed(manifest, history, target);

  const plan = await reset(manifest, target);

  assert.deepEqual(describePlan(plan), ["todo delete repository demo/upload-app"]);
  assert.equal(await target.read(demo), null);
  assert.deepEqual(target.names(), ["acme/upload-app", "demo/other", "demo/upload-app-2"]);
  assert.deepEqual((await target.read({ org: "acme", repo: "upload-app" }))?.issues, [
    { title: "Unrelated", body: "Untouched." },
  ]);
});

test("reset of an absent repository writes nothing, and seed after reset rebuilds the same state", async () => {
  const target = new MemoryTarget();
  target.fail("deleteRepo");

  const plan = await reset(manifest, target);
  assert.deepEqual(describePlan(plan), ["ok   delete repository demo/upload-app"]);

  await seed(manifest, history, target);
  const first = await target.read(demo);
  // The armed failure is still pending, so the reset of the existing repository fails first.
  await assert.rejects(reset(manifest, target), /deleteRepo failed/);
  assert.deepEqual(await target.read(demo), first);

  await reset(manifest, target);
  await seed(manifest, history, target);
  assert.deepEqual(await target.read(demo), first);
});

test("a manifest pointed at another repository is refused before the target is read", async () => {
  const target = new MemoryTarget();
  const other: SeedManifest = { ...manifest, org: "acme" };
  await target.createRepo({ org: "acme", repo: "upload-app" });

  await assert.rejects(seed(other, history, target), SeedRefusal);
  await assert.rejects(reset(other, target), SeedRefusal);
  await assert.rejects(planSeed(other, history, target), /refusing "acme\/upload-app"/);
  assert.deepEqual(target.names(), ["acme/upload-app"]);
});

test("a dry run names every target", async () => {
  const lines = describePlan(await planSeed(manifest, history, new MemoryTarget()));

  assert.deepEqual(lines, [
    "todo create repository demo/upload-app",
    `todo import main demo/upload-app@main = ${history.head}`,
    'todo owner files issue demo/upload-app#seed-1: "Warn before uploading a file above the size limit"',
    'todo owner files issue demo/upload-app#seed-2: "Let people upload files larger than 10 MB"',
    'todo owner files issue demo/upload-app#seed-3: "Let people delete an upload"',
  ]);
});
