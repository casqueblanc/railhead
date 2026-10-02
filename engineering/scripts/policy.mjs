import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export const skillNames = [
  "commits",
  "frontend-conventions",
  "frontend-design",
  "gh-stack",
  "kumo-design",
  "orca",
  "review",
  "testing",
  "typesafe",
  "typescript",
  "ui-checklist",
  "working",
  "writing",
].map((name) => `railhead-${name}`);

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Canonical policy must not be a link: ${path}`);
    if (entry.isDirectory()) files.push(...(await filesIn(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.toSorted();
}

function isInside(root, path) {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !part.startsWith(sep);
}

export async function validatePolicy(root) {
  root = await realpath(root);
  const engineering = resolve(root, "engineering");
  const canonical = await filesIn(engineering);
  const entries = [
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/settings.json",
    ".github/copilot-instructions.md",
  ];
  const entryContents = new Map();
  for (const entry of entries)
    entryContents.set(entry, await readFile(resolve(root, entry), "utf8"));
  for (const name of skillNames) {
    const target = resolve(engineering, "skills", name);
    const skill = await readFile(resolve(target, "SKILL.md"), "utf8");
    if (!skill.startsWith(`---\nname: ${name}\n`) || !/^description: .+$/m.test(skill)) {
      throw new Error(`Invalid skill frontmatter: ${name}`);
    }
    for (const directory of [".agents/skills", ".claude/skills"]) {
      const alias = resolve(root, directory, name);
      if (!(await lstat(alias)).isSymbolicLink() || (await realpath(alias)) !== target) {
        throw new Error(`Skill discovery must point to the local canonical directory: ${alias}`);
      }
    }
  }
  const settings = JSON.parse(entryContents.get(".claude/settings.json"));
  const commands = settings.hooks?.SessionStart?.flatMap((group) => group.hooks ?? []);
  if (
    !commands?.some(
      (hook) =>
        hook.type === "command" &&
        hook.command === 'node "$CLAUDE_PROJECT_DIR/engineering/scripts/run-start.mjs"' &&
        hook.timeout === 10,
    )
  ) {
    throw new Error("Claude SessionStart must run the local baseline with a bounded timeout");
  }
  if (settings.attribution?.commit !== "" || settings.attribution?.pr !== "") {
    throw new Error("Claude attribution must be disabled");
  }
  if (entryContents.get("CLAUDE.md").trim() !== "@AGENTS.md")
    throw new Error("Claude must import AGENTS.md");
  for (const entry of ["AGENTS.md", ".github/copilot-instructions.md"]) {
    const content = entryContents.get(entry);
    for (const required of [
      "pnpm run-start",
      "engineering/skills/railhead-working/SKILL.md",
      "engineering/skills/railhead-writing/SKILL.md",
      "engineering/skills/railhead-review/SKILL.md",
    ]) {
      if (!content.includes(required)) throw new Error(`${entry} is missing ${required}`);
    }
  }
  const markdown = canonical.filter((path) => path.endsWith(".md"));
  for (const path of [
    ...markdown,
    resolve(root, "AGENTS.md"),
    resolve(root, ".github/copilot-instructions.md"),
  ]) {
    const content = await readFile(path, "utf8");
    if (/\broger\b/i.test(content)) throw new Error(`Excluded approval integration in ${path}`);
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const link = match[1];
      if (/^(?:https?:|mailto:|#)/.test(link)) continue;
      const target = resolve(dirname(path), decodeURIComponent(link.split("#")[0]));
      if (!isInside(root, target) || !isInside(root, await realpath(target))) {
        throw new Error(`Policy link escapes the monorepo: ${path}: ${link}`);
      }
    }
  }
  const hashedFiles = [
    ...canonical.filter((path) => !path.includes(`${sep}test${sep}`)),
    ...entries.map((entry) => resolve(root, entry)),
  ].toSorted();
  const hash = createHash("sha256");
  for (const path of hashedFiles) {
    hash
      .update(relative(root, path))
      .update("\0")
      .update(await readFile(path))
      .update("\0");
  }
  return { path: engineering, fingerprint: hash.digest("hex"), skills: skillNames };
}
