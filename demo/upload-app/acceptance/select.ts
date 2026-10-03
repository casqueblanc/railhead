/**
 * Chooses which acceptance suite a check run executes. The suites and the option currently in force
 * are declared in `checks.json`, read from trusted main; a run may name another suite explicitly
 * through {@link SUITE_ENV}, but never skips one: an unknown or malformed selection is an error.
 */

/** A decision option the demo app has an acceptance suite for. */
export type UploadOption = "a" | "b";

/** One acceptance suite, tagged with its decision option and the decision version that chose it. */
export interface AcceptanceSuite {
  option: UploadOption;
  version: number;
  /** Path relative to the app root. */
  file: string;
}

/** The parsed contents of `checks.json`. */
export interface CheckDefinitions {
  decision: string;
  current: { option: UploadOption; version: number };
  suites: AcceptanceSuite[];
}

/** Names a suite as `<option>@<version>`, for example `b@2`. Unset selects the current option. */
export const SUITE_ENV = "UPLOAD_ACCEPTANCE";

const SELECTION = /^([ab])@([1-9]\d{0,8})$/;
const SUITE_FILE = /^acceptance\/[a-z0-9-]+\.test\.ts$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOption(value: unknown, where: string): UploadOption {
  if (value === "a" || value === "b") return value;
  throw new TypeError(`${where}: option must be "a" or "b".`);
}

function parseVersion(value: unknown, where: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new TypeError(`${where}: version must be a positive integer.`);
}

/** Validates `checks.json`: known options, positive versions, unique tags, a current suite. */
export function parseCheckDefinitions(value: unknown): CheckDefinitions {
  if (!isRecord(value)) throw new TypeError("checks.json must be an object.");
  const { decision, current, suites } = value;
  if (typeof decision !== "string" || decision.length === 0) {
    throw new TypeError("checks.json: decision must be a non-empty string.");
  }
  if (!isRecord(current)) throw new TypeError("checks.json: current must be an object.");
  if (!Array.isArray(suites) || suites.length === 0) {
    throw new TypeError("checks.json: suites must be a non-empty array.");
  }
  const parsed = suites.map((suite: unknown, index): AcceptanceSuite => {
    const where = `checks.json suites[${index}]`;
    if (!isRecord(suite)) throw new TypeError(`${where} must be an object.`);
    if (typeof suite.file !== "string" || !SUITE_FILE.test(suite.file)) {
      throw new TypeError(`${where}: file must be acceptance/<name>.test.ts.`);
    }
    return {
      option: parseOption(suite.option, where),
      version: parseVersion(suite.version, where),
      file: suite.file,
    };
  });
  const tags = new Set(parsed.map((suite) => `${suite.option}@${suite.version}`));
  if (tags.size !== parsed.length) throw new TypeError("checks.json: suite tags must be unique.");
  const definitions: CheckDefinitions = {
    decision,
    current: {
      option: parseOption(current.option, "checks.json current"),
      version: parseVersion(current.version, "checks.json current"),
    },
    suites: parsed,
  };
  findSuite(definitions, definitions.current.option, definitions.current.version);
  return definitions;
}

function findSuite(
  definitions: CheckDefinitions,
  option: UploadOption,
  version: number,
): AcceptanceSuite {
  const suite = definitions.suites.find((s) => s.option === option && s.version === version);
  if (suite === undefined) {
    throw new Error(`No acceptance suite is tagged ${option}@${version} in checks.json.`);
  }
  return suite;
}

/**
 * The suite a run executes: the one named by `selection`, or the current option's when
 * `selection` is unset or empty.
 */
export function selectSuite(
  definitions: CheckDefinitions,
  selection: string | undefined,
): AcceptanceSuite {
  if (selection === undefined || selection === "") {
    return findSuite(definitions, definitions.current.option, definitions.current.version);
  }
  const match = SELECTION.exec(selection);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`${SUITE_ENV} must look like a@1, got ${JSON.stringify(selection)}.`);
  }
  return findSuite(definitions, parseOption(match[1], SUITE_ENV), Number(match[2]));
}

/** The title every test in `suite` runs under, carrying its decision, option and version. */
export function suiteTitle(definitions: CheckDefinitions, suite: AcceptanceSuite): string {
  return `${definitions.decision} option ${suite.option} v${suite.version}`;
}
