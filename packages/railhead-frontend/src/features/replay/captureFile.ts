// The replay capture file: one repository's event log, written by `scripts/capture-replay.mjs` and
// opened by the board's replay page.
//
// A capture holds the events and what a person needs to tell where they came from, nothing else. It
// is built by copying each known field of each event, so a field the log never defined, or anything
// else the reader happened to hold, cannot reach the file. Events carry no token, key or other
// secret by contract (`@railhead/shared/events`), and the capture reads the public board log, so
// the script needs no credential and the file records none.
//
// Opening a file is the trust boundary: its text is untrusted. `parseCapture` establishes every
// shape with the same field-by-field copy, then refuses anything a replay could misrepresent: an
// unknown format or version, a log that does not start at 1, a gap or reordering, an event from
// another repository, an event `validateEvent` refuses, a head that disagrees with the events, or a
// file past the size bounds. The board has no generated validator in the browser, which is why
// these shape checks are written out here.
//
// `source` says how the log was made. `captured` means the capture script read it from a running
// Railhead; `synthetic` means it was built from hand-written development fixtures and must never be
// presented as a run.
//
// This module imports nothing but `@railhead/shared/events`, so the capture script can load it
// under `node` directly.

import {
  EVENT_SCHEMA_VERSION,
  validateEvent,
  type Actor,
  type DecisionRef,
  type EventPayload,
  type EventType,
  type InboxEntry,
  type QuestionOption,
  type RailheadEvent,
  type RepoId,
} from "@railhead/shared/events";

/** The `format` field of every capture file. */
export const CAPTURE_FORMAT = "railhead.replay";

/** The capture file version this module reads and writes. */
export const CAPTURE_VERSION = 1;

/**
 * Most events one capture may hold. A longer log is refused rather than truncated.
 *
 * Bounded by the board's fold, which copies a whole record for each event it adds to it, so opening
 * a log costs time quadratic in its length. Measured in Node on an M-series Mac with a log of only
 * `issue.filed` events, the worst case: 62 ms at 1,000 events, 347 ms at 2,000, 2.3 s at 5,000 and
 * 46 s at 20,000. Raise this only once the fold is linear.
 */
export const MAX_CAPTURE_EVENTS = 2_000;

/** Most bytes of UTF-8 JSON one capture file may hold. */
export const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

/** Longest origin, organisation, repository name or synthetic description a capture records. */
export const MAX_SOURCE_TEXT_LENGTH = 256;

/** Largest time in milliseconds a `Date` can hold; a later one would break the page's clock. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/** Events requested per page while capturing; the board API serves at most 256. */
export const CAPTURE_PAGE_SIZE = 256;

/** How the log in a capture was made. */
export type CaptureSource =
  /** Read from a running Railhead by the capture script. */
  | { kind: "captured"; origin: string; org: string; name: string; capturedAt: number }
  /** Built from hand-written development fixtures. Never a run. */
  | { kind: "synthetic"; description: string };

/** A capture file's content. */
export interface Capture {
  format: typeof CAPTURE_FORMAT;
  version: typeof CAPTURE_VERSION;
  source: CaptureSource;
  /** The repository whose log this is. */
  repo: RepoId;
  /** The `seq` of the last event; the events run from 1 to `head` without a gap. */
  head: number;
  events: RailheadEvent[];
}

/** Why a capture could not be read or written. */
export type CaptureError =
  /** The file is larger than `MAX_CAPTURE_BYTES`, or the log longer than `MAX_CAPTURE_EVENTS`. */
  | { kind: "too_large" }
  /** The file is not JSON. */
  | { kind: "not_json" }
  /** The file is JSON but not a Railhead capture. */
  | { kind: "wrong_format" }
  /** The capture uses a file version this board cannot read. */
  | { kind: "unsupported_version"; version: number }
  /** A field is missing or has the wrong type. `path` names it. */
  | { kind: "malformed"; path: string }
  /** The capture holds no events. */
  | { kind: "empty" }
  /** An event is not where the gapless log puts it. */
  | { kind: "gap"; expected: number; found: number }
  /** An event belongs to another repository. */
  | { kind: "foreign_repo"; seq: number }
  /** An event breaks an invariant `validateEvent` checks. */
  | { kind: "invalid_event"; seq: number; message: string }
  /** `head` disagrees with the last event. */
  | { kind: "head_mismatch"; head: number; last: number }
  /** The backend refused a page while capturing. `message` is the backend's text, untrusted. */
  | { kind: "read_failed"; code: string; message: string };

/** A capture, or why there is none. */
export type CaptureResult = { ok: true; capture: Capture } | { ok: false; error: CaptureError };

/** A page of the board log, after `EventPage`. */
export interface CapturePage {
  repo: string;
  events: unknown[];
  cursor: number;
  head: number;
}

/** The part of the board API a capture reads, after `BoardApi.readEvents`. */
export interface CaptureReader {
  readEvents(
    cursor: number,
    limit: number,
  ): PromiseLike<{ ok: true; value: CapturePage } | { ok: false; code: string; message: string }>;
}

/**
 * Reads the whole log through `reader` and builds a captured capture. The log is read up to the
 * head the first page reports, so events appended while capturing are left out rather than mixing
 * two moments. Every event is copied field by field and validated; any page that breaks the gapless
 * log, names another repository or makes no progress fails the capture.
 */
export const captureLog = async (
  reader: CaptureReader,
  source: Extract<CaptureSource, { kind: "captured" }>,
): Promise<CaptureResult> => {
  const sourceError = checkCapturedSource(source);
  if (sourceError !== null) return { ok: false, error: sourceError };
  const events: RailheadEvent[] = [];
  let repo: RepoId | null = null;
  let head: number | null = null;
  // Each successful page advances by at least one event, so the loop ends within `head` pages.
  while (head === null || events.length < head) {
    const read = await reader.readEvents(events.length, CAPTURE_PAGE_SIZE);
    if (!read.ok) {
      return { ok: false, error: { kind: "read_failed", code: read.code, message: read.message } };
    }
    const page = read.value;
    if (head === null) {
      if (page.head > MAX_CAPTURE_EVENTS) return { ok: false, error: { kind: "too_large" } };
      head = page.head;
      repo = page.repo;
      if (head === 0) return { ok: false, error: { kind: "empty" } };
    } else if (page.repo !== repo) {
      return { ok: false, error: { kind: "foreign_repo", seq: events.length + 1 } };
    }
    if (page.events.length === 0) {
      return { ok: false, error: { kind: "gap", expected: events.length + 1, found: 0 } };
    }
    for (const value of page.events) {
      if (events.length === head) break;
      const copied = readEvent(value, `events[${events.length}]`);
      if (!copied.ok) return copied;
      events.push(copied.event);
    }
  }
  if (repo === null || head === null) return { ok: false, error: { kind: "empty" } };
  return checkCapture({
    format: CAPTURE_FORMAT,
    version: CAPTURE_VERSION,
    source: { ...source },
    repo,
    head,
    events,
  });
};

/** Serializes a capture as the JSON a capture file holds. Fails when it is too large. */
export const serializeCapture = (
  capture: Capture,
): { ok: true; text: string } | { ok: false; error: CaptureError } => {
  const text = `${JSON.stringify(capture, null, 1)}\n`;
  if (new TextEncoder().encode(text).length > MAX_CAPTURE_BYTES) {
    return { ok: false, error: { kind: "too_large" } };
  }
  return { ok: true, text };
};

/**
 * Reads a capture file's text. Never throws; see `CaptureError`. A text longer than
 * `MAX_CAPTURE_BYTES` code units is refused before parsing: its UTF-8 encoding is at least as long.
 */
export const parseCapture = (text: string): CaptureResult => {
  if (text.length > MAX_CAPTURE_BYTES) return { ok: false, error: { kind: "too_large" } };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: "not_json" } };
  }
  if (!isRecord(value) || value.format !== CAPTURE_FORMAT) {
    return { ok: false, error: { kind: "wrong_format" } };
  }
  const { version } = value;
  if (version !== CAPTURE_VERSION) {
    return typeof version === "number"
      ? { ok: false, error: { kind: "unsupported_version", version } }
      : { ok: false, error: { kind: "malformed", path: "version" } };
  }
  try {
    const rawEvents = value.events;
    if (!Array.isArray(rawEvents)) throw new Malformed("events");
    if (rawEvents.length > MAX_CAPTURE_EVENTS) return { ok: false, error: { kind: "too_large" } };
    const events: RailheadEvent[] = [];
    for (const [index, raw] of rawEvents.entries()) {
      const read = readEvent(raw, `events[${index}]`);
      if (!read.ok) return read;
      events.push(read.event);
    }
    return checkCapture({
      format: CAPTURE_FORMAT,
      version: CAPTURE_VERSION,
      source: readSource(value.source),
      repo: string(value, "repo", ""),
      head: integer(value, "head", ""),
      events,
    });
  } catch (error) {
    if (error instanceof Malformed)
      return { ok: false, error: { kind: "malformed", path: error.path } };
    throw error;
  }
};

/** One sentence for the person opening a file. The backend's own message is never shown. */
export const captureErrorText = (error: CaptureError): string => {
  switch (error.kind) {
    case "too_large":
      return `The capture is larger than this board replays: at most ${MAX_CAPTURE_EVENTS} events and ${MAX_CAPTURE_BYTES / (1024 * 1024)} MB.`;
    case "not_json":
      return "The file is not JSON.";
    case "wrong_format":
      return "The file is not a Railhead capture.";
    case "unsupported_version":
      return `The capture uses file version ${error.version}, which this board cannot read.`;
    case "malformed":
      return `The capture is malformed at ${error.path}.`;
    case "empty":
      return "The capture holds no events.";
    case "gap":
      return `The capture is missing event ${error.expected}, so it cannot be replayed.`;
    case "foreign_repo":
      return `Event ${error.seq} belongs to another repository.`;
    case "invalid_event":
      return `Event ${error.seq} failed validation.`;
    case "head_mismatch":
      return `The capture says it ends at event ${error.head}, but its last event is ${error.last}.`;
    case "read_failed":
      return `The backend refused to read the log (${error.code}).`;
    default:
      return unreachable(error);
  }
};

// =======================================================================================
// Whole-capture checks

const checkCapture = (capture: Capture): CaptureResult => {
  const { events, repo, head } = capture;
  if (events.length === 0) return { ok: false, error: { kind: "empty" } };
  for (const [index, event] of events.entries()) {
    const expected = index + 1;
    if (event.seq !== expected) {
      return { ok: false, error: { kind: "gap", expected, found: event.seq } };
    }
    if (event.repo !== repo) return { ok: false, error: { kind: "foreign_repo", seq: event.seq } };
    if (event.at > MAX_DATE_MS) {
      return {
        ok: false,
        error: { kind: "invalid_event", seq: event.seq, message: "at is past the last date" },
      };
    }
    try {
      validateEvent(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown reason";
      return { ok: false, error: { kind: "invalid_event", seq: event.seq, message } };
    }
  }
  if (head !== events.length) {
    return { ok: false, error: { kind: "head_mismatch", head, last: events.length } };
  }
  const sourceError = checkSource(capture.source);
  if (sourceError !== null) return { ok: false, error: sourceError };
  return { ok: true, capture };
};

const checkSource = (source: CaptureSource): CaptureError | null => {
  switch (source.kind) {
    case "captured":
      return checkCapturedSource(source);
    case "synthetic":
      return checkSourceText(source.description, "source.description");
    default:
      return unreachable(source);
  }
};

const checkSourceText = (text: string, path: string): CaptureError | null =>
  text === "" || text.length > MAX_SOURCE_TEXT_LENGTH ? { kind: "malformed", path } : null;

const checkCapturedSource = (
  source: Extract<CaptureSource, { kind: "captured" }>,
): CaptureError | null => {
  for (const field of ["origin", "org", "name"] as const) {
    const error = checkSourceText(source[field], `source.${field}`);
    if (error !== null) return error;
  }
  if (
    !Number.isSafeInteger(source.capturedAt) ||
    source.capturedAt < 1 ||
    source.capturedAt > MAX_DATE_MS
  ) {
    return { kind: "malformed", path: "source.capturedAt" };
  }
  return null;
};

// =======================================================================================
// Field-by-field reading

/** A field that is missing or of the wrong type, named by its path. */
class Malformed extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`malformed at ${path}`);
    this.name = "Malformed";
    this.path = path;
  }
}

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const join = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

const record = (value: unknown, path: string): Fields => {
  if (!isRecord(value)) throw new Malformed(path);
  return value;
};

const string = (fields: Fields, key: string, path: string): string => {
  const value = fields[key];
  if (typeof value !== "string") throw new Malformed(join(path, key));
  return value;
};

const integer = (fields: Fields, key: string, path: string): number => {
  const value = fields[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Malformed(join(path, key));
  }
  return value;
};

const finite = (fields: Fields, key: string, path: string): number => {
  const value = fields[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Malformed(join(path, key));
  return value;
};

const nullableString = (fields: Fields, key: string, path: string): string | null =>
  fields[key] === null ? null : string(fields, key, path);

const nullableInteger = (fields: Fields, key: string, path: string): number | null =>
  fields[key] === null ? null : integer(fields, key, path);

const list = <T>(
  fields: Fields,
  key: string,
  path: string,
  item: (value: unknown, path: string) => T,
): T[] => {
  const value = fields[key];
  const at = join(path, key);
  if (!Array.isArray(value)) throw new Malformed(at);
  return value.map((entry, index) => item(entry, `${at}[${index}]`));
};

const oneOf = <T extends string>(
  fields: Fields,
  key: string,
  path: string,
  allowed: readonly T[],
): T => {
  const value = string(fields, key, path);
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new Malformed(join(path, key));
  return found;
};

const stringItem = (value: unknown, path: string): string => {
  if (typeof value !== "string") throw new Malformed(path);
  return value;
};

const readSource = (value: unknown): CaptureSource => {
  const fields = record(value, "source");
  const kind = oneOf(fields, "kind", "source", ["captured", "synthetic"] as const);
  switch (kind) {
    case "captured":
      return {
        kind,
        origin: string(fields, "origin", "source"),
        org: string(fields, "org", "source"),
        name: string(fields, "name", "source"),
        capturedAt: integer(fields, "capturedAt", "source"),
      };
    case "synthetic":
      return { kind, description: string(fields, "description", "source") };
    default:
      return unreachable(kind);
  }
};

const readActor = (value: unknown, path: string): Actor => {
  const fields = record(value, path);
  const kind = oneOf(fields, "kind", path, ["human", "agent", "system"] as const);
  return { kind, id: string(fields, "id", path) };
};

const readDecisionRef = (value: unknown, path: string): DecisionRef => {
  const fields = record(value, path);
  return {
    decisionId: string(fields, "decisionId", path),
    version: integer(fields, "version", path),
  };
};

const readOption = (value: unknown, path: string): QuestionOption => {
  const fields = record(value, path);
  return { key: string(fields, "key", path), label: string(fields, "label", path) };
};

const readAcceptance = (
  value: unknown,
  path: string,
): { decision: DecisionRef; option: string } => {
  const fields = record(value, path);
  return {
    decision: readDecisionRef(fields.decision, join(path, "decision")),
    option: string(fields, "option", path),
  };
};

const readInboxEntry = (value: unknown, path: string): InboxEntry => {
  const fields = record(value, path);
  const kind = oneOf(fields, "kind", path, ["decision", "rework", "conflict"] as const);
  switch (kind) {
    case "decision":
    case "rework":
      return { kind, decision: readDecisionRef(fields.decision, join(path, "decision")) };
    case "conflict":
      return {
        kind,
        otherClaimId: string(fields, "otherClaimId", path),
        path: string(fields, "path", path),
      };
    default:
      return unreachable(kind);
  }
};

/** Every event type, so the compiler refuses a new type until this module can copy it. */
const EVENT_TYPES: Readonly<Record<EventType, true>> = {
  "agent.invited": true,
  "agent.joined": true,
  "agent.confirmed": true,
  "agent.revoked": true,
  "issue.filed": true,
  "claim.opened": true,
  "claim.pushed": true,
  "claim.ready": true,
  "claim.refused": true,
  "claim.reopened": true,
  "claim.expired": true,
  "claim.reassigned": true,
  "question.asked": true,
  "decision.recorded": true,
  "inbox.queued": true,
  "inbox.delivered": true,
  "inbox.acked": true,
  "train.check": true,
  "train.conflict": true,
  "train.intent": true,
  "train.main": true,
};

const isEventType = (value: string): value is EventType => Object.hasOwn(EVENT_TYPES, value);

/** Copies exactly the fields `type` defines from `d`, the event's `data` at path `p`. */
const readPayload = (type: EventType, d: Fields, p: string): EventPayload => {
  switch (type) {
    case "agent.invited":
      return { type, data: { inviteId: string(d, "inviteId", p), name: string(d, "name", p) } };
    case "agent.joined":
      return {
        type,
        data: {
          agentId: string(d, "agentId", p),
          inviteId: string(d, "inviteId", p),
          name: string(d, "name", p),
          keyFingerprint: string(d, "keyFingerprint", p),
        },
      };
    case "agent.confirmed":
    case "agent.revoked":
      return { type, data: { agentId: string(d, "agentId", p) } };
    case "issue.filed":
      return {
        type,
        data: {
          issueId: string(d, "issueId", p),
          title: string(d, "title", p),
          body: string(d, "body", p),
        },
      };
    case "claim.opened":
      return {
        type,
        data: {
          claimId: string(d, "claimId", p),
          issueId: string(d, "issueId", p),
          agentId: string(d, "agentId", p),
          generation: integer(d, "generation", p),
          base: string(d, "base", p),
        },
      };
    case "claim.pushed":
      return {
        type,
        data: {
          claimId: string(d, "claimId", p),
          generation: integer(d, "generation", p),
          ref: string(d, "ref", p),
          from: nullableString(d, "from", p),
          to: string(d, "to", p),
        },
      };
    case "claim.ready":
      return {
        type,
        data: {
          claimId: string(d, "claimId", p),
          generation: integer(d, "generation", p),
          commit: string(d, "commit", p),
          decisions: list(d, "decisions", p, readDecisionRef),
        },
      };
    case "claim.refused":
      return {
        type,
        data: {
          claimId: string(d, "claimId", p),
          generation: integer(d, "generation", p),
          reason: oneOf(d, "reason", p, ["stale_generation", "after_ready", "unacked_decision"]),
        },
      };
    case "claim.reopened":
      return {
        type,
        data: {
          claimId: string(d, "claimId", p),
          generation: integer(d, "generation", p),
          decisions: list(d, "decisions", p, readDecisionRef),
        },
      };
    case "claim.expired":
      return {
        type,
        data: { claimId: string(d, "claimId", p), generation: integer(d, "generation", p) },
      };
    case "claim.reassigned":
      return {
        type,
        data: {
          claimId: string(d, "claimId", p),
          from: string(d, "from", p),
          to: string(d, "to", p),
          generation: integer(d, "generation", p),
        },
      };
    case "question.asked":
      return {
        type,
        data: {
          questionId: string(d, "questionId", p),
          claimId: string(d, "claimId", p),
          decisionId: string(d, "decisionId", p),
          text: string(d, "text", p),
          options: list(d, "options", p, readOption),
        },
      };
    case "decision.recorded":
      return {
        type,
        data: {
          decisionId: string(d, "decisionId", p),
          version: integer(d, "version", p),
          questionId: string(d, "questionId", p),
          option: string(d, "option", p),
          supersedes: nullableInteger(d, "supersedes", p),
          scope: list(d, "scope", p, stringItem),
        },
      };
    case "inbox.queued":
      return {
        type,
        data: {
          agentId: string(d, "agentId", p),
          claimId: string(d, "claimId", p),
          item: integer(d, "item", p),
          entry: readInboxEntry(d.entry, join(p, "entry")),
        },
      };
    case "inbox.delivered":
      return {
        type,
        data: {
          agentId: string(d, "agentId", p),
          claimId: string(d, "claimId", p),
          item: integer(d, "item", p),
        },
      };
    case "inbox.acked":
      return {
        type,
        data: {
          agentId: string(d, "agentId", p),
          claimId: string(d, "claimId", p),
          item: integer(d, "item", p),
          plan: string(d, "plan", p),
        },
      };
    case "train.check":
      return {
        type,
        data: {
          checkRunId: string(d, "checkRunId", p),
          candidate: string(d, "candidate", p),
          check: string(d, "check", p),
          result: oneOf(d, "result", p, ["pass", "fail", "error"]),
          acceptance:
            d.acceptance === null ? null : readAcceptance(d.acceptance, join(p, "acceptance")),
        },
      };
    case "train.conflict": {
      const claims = list(d, "claims", p, stringItem);
      const [first, second] = claims;
      if (claims.length !== 2 || first === undefined || second === undefined) {
        throw new Malformed(join(p, "claims"));
      }
      return {
        type,
        data: {
          claims: [first, second],
          path: string(d, "path", p),
          class: oneOf(d, "class", p, ["compatible", "contradictory"]),
          probability: finite(d, "probability", p),
          route: oneOf(d, "route", p, ["redo", "question"]),
        },
      };
    }
    case "train.intent":
      return {
        type,
        data: {
          intentId: string(d, "intentId", p),
          expectedMain: string(d, "expectedMain", p),
          candidate: string(d, "candidate", p),
          claims: list(d, "claims", p, stringItem),
          decisions: list(d, "decisions", p, readDecisionRef),
          checkRunId: string(d, "checkRunId", p),
        },
      };
    case "train.main":
      return {
        type,
        data: {
          intentId: string(d, "intentId", p),
          outcome: oneOf(d, "outcome", p, ["updated", "rejected", "reconciled"]),
          main: string(d, "main", p),
        },
      };
    default:
      return unreachable(type);
  }
};

/** Copies one event's known fields. A newer schema version is refused before its shape is read. */
const readEvent = (
  value: unknown,
  path: string,
): { ok: true; event: RailheadEvent } | { ok: false; error: CaptureError } => {
  try {
    const fields = record(value, path);
    const v = integer(fields, "v", path);
    const seq = integer(fields, "seq", path);
    if (v !== EVENT_SCHEMA_VERSION) {
      return {
        ok: false,
        error: { kind: "invalid_event", seq, message: `unsupported schema version ${v}` },
      };
    }
    const type = string(fields, "type", path);
    if (!isEventType(type)) throw new Malformed(join(path, "type"));
    const event: RailheadEvent = {
      v,
      seq,
      at: integer(fields, "at", path),
      repo: string(fields, "repo", path),
      actor: readActor(fields.actor, join(path, "actor")),
      ...readPayload(type, record(fields.data, join(path, "data")), join(path, "data")),
    };
    return { ok: true, event };
  } catch (error) {
    if (error instanceof Malformed)
      return { ok: false, error: { kind: "malformed", path: error.path } };
    throw error;
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled capture variant: ${JSON.stringify(value)}`);
};
