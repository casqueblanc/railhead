import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePolicy } from "./policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !/^[a-f0-9]{64}$/.test(args[0]))) {
    throw new Error("Usage: pnpm run-start [64-character engineering fingerprint]");
  }
  const snapshot = await validatePolicy(root);
  if (args[0] && args[0] !== snapshot.fingerprint) {
    throw new Error(
      `Engineering policy mismatch: expected ${args[0]}, found ${snapshot.fingerprint}`,
    );
  }
  process.stdout.write(`${JSON.stringify(snapshot)}\n\n`);
  for (const name of ["working", "writing"]) {
    const path = resolve(snapshot.path, "skills", `railhead-${name}`, "SKILL.md");
    process.stdout.write(`${await readFile(path, "utf8")}\n`);
  }
} catch (error) {
  process.stderr.write(
    `Engineering startup failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
