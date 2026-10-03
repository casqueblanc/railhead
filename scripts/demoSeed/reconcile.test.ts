import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadManifest, SeedRefusal, type SeedManifest } from "./manifest.ts";
import { MemoryTarget } from "./memoryTarget.ts";
import { describePlan, planSeed, reset, seed } from "./reconcile.ts";

const manifest = loadManifest(
  join(import.meta.dirname, "..", "..", "fixtures", "demo", "seed.json"),
);
const demo = { org: "demo", repo: "upload-app" };
const history = { head: "a".repeat(40), commits: 4 };

test("a seed creates the repository, imports main and files the three issues", async () => {
  const target = new MemoryTarget();

  const plan = await seed(manifest, history, target);

  assert.deepEqual(
    plan.map((planned) => planned.status),
    ["missing", "missing", "missing", "missing", "missing"],
  );
  assert.deepEqual(await target.read(demo), {
    main: history.head,
    issues: manifest.issues.map(({ title, body }) => ({ title, body })),
  });
});

test("a repeated seed reconciles to the same state and writes nothing", async () => {
  const target = new MemoryTarget();
  await seed(manifest, history, target);
  const before = await target.read(demo);

  const again = await seed(manifest, history, target);

  assert.ok(again.every((planned) => planned.status === "done"));
  assert.deepEqual(await target.read(demo), before);
  assert.equal(before?.issues.length, 3);
});

test("a seed whose issue write lost its response finishes without a duplicate", async () => {
  const target = new MemoryTarget();
  target.loseResponseOf("fileIssue");

  await assert.rejects(seed(manifest, history, target), /fileIssue response lost/);
  assert.equal((await target.read(demo))?.issues.length, 1);

  const plan = await seed(manifest, history, target);

  assert.deepEqual(
    plan.map((planned) => planned.status),
    ["done", "done", "done", "missing", "missing"],
  );
  assert.deepEqual(
    (await target.read(demo))?.issues.map((issue) => issue.title),
    manifest.issues.map((issue) => issue.title),
  );
});

test("a seed that failed before importing main imports it on the next run", async () => {
  const target = new MemoryTarget();
  target.fail("importMain");

  await assert.rejects(seed(manifest, history, target), /importMain failed/);
  assert.deepEqual(await target.read(demo), { main: null, issues: [] });

  await seed(manifest, history, target);
  assert.equal((await target.read(demo))?.main, history.head);
});

test("a seed over another main or an edited issue is refused and writes nothing", async () => {
  const target = new MemoryTarget();
  await seed(manifest, { head: "b".repeat(40), commits: 1 }, target);
  const before = await target.read(demo);

  await assert.rejects(seed(manifest, history, target), /already has main at b{40}/);
  assert.deepEqual(await target.read(demo), before);

  const edited = new MemoryTarget();
  await edited.createRepo(demo);
  await edited.fileIssue(demo, { title: manifest.issues[0]?.title ?? "", body: "Changed." });
  await assert.rejects(seed(manifest, history, edited), /another body/);
  assert.equal((await edited.read(demo))?.main, null);
});

test("issues the seed did not file are left alone", async () => {
  const target = new MemoryTarget();
  await target.createRepo(demo);
  await target.fileIssue(demo, { title: "Filed by the owner", body: "Keep me." });

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
    await target.fileIssue(other, { title: "Unrelated", body: "Untouched." });
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
    'todo file issue demo/upload-app#seed-1: "Warn before uploading a file above the size limit"',
    'todo file issue demo/upload-app#seed-2: "Let people upload files larger than 10 MB"',
    'todo file issue demo/upload-app#seed-3: "Let people delete an upload"',
  ]);
});
