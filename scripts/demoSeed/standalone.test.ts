import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { STANDALONE_FIXTURES, STANDALONE_OVERLAY } from "./standalone.ts";

// The standalone files restate what the monorepo gives the app. These tests fail when the two
// drift, so the demo repository keeps running the versions and settings Railhead tests it with.

const root = join(import.meta.dirname, "..", "..");
const app = join(root, "demo", "upload-app");
const fixtures = join(root, STANDALONE_FIXTURES);

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function json(path: string): Record<string, unknown> {
  // tsconfig.json allows whole-line comments; no file read here has another kind.
  const value: unknown = JSON.parse(
    read(path)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n"),
  );
  return object(value, path);
}

function object(value: unknown, field: string): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), field);
  return Object.fromEntries(Object.entries(value));
}

function strings(value: unknown, field: string): Record<string, string> {
  const entries = Object.entries(object(value, field));
  for (const [key, entry] of entries) assert.equal(typeof entry, "string", `${field}.${key}`);
  return Object.fromEntries(entries.map(([key, entry]) => [key, String(entry)]));
}

/** The `catalog:` block of the root pnpm-workspace.yaml: one `name: version` per line. */
function catalog(): Record<string, string> {
  const lines = read(join(root, "pnpm-workspace.yaml")).split("\n");
  const start = lines.indexOf("catalog:");
  assert.notEqual(start, -1, "pnpm-workspace.yaml has no catalog");
  const versions: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const entry = /^ {2}"?([^"\s:]+)"?: (\S+)$/.exec(line);
    if (entry?.[1] !== undefined && entry[2] !== undefined) versions[entry[1]] = entry[2];
  }
  return versions;
}

test("the standalone package.json pins the catalog's version of every dependency", () => {
  const versions = catalog();
  const source = json(join(app, "package.json"));
  const standalone = json(join(fixtures, "package.json"));
  const sourceDeps = strings(source["devDependencies"], "devDependencies");

  const expected: Record<string, string> = {};
  for (const [name, spec] of Object.entries(sourceDeps)) {
    // The shared tooling is replaced by the overlay's local files.
    if (spec.startsWith("workspace:")) continue;
    assert.equal(spec, "catalog:", `${name} in demo/upload-app/package.json`);
    const version = versions[name];
    assert.ok(version !== undefined, `${name} is not in the catalog`);
    expected[name] = version;
  }
  // Vitest's config imports node:*; inside the monorepo the root install provides the types.
  expected["@types/node"] = versions["@types/node"] ?? "missing";

  assert.deepEqual(strings(standalone["devDependencies"], "devDependencies"), expected);
  for (const version of Object.values(expected)) assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(standalone["dependencies"], undefined);
  assert.equal(standalone["name"], source["name"]);
  assert.equal(standalone["packageManager"], json(join(root, "package.json"))["packageManager"]);
  const scripts = strings(standalone["scripts"], "scripts");
  for (const [name, command] of Object.entries(strings(source["scripts"], "scripts"))) {
    assert.equal(scripts[name], command, `script ${name}`);
  }
});

test("the standalone pnpm settings pin and build what the monorepo's do", () => {
  const versions = catalog();
  const settings = read(join(fixtures, "pnpm-workspace.yaml"));

  assert.match(settings, new RegExp(`^ {2}vite@\\*: ${versions["vite"]}$`, "m"));
  assert.match(settings, new RegExp(`^ {2}"@types/node": ${versions["@types/node"]}$`, "m"));
  const monorepo = read(join(root, "pnpm-workspace.yaml"));
  for (const setting of [/^minimumReleaseAge: \d+$/m, /^allowBuilds:\n(?: {2}\S+: true\n)+/m]) {
    assert.equal(settings.match(setting)?.[0], monorepo.match(setting)?.[0], String(setting));
  }
});

test("the standalone tsconfig.json is the root's options plus the app's", () => {
  const rootConfig = json(join(root, "tsconfig.json"));
  const appConfig = json(join(app, "tsconfig.json"));
  const standalone = json(join(fixtures, "tsconfig.json"));

  assert.equal(appConfig["extends"], "../../tsconfig.json");
  assert.equal(standalone["extends"], undefined);
  assert.deepEqual(standalone["compilerOptions"], {
    ...object(rootConfig["compilerOptions"], "compilerOptions"),
    ...object(appConfig["compilerOptions"], "compilerOptions"),
  });
  const include = appConfig["include"];
  assert.ok(Array.isArray(include));
  assert.deepEqual(standalone["include"], [...include, "assert-workerd.ts"]);
});

test("the standalone vitest config differs from the app's only in the workerd assertion", () => {
  const source = read(join(app, "vitest.config.ts"));
  const monorepoSetup = 'setupFiles: ["@railhead/scripts/assert-workerd"]';
  assert.equal(source.split(monorepoSetup).length, 2, "the app lists the shared assertion once");

  assert.equal(
    read(join(fixtures, "vitest.config.ts")),
    source.replace(monorepoSetup, 'setupFiles: ["./assert-workerd.ts"]'),
  );
  assert.ok(
    STANDALONE_OVERLAY.some(
      (entry) => entry.path === "assert-workerd.ts" && entry.from === "scripts/assert-workerd.ts",
    ),
  );
});

/**
 * The `resolution:` line of every entry under a `packages:` key of a pnpm lockfile, in any of its
 * YAML documents, keyed by the entry's name and version. The resolution names what the store
 * holds; the other fields, such as peer ranges an override rewrites, do not change it.
 */
function lockedResolutions(path: string): Map<string, string> {
  const resolutions = new Map<string, string>();
  let inPackages = false;
  let key: string | null = null;
  for (const line of read(path).split("\n")) {
    if (/^\S/.test(line)) {
      inPackages = line === "packages:";
      key = null;
      continue;
    }
    if (!inPackages) continue;
    const entry = /^ {2}(\S.*):$/.exec(line)?.[1];
    if (entry !== undefined) {
      assert.ok(!resolutions.has(entry), `${path} locks ${entry} twice`);
      key = entry;
    } else if (line.startsWith("    resolution: ")) {
      assert.ok(key !== null, `${path}: a resolution outside a package entry`);
      resolutions.set(key, line.trim());
    }
  }
  return resolutions;
}

test("the standalone lockfile resolves only packages the root lockfile resolves, identically", () => {
  // The bundle's install test runs offline from the store the root install filled, so a package the
  // root does not lock at the same version and integrity would fail it with an unrelated error.
  const rootResolutions = lockedResolutions(join(root, "pnpm-lock.yaml"));
  const standalone = lockedResolutions(join(fixtures, "pnpm-lock.yaml"));
  const refresh = "refresh fixtures/demo/standalone/pnpm-lock.yaml (see docs/demo-seed.md)";

  // Its direct dependencies at least; a parse that found nothing would check nothing.
  assert.ok(
    standalone.has(`vitest@${catalog()["vitest"]}`),
    "the standalone lockfile lacks vitest",
  );
  for (const [key, resolution] of standalone) {
    assert.match(resolution, /^resolution: \{integrity: sha512-/, `${key} has no integrity`);
    const rootResolution = rootResolutions.get(key);
    assert.ok(rootResolution !== undefined, `${key} is not in the root lockfile; ${refresh}`);
    assert.equal(resolution, rootResolution, `${key} resolves differently; ${refresh}`);
  }
});
