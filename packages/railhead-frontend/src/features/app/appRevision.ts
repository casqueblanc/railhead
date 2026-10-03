// Which commit the deployed demo app runs, and whether that is main.
//
// The demo app is deployed by its operator, outside Railhead, and reports the main commit it was
// built from at `GET /api/revision`. The board compares that with main as the train last read it,
// so a deployment that has fallen behind main is marked stale rather than shown as main's behaviour.
// The app is reached directly from the browser; Railhead holds no binding or secret for it.

import { isCommitSha, type CommitSha } from "@railhead/shared/events";

/** Where the deployed demo app is, from the board's build configuration. */
export type AppLocation =
  | { kind: "configured"; origin: string }
  /** This board was built without an app URL. */
  | { kind: "unconfigured" }
  /** The configured value is not an http or https URL, or is the board's own origin. */
  | { kind: "invalid" };

/**
 * Reads the app's location from the build variable's value, which may be absent or malformed. The
 * board's own origin is refused: the app is embedded with scripts and its own origin allowed, which
 * is only safe while that origin is not the board's.
 */
export const appLocation = (raw: unknown, boardOrigin: string): AppLocation => {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { kind: "unconfigured" };
  }
  if (typeof raw !== "string") return { kind: "invalid" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { kind: "invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "invalid" };
  if (url.origin === boardOrigin) return { kind: "invalid" };
  return { kind: "configured", origin: url.origin };
};

/** What the deployed app said about its revision. */
export type RevisionRead =
  | { kind: "checking" }
  | { kind: "reported"; revision: CommitSha }
  /** The app answered but named no commit, such as `unknown` when deployed without one. */
  | { kind: "unreported" }
  /** The app could not be reached or did not answer as the revision route does. */
  | { kind: "unreachable" };

/** How long the board waits for the app's answer before calling it unreachable. */
export const REVISION_TIMEOUT_MS = 10_000;

/** Interprets the JSON body of `GET /api/revision`. */
export const parseRevision = (body: unknown): RevisionRead => {
  if (typeof body !== "object" || body === null || !("revision" in body)) {
    return { kind: "unreachable" };
  }
  const { revision } = body;
  if (typeof revision !== "string") return { kind: "unreachable" };
  return isCommitSha(revision) ? { kind: "reported", revision } : { kind: "unreported" };
};

/** Asks the app at `origin` for its revision. Never rejects; a failure is `unreachable`. */
export const readAppRevision = async (
  origin: string,
  fetchRevision: typeof fetch,
  signal: AbortSignal,
  timeoutMs = REVISION_TIMEOUT_MS,
): Promise<RevisionRead> => {
  try {
    const response = await fetchRevision(new URL("/api/revision", origin), {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) return { kind: "unreachable" };
    const body: unknown = await response.json();
    return parseRevision(body);
  } catch {
    return { kind: "unreachable" };
  }
};

/** Whether the deployed app shows main's behaviour. */
export type DeploymentStatus =
  | { kind: "checking" }
  /** The deployed commit is main. */
  | { kind: "current"; deployed: CommitSha }
  /** The deployed commit is not main: what the app does is not what main does. */
  | { kind: "stale"; deployed: CommitSha; main: CommitSha }
  /** The train has not read main yet, so nothing can be compared. */
  | { kind: "main_unknown"; deployed: CommitSha }
  | { kind: "unreported" }
  | { kind: "unreachable" };

/** Compares the deployed commit with `main`, the train's last read of it. */
export const deploymentStatus = (main: CommitSha | null, read: RevisionRead): DeploymentStatus => {
  switch (read.kind) {
    case "checking":
    case "unreported":
    case "unreachable":
      return read;
    case "reported":
      if (main === null) return { kind: "main_unknown", deployed: read.revision };
      return read.revision === main
        ? { kind: "current", deployed: read.revision }
        : { kind: "stale", deployed: read.revision, main };
    default:
      return unreachable(read);
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled revision read: ${JSON.stringify(value)}`);
};
