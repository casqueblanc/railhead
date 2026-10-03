// Writes the secrets file `wrangler deploy --secrets-file` uploads with a Worker version. Run by
// .github/workflows/deploy.yml before the deploy, and by CI with placeholder values before the dry run.
//
//   node scripts/write-worker-secrets.mjs --config <wrangler.jsonc> --out <file> [--require <NAME>]...
//
// The secrets written are exactly the Worker config's `secrets.required`, so their names come from
// cloudflare.config.ts. The config must be one scripts/generate-worker-configs.ts wrote: `//` header
// lines, then plain JSON. Each value is read from the environment variable of the same name. A
// `--require` name, such as CLOUDFLARE_API_TOKEN, must also be set but is not written to the file.
// When any of them is unset or empty the script names every missing one and writes nothing, so a
// deploy fails before it starts.
//
// The file is JSON, created with mode 600 and never over an existing path. The caller deletes it.
// Values are never printed. Exit codes: 0 written, 1 a secret is missing, 2 the arguments, the
// config or the output path are unusable.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const NAME = /^[A-Z][A-Z0-9_]*$/;

const usage =
  "usage: node scripts/write-worker-secrets.mjs --config <wrangler.jsonc> --out <file> [--require <NAME>]...";

/** Exits with `code` after printing `message` to stderr. */
const fail = (code, message) => {
  process.stderr.write(`write-worker-secrets: ${message}\n`);
  process.exit(code);
};

let values;
try {
  ({ values } = parseArgs({
    options: {
      config: { type: "string" },
      out: { type: "string" },
      require: { type: "string", multiple: true, default: [] },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (error) {
  fail(2, `${error instanceof Error ? error.message : String(error)}\n${usage}`);
}
if (values.config === undefined || values.out === undefined) {
  fail(2, `--config and --out are required.\n${usage}`);
}

let required;
try {
  const text = readFileSync(values.config, "utf8").replace(/^(?:\/\/.*\n)*/, "");
  required = JSON.parse(text).secrets?.required ?? [];
} catch (error) {
  fail(
    2,
    `cannot read ${values.config}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
if (!Array.isArray(required) || !required.every((name) => typeof name === "string")) {
  fail(2, `${values.config}: secrets.required must be a list of names.`);
}

const invalid = [...values.require, ...required].filter((name) => !NAME.test(name));
if (invalid.length > 0) {
  fail(2, `not a secret name: ${invalid.join(", ")}`);
}

const missing = [...new Set([...values.require, ...required])].filter(
  (name) => (process.env[name] ?? "") === "",
);
if (missing.length > 0) {
  fail(1, `missing required secret(s): ${missing.join(", ")}`);
}

const secrets = Object.fromEntries(required.map((name) => [name, process.env[name]]));
try {
  writeFileSync(values.out, JSON.stringify(secrets), { flag: "wx", mode: 0o600 });
} catch (error) {
  fail(2, `cannot create ${values.out}: ${error instanceof Error ? error.message : String(error)}`);
}
process.stderr.write(
  `write-worker-secrets: wrote ${required.length} secret(s): ${required.join(", ")}\n`,
);
