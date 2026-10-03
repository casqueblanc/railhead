import { describe, expect, it } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import { checkBeforeLand } from "../../../../../fixtures/board/checkBeforeLand";
import { decisionReversal } from "../../../../../fixtures/board/decisionReversal";
import { optionResults } from "../../../../../fixtures/board/optionResults";
import {
  SYNTH_OWNER,
  SYNTH_REPO,
  SYNTH_START_MS,
} from "../../../../../fixtures/board/syntheticLog";
import {
  CAPTURE_FORMAT,
  CAPTURE_VERSION,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_EVENTS,
  captureLog,
  parseCapture,
  serializeCapture,
  type Capture,
  type CapturePage,
  type CaptureReader,
  type CaptureSource,
} from "./captureFile";
import { syntheticCapture } from "./syntheticReplays";

const SOURCE: Extract<CaptureSource, { kind: "captured" }> = {
  kind: "captured",
  origin: "https://railhead.example",
  org: "demo",
  name: "upload-app",
  capturedAt: Date.UTC(2026, 9, 5, 12),
};

const SECRET = "rh_session_d0n0tl3ak";

/** A board log behind `readEvents`, serving at most `pageSize` events per page. */
const fakeReader = (
  events: readonly unknown[],
  options: { pageSize?: number; head?: number; repo?: string } = {},
) => {
  const calls: number[] = [];
  const reader: CaptureReader = {
    readEvents: async (cursor, limit) => {
      calls.push(cursor);
      const size = Math.min(limit, options.pageSize ?? limit);
      const page: CapturePage = {
        repo: options.repo ?? SYNTH_REPO,
        events: events.slice(cursor, cursor + size),
        cursor,
        head: options.head ?? events.length,
      };
      return { ok: true, value: page };
    },
  };
  return { reader, calls };
};

type IssueEvent = Extract<RailheadEvent, { type: "issue.filed" }>;

const issue = (seq: number): IssueEvent => ({
  v: 1,
  seq,
  at: SYNTH_START_MS + seq,
  repo: SYNTH_REPO,
  actor: SYNTH_OWNER,
  type: "issue.filed",
  data: { issueId: `iss_synth${seq.toString().padStart(6, "0")}`, title: "Synthetic", body: "" },
});

const issues = (count: number): IssueEvent[] =>
  Array.from({ length: count }, (_, index) => issue(index + 1));

const fileOf = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    format: CAPTURE_FORMAT,
    version: CAPTURE_VERSION,
    source: SOURCE,
    repo: SYNTH_REPO,
    head: 3,
    events: issues(3),
    ...fields,
  });

const parsedError = (text: string) => {
  const result = parseCapture(text);
  if (result.ok) throw new Error("expected the capture to be refused");
  return result.error;
};

describe("captureLog", () => {
  it("reads every page up to the head and copies each event exactly", async () => {
    const { reader, calls } = fakeReader(decisionReversal.events, { pageSize: 7 });
    const result = await captureLog(reader, SOURCE);
    if (!result.ok) throw new Error(`capture failed: ${result.error.kind}`);
    expect(result.capture).toEqual({
      format: CAPTURE_FORMAT,
      version: CAPTURE_VERSION,
      source: SOURCE,
      repo: SYNTH_REPO,
      head: decisionReversal.events.length,
      events: decisionReversal.events,
    });
    expect(calls).toEqual(
      Array.from({ length: Math.ceil(decisionReversal.events.length / 7) }, (_, page) => page * 7),
    );
  });

  it("leaves out every field the event schema does not define", async () => {
    const leaky = issues(2).map((event) => ({
      ...event,
      token: SECRET,
      headers: { authorization: `Bearer ${SECRET}` },
      actor: { ...event.actor, session: SECRET },
      data: { ...event.data, inviteUrl: `https://railhead.example/join#${SECRET}` },
    }));
    const result = await captureLog(fakeReader(leaky).reader, SOURCE);
    if (!result.ok) throw new Error(`capture failed: ${result.error.kind}`);
    expect(result.capture.events).toEqual(issues(2));
    const serialized = serializeCapture(result.capture);
    if (!serialized.ok) throw new Error("serialize failed");
    expect(serialized.text).not.toContain(SECRET);
    expect(Object.keys(JSON.parse(serialized.text)).toSorted()).toEqual(
      ["events", "format", "head", "repo", "source", "version"].toSorted(),
    );
  });

  it("stops at the head of the first page when the log grows while capturing", async () => {
    const log = issues(10);
    const result = await captureLog(fakeReader(log, { pageSize: 3, head: 4 }).reader, SOURCE);
    if (!result.ok) throw new Error(`capture failed: ${result.error.kind}`);
    expect(result.capture.head).toBe(4);
    expect(result.capture.events).toEqual(log.slice(0, 4));
  });

  it("captures a log of exactly the event limit", async () => {
    const log = issues(MAX_CAPTURE_EVENTS);
    const result = await captureLog(fakeReader(log).reader, SOURCE);
    expect(result.ok && result.capture.head).toBe(MAX_CAPTURE_EVENTS);
  });

  it("refuses a log past the event limit before reading any event", async () => {
    const { reader, calls } = fakeReader(issues(1), { head: MAX_CAPTURE_EVENTS + 1 });
    expect(await captureLog(reader, SOURCE)).toEqual({ ok: false, error: { kind: "too_large" } });
    expect(calls).toEqual([0]);
  });

  it("refuses an empty log", async () => {
    expect(await captureLog(fakeReader([]).reader, SOURCE)).toEqual({
      ok: false,
      error: { kind: "empty" },
    });
  });

  it("fails on a page that makes no progress instead of reading forever", async () => {
    const { reader, calls } = fakeReader(issues(2), { head: 5 });
    expect(await captureLog(reader, SOURCE)).toEqual({
      ok: false,
      error: { kind: "gap", expected: 3, found: 0 },
    });
    expect(calls).toEqual([0, 2]);
  });

  it("fails when a later page names another repository", async () => {
    let call = 0;
    const reader: CaptureReader = {
      readEvents: async (cursor) => ({
        ok: true,
        value: {
          repo: call++ === 0 ? SYNTH_REPO : "rep_otherrepo",
          events: issues(4).slice(cursor, cursor + 2),
          cursor,
          head: 4,
        },
      }),
    };
    expect(await captureLog(reader, SOURCE)).toEqual({
      ok: false,
      error: { kind: "foreign_repo", seq: 3 },
    });
  });

  it("passes on the backend's refusal code", async () => {
    const reader: CaptureReader = {
      readEvents: async () => ({ ok: false, code: "not_found", message: "No such repository." }),
    };
    expect(await captureLog(reader, SOURCE)).toEqual({
      ok: false,
      error: { kind: "read_failed", code: "not_found", message: "No such repository." },
    });
  });

  it("refuses an event that fails validation", async () => {
    const broken = issues(2);
    broken[1] = { ...issue(2), data: { issueId: "clm_synthwrong", title: "x", body: "" } };
    const result = await captureLog(fakeReader(broken).reader, SOURCE);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_event",
        seq: 2,
        message: "issueId is not a issue identifier",
      },
    });
  });

  it("refuses a source without an origin", async () => {
    const result = await captureLog(fakeReader(issues(1)).reader, { ...SOURCE, origin: "" });
    expect(result).toEqual({ ok: false, error: { kind: "malformed", path: "source.origin" } });
  });
});

describe("parseCapture", () => {
  it.each([decisionReversal, checkBeforeLand, optionResults])(
    "reads back what serializeCapture wrote: $description",
    (log) => {
      const capture = syntheticCapture(log);
      const serialized = serializeCapture(capture);
      if (!serialized.ok) throw new Error("serialize failed");
      expect(parseCapture(serialized.text)).toEqual({ ok: true, capture });
    },
  );

  it("copies an event type no fixture log uses yet", () => {
    const reopened: RailheadEvent = {
      v: 1,
      seq: 4,
      at: SYNTH_START_MS + 4,
      repo: SYNTH_REPO,
      actor: { kind: "system", id: "sys_train" },
      type: "claim.reopened",
      data: {
        claimId: "clm_synthatlas",
        generation: 2,
        decisions: [{ decisionId: "dec_synthsize", version: 2 }],
      },
    };
    const events = [...issues(3), { ...reopened, data: { ...reopened.data, note: SECRET } }];
    const result = parseCapture(fileOf({ events, head: 4 }));
    expect(result.ok && result.capture.events).toEqual([...issues(3), reopened]);
  });

  it("reads a captured source", () => {
    const result = parseCapture(fileOf({}));
    expect(result.ok && result.capture.source).toEqual(SOURCE);
  });

  it.each([
    ["not JSON", "{", { kind: "not_json" }],
    ["another format", JSON.stringify({ format: "other" }), { kind: "wrong_format" }],
    ["a JSON array", "[]", { kind: "wrong_format" }],
    ["a newer version", fileOf({ version: 2 }), { kind: "unsupported_version", version: 2 }],
    [
      "a version that is not a number",
      fileOf({ version: "1" }),
      { kind: "malformed", path: "version" },
    ],
    ["no events", fileOf({ events: [], head: 0 }), { kind: "empty" }],
    ["events that are not a list", fileOf({ events: {} }), { kind: "malformed", path: "events" }],
    [
      "an unknown source",
      fileOf({ source: { kind: "live" } }),
      { kind: "malformed", path: "source.kind" },
    ],
    [
      "an overlong synthetic description",
      fileOf({ source: { kind: "synthetic", description: "x".repeat(257) } }),
      { kind: "malformed", path: "source.description" },
    ],
    [
      "a missing capture time",
      fileOf({ source: { ...SOURCE, capturedAt: undefined } }),
      { kind: "malformed", path: "source.capturedAt" },
    ],
  ])("refuses %s", (_, text, error) => {
    expect(parsedError(text)).toEqual(error);
  });

  it("names the path of a malformed event field", () => {
    const events: unknown[] = issues(3);
    events[1] = { ...issue(2), actor: { kind: "human" } };
    expect(parsedError(fileOf({ events }))).toEqual({
      kind: "malformed",
      path: "events[1].actor.id",
    });
  });

  it("refuses an event type the schema does not define", () => {
    const events: unknown[] = issues(3);
    events[2] = { ...issue(3), type: "agent.impersonated" };
    expect(parsedError(fileOf({ events }))).toEqual({
      kind: "malformed",
      path: "events[2].type",
    });
  });

  it("refuses an event from a newer schema before reading its shape", () => {
    const events: unknown[] = issues(3);
    events[0] = { v: 2, seq: 1 };
    expect(parsedError(fileOf({ events }))).toEqual({
      kind: "invalid_event",
      seq: 1,
      message: "unsupported schema version 2",
    });
  });

  it("refuses a log with a missing event", () => {
    const events = issues(4).filter((event) => event.seq !== 3);
    expect(parsedError(fileOf({ events }))).toEqual({ kind: "gap", expected: 3, found: 4 });
  });

  it("refuses reordered events", () => {
    const [first, second, third] = issues(3);
    expect(parsedError(fileOf({ events: [first, third, second] }))).toEqual({
      kind: "gap",
      expected: 2,
      found: 3,
    });
  });

  it("refuses a log that does not start at 1", () => {
    expect(parsedError(fileOf({ events: issues(3).slice(1), head: 3 }))).toEqual({
      kind: "gap",
      expected: 1,
      found: 2,
    });
  });

  it("refuses an event from another repository", () => {
    const events = issues(3);
    events[2] = { ...issue(3), repo: "rep_otherrepo" };
    expect(parsedError(fileOf({ events }))).toEqual({ kind: "foreign_repo", seq: 3 });
  });

  it("refuses an event that fails validation", () => {
    const events = issues(3);
    events[0] = { ...issue(1), data: { issueId: "clm_synthwrong", title: "x", body: "" } };
    expect(parsedError(fileOf({ events }))).toMatchObject({ kind: "invalid_event", seq: 1 });
  });

  it("refuses a head that disagrees with the events", () => {
    expect(parsedError(fileOf({ head: 5 }))).toEqual({ kind: "head_mismatch", head: 5, last: 3 });
  });

  it("refuses more events than the limit", () => {
    const text = fileOf({ events: issues(MAX_CAPTURE_EVENTS + 1), head: MAX_CAPTURE_EVENTS + 1 });
    expect(parsedError(text)).toEqual({ kind: "too_large" });
  });

  it("refuses a text past the size limit without parsing it", () => {
    expect(parsedError(" ".repeat(MAX_CAPTURE_BYTES + 1))).toEqual({ kind: "too_large" });
  });

  it("drops fields the file adds beyond the schema", () => {
    const events = issues(3).map((event) => ({ ...event, note: SECRET }));
    const result = parseCapture(fileOf({ events, extra: SECRET }));
    if (!result.ok) throw new Error(`refused: ${result.error.kind}`);
    expect(result.capture.events).toEqual(issues(3));
    expect(JSON.stringify(result.capture)).not.toContain(SECRET);
  });
});

describe("serializeCapture", () => {
  it("refuses a capture whose UTF-8 encoding is past the size limit", () => {
    // Each "é" is one UTF-16 unit but two UTF-8 bytes, so the text fits by length and not by size.
    const body = "é".repeat(16 * 1024 - 1);
    const count = Math.ceil(MAX_CAPTURE_BYTES / (2 * body.length));
    const capture: Capture = {
      ...syntheticCapture(decisionReversal),
      events: Array.from({ length: count }, (_, index) => ({
        ...issue(index + 1),
        data: { issueId: `iss_synth${index}`, title: "Synthetic", body },
      })),
    };
    expect(serializeCapture(capture)).toEqual({ ok: false, error: { kind: "too_large" } });
  });
});
