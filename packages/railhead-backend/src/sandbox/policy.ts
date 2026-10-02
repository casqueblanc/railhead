// What one sandbox may do on the network. A sandbox starts with the internet off; every HTTP and
// HTTPS request it makes reaches the Git gateway, which forwards only Git smart-HTTP to the
// Artifacts host and repositories its policy names. A policy is set per admitted attempt and never
// grants a write outside the candidate refs, so a sandbox cannot move main or a fork's branch.

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
  /** Repositories the sandbox may fetch from. */
  read: string[];
  /** The one repository it may push to and the ref prefix it may create or update, or `null`. */
  write: { repo: string; refPrefix: string } | null;
}

const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Validates `value` as a policy and returns it, or `null`. A write prefix must be one segment
 * under `CANDIDATE_REF_PREFIX` ending in `/`, so no policy can name main or another branch.
 */
export function parseSandboxPolicy(value: unknown): SandboxPolicy | null {
  if (!isRecord(value)) return null;
  const { host, namespace, read, write } = value;
  if (typeof host !== "string" || !HOST.test(host)) return null;
  if (typeof namespace !== "string" || !NAME.test(namespace)) return null;
  if (!Array.isArray(read) || read.length > MAX_POLICY_REPOS) return null;
  const repos: string[] = [];
  for (const repo of read) {
    if (typeof repo !== "string" || !NAME.test(repo) || repos.includes(repo)) return null;
    repos.push(repo);
  }
  if (write === null) return { host, namespace, read: repos, write: null };
  if (!isRecord(write)) return null;
  const { repo, refPrefix } = write;
  if (typeof repo !== "string" || !NAME.test(repo)) return null;
  if (typeof refPrefix !== "string" || !isCandidatePrefix(refPrefix)) return null;
  return { host, namespace, read: repos, write: { repo, refPrefix } };
}

function isCandidatePrefix(prefix: string): boolean {
  if (!prefix.startsWith(CANDIDATE_REF_PREFIX) || !prefix.endsWith("/")) return false;
  return REF_SEGMENT.test(prefix.slice(CANDIDATE_REF_PREFIX.length, -1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
