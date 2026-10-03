// The demo seed's manifest, `fixtures/demo/seed.json`: the one Railhead repository the seed may
// touch, the app directory its history is imported from, three issues for agents and the one
// decision two of them are meant to collide on.
//
// The file is data read from disk, so it is parsed from `unknown` and every field is checked. The
// limits restate those of `@railhead/shared/events` and `agent-api`, which this package cannot
// import under plain `node`. The decision must pass the agent wire's `ask` rules, since an agent
// opens it by asking; `manifest.test.ts` checks the restated rules against the shared source and
// the wire fixtures.

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
/** `MIN_OPTIONS` in `@railhead/shared/events`. */
export const MIN_OPTIONS = 2;
/** `MAX_OPTIONS` in `@railhead/shared/events`. */
export const MAX_OPTIONS = 8;
/** `MAX_PATH_LENGTH` in `@railhead/shared/events`. */
export const MAX_PATH_LENGTH = 1024;
/** `MAX_SCOPE_BYTES` in `@railhead/shared/agent-api`. */
export const MAX_SCOPE_BYTES = 8 * 1024;
/** The demo has exactly this many agent tasks: one per seeded agent. */
export const ISSUE_COUNT = 3;

const SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** `OPTION_KEY` in `@railhead/shared/events` and `agent-api`: lowercase only. */
export const OPTION_KEY = /^[a-z][a-z0-9_]{0,31}$/;
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
    const optionKey = option["key"];
    const label = option["label"];
    if (typeof optionKey !== "string" || typeof label !== "string") {
      throw new SeedRefusal(`decision.options[${index}] needs a key and a label.`);
    }
    return { key: optionKey, label };
  });
  const question = decisionRecord["question"];
  const scope = list(decisionRecord["scope"], "decision.scope").map((entry, index) => {
    if (typeof entry !== "string")
      throw new SeedRefusal(`decision.scope[${index}] must be a path.`);
    return entry;
  });
  if (typeof question !== "string") throw new SeedRefusal("decision.question must be text.");
  assertAskable({ text: question, options, scope });
  unique(scope, "decision.scope");
  const decision: SeedDecision = { key, question, options, scope };

  const issues = list(root["issues"], "issues").map((entry, index) => {
    const issue = record(entry, `issues[${index}]`);
    const title = text(issue, "title", MAX_TITLE_LENGTH);
    const body = text(issue, "body", MAX_ISSUE_BODY_LENGTH);
    // The seed prints both for the owner to copy, so neither may carry a terminal control.
    if (UNPRINTABLE.test(title) || body.split("\n").some((line) => UNPRINTABLE.test(line))) {
      throw new SeedRefusal(
        `issues[${index}] holds a control character; only a body may break lines.`,
      );
    }
    return {
      title,
      body,
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

/** An agent's question as the wire carries it: `AskRequest`'s `text`, `options` and `scope`. */
export interface Ask {
  readonly text: string;
  readonly options: readonly SeedOption[];
  readonly scope: readonly string[];
}

/**
 * Applies the agent wire's `ask` invariants (`validateAgentRequest` in `@railhead/shared/agent-api`)
 * to a question, so the manifest cannot prescribe a decision no agent could open.
 */
export function assertAskable(ask: Ask): void {
  if (ask.text.trim() === "") throw new SeedRefusal("decision.question must be non-blank text.");
  if (ask.text.length > MAX_QUESTION_LENGTH) {
    throw new SeedRefusal(`decision.question is longer than ${MAX_QUESTION_LENGTH} characters.`);
  }
  if (ask.options.length < MIN_OPTIONS || ask.options.length > MAX_OPTIONS) {
    throw new SeedRefusal(
      `decision.options must hold between ${MIN_OPTIONS} and ${MAX_OPTIONS} options.`,
    );
  }
  unique(
    ask.options.map((option) => option.key),
    "decision.options keys",
  );
  for (const [index, option] of ask.options.entries()) {
    if (!OPTION_KEY.test(option.key)) {
      throw new SeedRefusal(`decision.options[${index}].key is not an option key.`);
    }
    if (option.label.trim() === "" || option.label.length > MAX_OPTION_LABEL_LENGTH) {
      throw new SeedRefusal(`decision.options[${index}].label is blank or too long.`);
    }
  }
  if (ask.scope.length === 0 || ask.scope.length > MAX_LIST_LENGTH) {
    throw new SeedRefusal(`decision.scope must hold between 1 and ${MAX_LIST_LENGTH} paths.`);
  }
  for (const [index, path] of ask.scope.entries()) {
    if (path.trim() === "" || path.length > MAX_PATH_LENGTH) {
      throw new SeedRefusal(`decision.scope[${index}] is not a relative repository path.`);
    }
    repoPath(path, `decision.scope[${index}]`);
  }
  if (Buffer.byteLength(JSON.stringify(ask.scope), "utf8") > MAX_SCOPE_BYTES) {
    throw new SeedRefusal(`decision.scope is larger than ${MAX_SCOPE_BYTES} bytes.`);
  }
}

/**
 * Checks the decision against the app's `acceptance/checks.json`: the same decision key, a suite
 * for every option and an option for every suite, and a suite tagged with the option and version
 * in force, so the check the train runs can follow any answer and the current one can start.
 */
export function assertMatchesChecks(manifest: SeedManifest, checks: unknown): void {
  const root = record(checks, "checks.json");
  if (root["decision"] !== manifest.decision.key) {
    throw new SeedRefusal("checks.json names a different decision than the manifest.");
  }
  const offered = new Set(manifest.decision.options.map((option) => option.key));
  const tagged = new Set<string>();
  const versions = new Set<string>();
  for (const [index, entry] of list(root["suites"], "checks.json suites").entries()) {
    const suite = record(entry, `checks.json suites[${index}]`);
    const option = suite["option"];
    if (typeof option !== "string" || !offered.has(option)) {
      throw new SeedRefusal(`checks.json suites[${index}] tags an option the decision lacks.`);
    }
    tagged.add(option);
    versions.add(`${option}@${String(suite["version"])}`);
  }
  for (const option of offered) {
    if (!tagged.has(option)) {
      throw new SeedRefusal(`The decision offers ${option}, which no checks.json suite tags.`);
    }
  }
  const current = record(root["current"], "checks.json current");
  const option = current["option"];
  if (typeof option !== "string" || !offered.has(option)) {
    throw new SeedRefusal("checks.json current names an option the decision lacks.");
  }
  const version = current["version"];
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0) {
    throw new SeedRefusal("checks.json current.version must be a positive integer.");
  }
  if (!versions.has(`${option}@${version}`)) {
    throw new SeedRefusal(
      `checks.json has no suite tagged ${option}@${version}, the one in force.`,
    );
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
