// The Rust gate: formatting, build, tests and Clippy for the Cargo workspace, run by `pnpm check`
// and by CI's Rust workflow. It stops at the first failing step and exits non-zero, so a Rust
// failure always fails the root gate. A missing `cargo` is a failure too, never a skip.
//
// `--locked` makes Cargo refuse to change `Cargo.lock`, as the pnpm side uses a frozen install.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const steps = [
  ["fmt", "--all", "--check"],
  ["check", "--workspace", "--all-targets", "--locked"],
  ["test", "--workspace", "--locked"],
  ["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"],
];

for (const args of steps) {
  const command = `cargo ${args.join(" ")}`;
  process.stdout.write(`> ${command}\n`);
  const result = spawnSync("cargo", args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`rust-check: could not run ${command}: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    const reason =
      result.signal === null ? `exit code ${result.status}` : `signal ${result.signal}`;
    process.stderr.write(`rust-check: ${command} failed with ${reason}\n`);
    process.exit(1);
  }
}

process.stdout.write("Rust workspace checks passed.\n");
