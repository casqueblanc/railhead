// The demo seed's manifest, `fixtures/demo/seed.json`: the one Railhead repository the seed may
// touch, the app directory its history is imported from, three issues for agents and the one
// decision two of them are meant to collide on.
//
// The file is data read from disk, so it is parsed from `unknown` and every field is checked. The
// limits restate those of `@railhead/shared/events` and `agent-api`, which this package cannot
// import under plain `node`.

import { readFileSync } from "node:fs";

/** The only organisation the seed and reset commands may touch. */
export const DEMO_ORG = "demo";
/** The only repository they may touch: the board's default, A35's `DEFAULT_BOARD_REPO`. */
export const DEMO_REPO = "upload-app";

/** `MAX_TITLE_LENGTH` in `@railhead/shared/events`. */
const MAX_TITLE_LENGTH = 256;
/** `MAX_ISSUE_BODY_LENGTH` in `@railhead/shared/events`. */
const MAX_ISSUE_BODY_LENGTH = 16 * 1024;
/** `MAX_QUESTION_LENGTH` in `@railhead/shared/events`. */
const MAX_QUESTION_LENGTH = 2000;
/** `MAX_OPTION_LABEL_LENGTH` in `@railhead/shared/events`. */
const MAX_OPTION_LABEL_LENGTH = 200;
/** `MAX_LIST_LENGTH` in `@railhead/shared/events`. */
const MAX_LIST_LENGTH = 64;
/** The demo has exactly this many agent tasks: one per seeded agent. */
export const ISSUE_COUNT = 3;

const SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const OPTION_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const DECISION_KEY = /^[a-z][a-z0-9-]{0,63}$/;
// Relative, slash-separated, no empty, `.` or `..` segment and no control character.
const UNPRINTABLE = /[\p{Cc}\p{Cs}]/u;

/** One answer the decision offers. */
export interface SeedOption {
  readonly key: string;
  readonly label: string;
}

/** The decision two of the issues collide on. Agents open it by asking; the seed never does. */
export interface SeedDecision {
  /** The `decision` key in the app's `acceptance/checks.json`. */
  readonly key: string;
  readonly question: string;
  readonly options: readonly SeedOption[];
  /** The repository paths its answer applies to. */
  readonly scope: readonly string[];
}

/** One issue the seed files. Its title identifies it when the seed reconciles. */
export interface SeedIssue {
  readonly title: string;
  readonly body: string;
  /** The paths the task is expected to change; the collision check compares them to the scope. */
  readonly touches: readonly string[];
}

/** The parsed manifest. */
export interface SeedManifest {
  readonly org: string;
  readonly repo: string;
  /** The app's directory, relative to the source repository's root. */
  readonly source: string;
  readonly decision: SeedDecision;
  readonly issues: readonly SeedIssue[];
}

/** A manifest, a target or a command that the seed refuses. */
export class SeedRefusal extends Error {
  override readonly name = "SeedRefusal";
}

/**
 * Refuses any target other than the demo repository. Every command calls it before planning, so
 * a typo or a borrowed manifest cannot point the seed or reset at another repository.
 */
export function assertDemoTarget(org: string, repo: string): void {
  if (org !== DEMO_ORG || repo !== DEMO_REPO) {
    throw new SeedRefusal(
      `The demo seed only touches ${DEMO_ORG}/${DEMO_REPO}; refusing ${JSON.stringify(`${org}/${repo}`)}.`,
    );
  }
}

/** Reads and validates the manifest at `path`. */
export function loadManifest(path: string): SeedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SeedRefusal(`Cannot read the manifest at ${path}.`, { cause: error });
  }
  return parseManifest(parsed);
}

/** Validates a parsed manifest. Throws `SeedRefusal` naming the first problem. */
export function parseManifest(value: unknown): SeedManifest {
  const root = record(value, "manifest");
  const org = text(root, "org", 64);
  const repo = text(root, "repo", 64);
  if (!SEGMENT.test(org) || !SEGMENT.test(repo)) {
    throw new SeedRefusal("org and repo must be repository segments.");
  }
  assertDemoTarget(org, repo);
  const source = repoPath(text(root, "source", 1024), "source");

  const decisionRecord = record(root["decision"], "decision");
  const key = text(decisionRecord, "key", 64);
  if (!DECISION_KEY.test(key)) throw new SeedRefusal("decision.key is not a decision key.");
  const options = list(decisionRecord["options"], "decision.options").map((entry, index) => {
    const option = record(entry, `decision.options[${index}]`);
    const optionKey = text(option, "key", 32);
    if (!OPTION_KEY.test(optionKey)) {
      throw new SeedRefusal(`decision.options[${index}].key is not an option key.`);
    }
    return { key: optionKey, label: text(option, "label", MAX_OPTION_LABEL_LENGTH) };
  });
  if (options.length < 2) throw new SeedRefusal("decision.options needs at least two options.");
  unique(
    options.map((option) => option.key),
    "decision.options keys",
  );
  const decision: SeedDecision = {
    key,
    question: text(decisionRecord, "question", MAX_QUESTION_LENGTH),
    options,
    scope: paths(decisionRecord["scope"], "decision.scope"),
  };

  const issues = list(root["issues"], "issues").map((entry, index) => {
    const issue = record(entry, `issues[${index}]`);
    return {
      title: text(issue, "title", MAX_TITLE_LENGTH),
      body: text(issue, "body", MAX_ISSUE_BODY_LENGTH),
      touches: paths(issue["touches"], `issues[${index}].touches`),
    };
  });
  if (issues.length !== ISSUE_COUNT) {
    throw new SeedRefusal(`issues must hold exactly ${ISSUE_COUNT} tasks, one per demo agent.`);
  }
  unique(
    issues.map((issue) => issue.title),
    "issue titles",
  );

  // The collision is the point of the demo: two agents working on separate issues reach the same
  // decision, so its answer, and a later change of answer, must reach both of them.
  const colliding = issues.filter((issue) => overlaps(issue.touches, decision.scope));
  if (colliding.length !== 2) {
    throw new SeedRefusal(
      `Exactly two issues must touch the decision's scope; ${colliding.length} do.`,
    );
  }
  return { org, repo, source, decision, issues };
}

/**
 * Checks the decision against the app's `acceptance/checks.json`: the same decision key, and an
 * option for every tagged acceptance suite, so the check the train runs can follow the answer.
 */
export function assertMatchesChecks(manifest: SeedManifest, checks: unknown): void {
  const root = record(checks, "checks.json");
  if (root["decision"] !== manifest.decision.key) {
    throw new SeedRefusal("checks.json names a different decision than the manifest.");
  }
  const offered = new Set(manifest.decision.options.map((option) => option.key));
  for (const [index, entry] of list(root["suites"], "checks.json suites").entries()) {
    const option = record(entry, `checks.json suites[${index}]`)["option"];
    if (typeof option !== "string" || !offered.has(option)) {
      throw new SeedRefusal(`checks.json suites[${index}] tags an option the decision lacks.`);
    }
  }
}

/** True when a path in `touches` is in `scope`, or below a scope directory. */
export function overlaps(touches: readonly string[], scope: readonly string[]): boolean {
  return touches.some((touched) =>
    scope.some((scoped) => touched === scoped || touched.startsWith(`${scoped}/`)),
  );
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SeedRefusal(`${field} must be an object.`);
  }
  // A JSON object parsed from text is a plain record; the checks above rule out every other shape.
  return value as Record<string, unknown>;
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new SeedRefusal(`${field} must be a list.`);
  if (value.length > MAX_LIST_LENGTH) {
    throw new SeedRefusal(`${field} holds more than ${MAX_LIST_LENGTH} entries.`);
  }
  return value;
}

function text(parent: Record<string, unknown>, field: string, max: number): string {
  const value = parent[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new SeedRefusal(`${field} must be non-blank text.`);
  }
  if (value.length > max) throw new SeedRefusal(`${field} is longer than ${max} characters.`);
  return value;
}

function paths(value: unknown, field: string): string[] {
  const entries = list(value, field).map((entry, index) => {
    if (typeof entry !== "string") throw new SeedRefusal(`${field}[${index}] must be a path.`);
    return repoPath(entry, `${field}[${index}]`);
  });
  if (entries.length === 0) throw new SeedRefusal(`${field} must name at least one path.`);
  unique(entries, field);
  return entries;
}

function repoPath(value: string, field: string): string {
  const valid =
    value !== "" &&
    !UNPRINTABLE.test(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (!valid) throw new SeedRefusal(`${field} is not a relative repository path.`);
  return value;
}

function unique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new SeedRefusal(`${field} must not repeat.`);
  }
}
