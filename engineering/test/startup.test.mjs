import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { skillNames, validatePolicy } from "../scripts/policy.mjs";

const source = fileURLToPath(new URL("../../", import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "railhead-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    "engineering",
    "AGENTS.md",
    "CLAUDE.md",
    ".claude",
    ".agents",
    ".github/copilot-instructions.md",
  ]) {
    await cp(resolve(source, path), resolve(root, path), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  return realpath(root);
}
function start(root, args = []) {
  return spawnSync(
    process.execPath,
    [resolve(root, "engineering/scripts/run-start.mjs"), ...args],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 10000,
    },
  );
}

test("a fresh checkout loads its local baseline from any working directory and accepts the same policy", async (t) => {
  const root = await fixture(t);
  const result = start(root);
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout.split("\n")[0]);
  assert.equal(snapshot.path, resolve(root, "engineering"));
  assert.deepEqual(snapshot.skills, skillNames);
  assert.match(result.stdout, /# Railhead working rules/);
  assert.match(result.stdout, /# Railhead writing/);
  assert.equal(start(root, [snapshot.fingerprint]).status, 0);
});

test("invalid fingerprints and changed worker policy stop startup", async (t) => {
  const root = await fixture(t);
  assert.equal(start(root, ["invalid"]).status, 1);
  const before = await validatePolicy(root);
  const policy = resolve(root, "engineering/skills/railhead-working/SKILL.md");
  await writeFile(policy, `${await readFile(policy, "utf8")}\nNew constraint.\n`);
  const result = start(root, [before.fingerprint]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /policy mismatch/);
  assert.equal(result.stdout, "");
});

test("missing baseline and broken reference fail rather than loading partial guidance", async (t) => {
  const root = await fixture(t);
  const path = resolve(root, "engineering/skills/railhead-working/SKILL.md");
  const original = await readFile(path, "utf8");
  await unlink(path);
  assert.equal(start(root).status, 1);
  await writeFile(path, `${original}\n[Missing](absent.md)\n`);
  assert.equal(start(root).status, 1);
});

test("discovery links cannot redirect skills to another source", async (t) => {
  const root = await fixture(t);
  const alias = resolve(root, ".agents/skills/railhead-working");
  await unlink(alias);
  await symlink(resolve(root, "engineering/skills/railhead-writing"), alias);
  const result = start(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local canonical directory/);
});

test("a missing native startup hook fails verification", async (t) => {
  const root = await fixture(t);
  const path = resolve(root, ".claude/settings.json");
  const settings = JSON.parse(await readFile(path, "utf8"));
  delete settings.hooks;
  await writeFile(path, JSON.stringify(settings));
  assert.equal(start(root).status, 1);
});

test("excluded approval tooling cannot return through a skill edit", async (t) => {
  const root = await fixture(t);
  const path = resolve(root, "engineering/skills/railhead-orca/SKILL.md");
  await writeFile(path, `${await readFile(path, "utf8")}\nRun roger list.\n`);
  assert.equal(start(root).status, 1);
});
