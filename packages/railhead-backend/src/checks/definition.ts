// The trusted check definition: one JSON file read from main, never from the candidate it checks.
//
// `.railhead/check.json` names the check, the command the sandbox runs, how long that command may
// take, the paths whose edits need a person, and, for an acceptance check, the decision version and
// option it proves:
//
//   {
//     "name": "test",
//     "command": "pnpm install --frozen-lockfile && pnpm test",
//     "timeoutMs": 600000,
//     "protect": ["acceptance"],
//     "acceptance": { "decisionId": "dec_…", "version": 2, "option": "B" }
//   }
//
// The file is repository content: it is parsed as untrusted JSON, every field is bounded, and an
// unknown field refuses the whole file. Its own path is always protected, so a candidate that edits
// the definition, or any protected path, is held for a person instead of being checked. Edits are
// found by comparing Git object hashes on main and the candidate, never from a diff an agent sent.

import { isCommitSha, isId, MAX_CHECK_NAME_LENGTH, type CommitSha } from "@railhead/shared/events";
import type { CheckDefinition } from "../contracts/train";
import { hex, sha256 } from "../modules/owner/encoding";

/** Where the definition lives in the repository. */
export const CHECK_DEFINITION_PATH = ".railhead/check.json";

/** The largest definition file read. */
export const MAX_DEFINITION_BYTES = 16 * 1024;

/** The longest command a definition may name, in characters. */
export const MAX_COMMAND_LENGTH = 4_096;

/** The shortest time a definition may give its command. */
export const MIN_CHECK_TIMEOUT_MS = 10_000;

/**
 * The longest time a definition may give its command. With the checkout and teardown around it,
 * the run still fits the longest sandbox lifetime.
 */
export const MAX_CHECK_TIMEOUT_MS = 20 * 60_000;

/** The most protected paths a definition may list, besides its own. */
export const MAX_PROTECTED_PATHS = 32;

/** The longest protected path, in characters. */
export const MAX_PROTECTED_PATH_LENGTH = 256;

/** A check definition from main, with what the runner needs to run it. */
export interface TrustedCheck {
  /** The definition the train records. */
  definition: CheckDefinition;
  /** The shell command the sandbox runs. */
  command: string;
  /** How long the command may run. */
  timeoutMs: number;
  /** Paths whose edit holds a candidate for a person, the definition's own path first. */
  protectedPaths: string[];
}

const DEFINITION_KEYS = new Set(["name", "command", "timeoutMs", "protect", "acceptance"]);
const ACCEPTANCE_KEYS = new Set(["decisionId", "version", "option"]);
const OPTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Parses the definition file read from `source`, or returns `null` when it is not a valid
 * definition. The digest is SHA-256 of the exact bytes, so a run can prove which definition it used.
 */
export async function parseTrustedCheck(
  bytes: Uint8Array,
  source: CommitSha,
): Promise<TrustedCheck | null> {
  if (!isCommitSha(source) || bytes.byteLength > MAX_DEFINITION_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(value) || !onlyKeys(value, DEFINITION_KEYS)) return null;
  const { name, command, timeoutMs, protect } = value;
  if (typeof name !== "string" || name.trim() === "" || name.length > MAX_CHECK_NAME_LENGTH) {
    return null;
  }
  if (
    typeof command !== "string" ||
    command.trim() === "" ||
    command.length > MAX_COMMAND_LENGTH ||
    command.includes("\0")
  ) {
    return null;
  }
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_CHECK_TIMEOUT_MS ||
    timeoutMs > MAX_CHECK_TIMEOUT_MS
  ) {
    return null;
  }
  const paths = parseProtected(protect);
  if (paths === null) return null;
  const acceptance = parseAcceptance(value["acceptance"]);
  if (acceptance === undefined) return null;
  return {
    definition: { name, source, digest: await sha256Hex(bytes), acceptance },
    command,
    timeoutMs,
    protectedPaths: [CHECK_DEFINITION_PATH, ...paths.filter((p) => p !== CHECK_DEFINITION_PATH)],
  };
}

/** SHA-256 of `bytes`, as 64 lowercase hexadecimal characters. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await sha256(bytes));
}

function parseProtected(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PROTECTED_PATHS) return null;
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isProtectedPath(item)) return null;
    if (!paths.includes(item)) paths.push(item);
  }
  return paths;
}

/** A relative path of plain segments: no `.`, `..`, empty segment or leading or trailing `/`. */
function isProtectedPath(path: string): boolean {
  if (path === "" || path.length > MAX_PROTECTED_PATH_LENGTH) return false;
  return path
    .split("/")
    .every((segment) => PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..");
}

// `undefined` refuses the definition; `null` means it is not an acceptance check.
function parseAcceptance(value: unknown): CheckDefinition["acceptance"] | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !onlyKeys(value, ACCEPTANCE_KEYS)) return undefined;
  const { decisionId, version, option } = value;
  if (typeof decisionId !== "string" || !isId("decision", decisionId)) return undefined;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    return undefined;
  }
  if (typeof option !== "string" || !OPTION.test(option)) return undefined;
  return { decision: { decisionId, version }, option };
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One entry of a Git tree, as Artifacts reads it. */
export interface TreeEntry {
  /** The entry's name in its tree. */
  name: string;
  /** Its object hash. */
  hash: string;
  /** Whether it is a tree, a file or another kind of entry. */
  type: string;
}

/** Reads Git objects of one repository by hash. */
export interface TreeReader {
  /** The commit's root tree hash, or `null` when the commit is missing. */
  rootTree(commit: CommitSha): Promise<string | null>;
  /** The entries of a tree, or `null` when it is missing. */
  readTree(hash: string): Promise<TreeEntry[] | null>;
}

/** Most trees read while comparing one path. Every protected path is at most this deep. */
const MAX_PATH_DEPTH = 32;

/**
 * The protected paths that differ between two commits' trees: added, removed or changed. A path is
 * compared by the hash of the object it names, so a protected directory differs when anything under
 * it does. Throws when a tree the commits name cannot be read.
 */
export async function editedPaths(
  reader: TreeReader,
  mainTree: string,
  candidateTree: string,
  paths: readonly string[],
): Promise<string[]> {
  const edited: string[] = [];
  for (const path of paths) {
    const [before, after] = await Promise.all([
      objectAt(reader, mainTree, path),
      objectAt(reader, candidateTree, path),
    ]);
    if (before !== after) edited.push(path);
  }
  return edited;
}

// The hash of the object `path` names under `tree`, with its type, or `null` when nothing is there.
async function objectAt(reader: TreeReader, tree: string, path: string): Promise<string | null> {
  const segments = path.split("/");
  if (segments.length > MAX_PATH_DEPTH) throw new Error("protected path is too deep");
  let current = tree;
  for (const [index, segment] of segments.entries()) {
    const entries = await reader.readTree(current);
    if (entries === null) throw new Error("a tree the commit names is missing");
    const entry = entries.find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return `${entry.type}:${entry.hash}`;
    if (entry.type !== "tree") return null;
    current = entry.hash;
  }
  return null;
}
