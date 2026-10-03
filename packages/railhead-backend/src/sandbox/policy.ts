// What one sandbox may do on the network. A sandbox starts with the internet off; every HTTP and
// HTTPS request it makes reaches the Git gateway, which forwards only Git smart-HTTP to the
// Artifacts host and repositories its policy names. A policy is set per admitted attempt and never
// grants a write outside the candidate refs, so a sandbox cannot move main or a fork's branch. A
// delete is granted separately, under one named candidate prefix, so only a sandbox admitted to
// discard an attempt's candidates can remove refs, and only that attempt's.

/** The only refs a sandbox may push: candidates, each attempt under its own prefix. */
export const CANDIDATE_REF_PREFIX = "refs/heads/candidate/";

/** The most repositories one policy may name, so a policy stays small enough to pass per call. */
export const MAX_POLICY_REPOS = 16;

/** One sandbox's network policy. */
export interface SandboxPolicy {
  /** The Artifacts Git host, such as `<account>.artifacts.cloudflare.net`. No other host answers. */
  host: string;
  /** The Artifacts namespace every repository below belongs to. */
  namespace: string;
  /** The only repositories the sandbox may fetch from, including one it may push to or delete in. */
  read: string[];
  /** The one repository it may push to and the ref prefix it may create or update, or `null`. */
  write: RefGrant | null;
  /** The one repository and candidate prefix it may delete refs under. Absent, it deletes nothing. */
  discard?: RefGrant;
}

/** One repository and the candidate ref prefix a grant covers. */
export interface RefGrant {
  /** The repository. */
  repo: string;
  /** One segment under `CANDIDATE_REF_PREFIX`, ending in `/`. */
  refPrefix: string;
}

const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Validates `value` as a policy and returns it, or `null`. A write or discard prefix must be one
 * segment under `CANDIDATE_REF_PREFIX` ending in `/`, so no policy can name main or another branch.
 */
export function parseSandboxPolicy(value: unknown): SandboxPolicy | null {
  if (!isRecord(value)) return null;
  const { host, namespace, read, write, discard } = value;
  if (typeof host !== "string" || !HOST.test(host)) return null;
  if (typeof namespace !== "string" || !NAME.test(namespace)) return null;
  if (!Array.isArray(read) || read.length > MAX_POLICY_REPOS) return null;
  const repos: string[] = [];
  for (const repo of read) {
    if (typeof repo !== "string" || !NAME.test(repo) || repos.includes(repo)) return null;
    repos.push(repo);
  }
  const writeGrant = write === null ? null : parseRefGrant(write);
  if (write !== null && writeGrant === null) return null;
  const policy: SandboxPolicy = { host, namespace, read: repos, write: writeGrant };
  if (discard === undefined) return policy;
  const discardGrant = parseRefGrant(discard);
  return discardGrant === null ? null : { ...policy, discard: discardGrant };
}

function parseRefGrant(value: unknown): RefGrant | null {
  if (!isRecord(value)) return null;
  const { repo, refPrefix } = value;
  if (typeof repo !== "string" || !NAME.test(repo)) return null;
  if (typeof refPrefix !== "string" || !isCandidatePrefix(refPrefix)) return null;
  return { repo, refPrefix };
}

/**
 * What one sandbox's outbound handler receives: its policy and the moment it lapses, in milliseconds
 * since the Unix epoch. The gateway refuses everything once `expiresAt` has passed, so a container
 * that outlives its deadline holds no Git authority.
 */
export interface SandboxGrant {
  /** What the sandbox may reach. */
  policy: SandboxPolicy;
  /** When the grant lapses: the sandbox's deadline. */
  expiresAt: number;
}

/**
 * Validates `value` as a grant and returns it, or `null`. Whether it has lapsed is for the caller to
 * check, each time it is about to use it.
 */
export function parseSandboxGrant(value: unknown): SandboxGrant | null {
  if (!isRecord(value)) return null;
  const { expiresAt } = value;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)) return null;
  const policy = parseSandboxPolicy(value["policy"]);
  return policy === null ? null : { policy, expiresAt };
}

function isCandidatePrefix(prefix: string): boolean {
  if (!prefix.startsWith(CANDIDATE_REF_PREFIX) || !prefix.endsWith("/")) return false;
  return REF_SEGMENT.test(prefix.slice(CANDIDATE_REF_PREFIX.length, -1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
