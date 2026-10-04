import { describe, expect, it, vi } from "vitest";
import {
  MAX_PATH_LENGTH,
  MAX_TITLE_LENGTH,
  type Actor,
  type RailheadEvent,
} from "@railhead/shared/events";
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
  captureErrorText,
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

/** The history the fake board serves its log under. */
const HISTORY = "0123456789abcdef0123456789abcdef";

/** A Railhead session token's shape: the fixed header, claims and a MAC, each base64url. */
const SESSION_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudCI6ImFndF94In0.bWFjLWJ5dGVzLWZvci10ZXN0";

/** A deadline that never passes. */
const NO_DEADLINE = new AbortController().signal;

/**
 * A board log behind `readEvents`, serving at most `pageSize` events per page. `reset` replaces the
 * log and its history after the first page, as an owner's reset does. Unless `ignoreHistory` is set,
 * a read naming another history fails with `cursor_ahead`, as the backend's does.
 */
const fakeReader = (
  initial: readonly unknown[],
  options: {
    pageSize?: number;
    head?: number;
    repo?: string;
    reset?: { events: readonly unknown[]; history: string };
    ignoreHistory?: boolean;
    history?: string;
  } = {},
) => {
  const calls: number[] = [];
  const histories: (string | undefined)[] = [];
  let events = initial;
  let history = options.history ?? HISTORY;
  const reader: CaptureReader = {
    readEvents: async (cursor, limit, asked) => {
      calls.push(cursor);
      histories.push(asked);
      if (options.ignoreHistory !== true && asked !== undefined && asked !== history) {
        return { ok: false, code: "cursor_ahead" };
      }
      const size = Math.min(limit, options.pageSize ?? limit);
      const page: CapturePage = {
        repo: options.repo ?? SYNTH_REPO,
        events: events.slice(cursor, cursor + size),
        cursor,
        head: options.head ?? events.length,
        history,
      };
      if (options.reset !== undefined && calls.length === 1) {
        ({ events, history } = options.reset);
      }
      return { ok: true, value: page };
    },
  };
  return { reader, calls, histories };
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
    history: HISTORY,
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
    const { reader, calls, histories } = fakeReader(decisionReversal.events, { pageSize: 7 });
    const result = await captureLog(reader, SOURCE, NO_DEADLINE);
    if (!result.ok) throw new Error(`capture failed: ${result.error.kind}`);
    expect(result.capture).toEqual({
      format: CAPTURE_FORMAT,
      version: CAPTURE_VERSION,
      source: SOURCE,
      repo: SYNTH_REPO,
      history: HISTORY,
      head: decisionReversal.events.length,
      events: decisionReversal.events,
    });
    expect(result.redacted).toBe(0);
    const pages = Math.ceil(decisionReversal.events.length / 7);
    expect(calls).toEqual(Array.from({ length: pages }, (_, page) => page * 7));
    expect(histories).toEqual([undefined, ...Array.from({ length: pages - 1 }, () => HISTORY)]);
  });

  // The new history's log is longer, so without the history check the second page would be a
  // gapless suffix of it whose events pass validation and fold: a file describing neither run.
  const RESET = { events: issues(12), history: "fedcba9876543210fedcba9876543210" };

  it("refuses a capture when the repository is reset between pages", async () => {
    const { reader, histories } = fakeReader(issues(6), { pageSize: 3, reset: RESET });
    const result = await captureLog(reader, SOURCE, NO_DEADLINE);
    expect(result).toEqual({ ok: false, error: { kind: "history_changed" } });
    expect(histories).toEqual([undefined, HISTORY]);
    if (result.ok) throw new Error("captured");
    expect(captureErrorText(result.error)).toBe(
      "The repository was reset while the capture read it; capture it again.",
    );
  });

  it("refuses a later page from another history even when the backend serves it", async () => {
    const { reader } = fakeReader(issues(6), {
      pageSize: 3,
      reset: RESET,
      ignoreHistory: true,
    });
    expect(await captureLog(reader, SOURCE, NO_DEADLINE)).toEqual({
      ok: false,
      error: { kind: "history_changed" },
    });
  });

  it("reports cursor_ahead on the first page as a refusal, not a reset", async () => {
    const reader: CaptureReader = {
      readEvents: async () => ({ ok: false, code: "cursor_ahead" }),
    };
    expect(await captureLog(reader, SOURCE, NO_DEADLINE)).toEqual({
      ok: false,
      error: { kind: "read_failed", code: "cursor_ahead" },
    });
  });

  it.each([
    ["an empty history", ""],
    ["an overlong history", "h".repeat(257)],
    ["a history that is not a string", 7],
  ])("refuses a first page with %s", async (_label, history) => {
    const reader: CaptureReader = {
      readEvents: async (cursor) => ({
        ok: true,
        // Through JSON, as the wire delivers it: the page's type does not hold for a hostile backend.
        value: JSON.parse(
          JSON.stringify({
            repo: SYNTH_REPO,
            events: issues(2).slice(cursor),
            cursor,
            head: 2,
            history,
          }),
        ),
      }),
    };
    expect(await captureLog(reader, SOURCE, NO_DEADLINE)).toEqual({
      ok: false,
      error: { kind: "malformed", path: "history" },
    });
  });

  it("leaves out every field the event schema does not define", async () => {
    const leaky = issues(2).map((event) => ({
      ...event,
      token: SECRET,
      headers: { authorization: `Bearer ${SECRET}` },
      actor: { ...event.actor, session: SECRET },
      data: { ...event.data, inviteUrl: `https://railhead.example/join#${SECRET}` },
    }));
    const result = await captureLog(fakeReader(leaky).reader, SOURCE, NO_DEADLINE);
    if (!result.ok) throw new Error(`capture failed: ${result.error.kind}`);
    expect(result.capture.events).toEqual(issues(2));
    const serialized = serializeCapture(result.capture);
    if (!serialized.ok) throw new Error("serialize failed");
    expect(serialized.text).not.toContain(SECRET);
    expect(Object.keys(JSON.parse(serialized.text)).toSorted()).toEqual(
      ["events", "format", "head", "history", "repo", "source", "version"].toSorted(),
    );
  });

  it("stops at the head of the first page when the log grows while capturing", async () => {
    const log = issues(10);
    const result = await captureLog(
      fakeReader(log, { pageSize: 3, head: 4 }).reader,
      SOURCE,
      NO_DEADLINE,
    );
    if (!result.ok) throw new Error(`capture failed: ${result.error.kind}`);
    expect(result.capture.head).toBe(4);
    expect(result.capture.events).toEqual(log.slice(0, 4));
  });

  it("captures a log of exactly the event limit", async () => {
    const log = issues(MAX_CAPTURE_EVENTS);
    const result = await captureLog(fakeReader(log).reader, SOURCE, NO_DEADLINE);
    expect(result.ok && result.capture.head).toBe(MAX_CAPTURE_EVENTS);
  });

  it("refuses a log past the event limit before reading any event", async () => {
    const { reader, calls } = fakeReader(issues(1), { head: MAX_CAPTURE_EVENTS + 1 });
    expect(await captureLog(reader, SOURCE, NO_DEADLINE)).toEqual({
      ok: false,
      error: { kind: "too_large" },
    });
    expect(calls).toEqual([0]);
  });

  it("refuses an empty log", async () => {
    expect(await captureLog(fakeReader([]).reader, SOURCE, NO_DEADLINE)).toEqual({
      ok: false,
      error: { kind: "empty" },
    });
  });

  it("fails on a page that makes no progress instead of reading forever", async () => {
    const { reader, calls } = fakeReader(issues(2), { head: 5 });
    expect(await captureLog(reader, SOURCE, NO_DEADLINE)).toEqual({
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
          history: HISTORY,
        },
      }),
    };
    expect(await captureLog(reader, SOURCE, NO_DEADLINE)).toEqual({
      ok: false,
      error: { kind: "foreign_repo", seq: 3 },
    });
  });

  it("passes on the backend's refusal code and drops its message", async () => {
    const reader: CaptureReader = {
      readEvents: async () => ({ ok: false, code: "not_found", message: SECRET }),
    };
    const result = await captureLog(reader, SOURCE, NO_DEADLINE);
    expect(result).toEqual({ ok: false, error: { kind: "read_failed", code: "not_found" } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each([
    ["control characters", `\u001b]8;;https://evil.example\u0007${SECRET}`],
    ["a code outside the closed set", "not_found_or_worse"],
    ["an inherited property name", "constructor"],
    ["a non-string", 404],
  ])("reports %s as an unknown refusal code", async (_label, code) => {
    const reader: CaptureReader = { readEvents: async () => ({ ok: false, code }) };
    const result = await captureLog(reader, SOURCE, NO_DEADLINE);
    expect(result).toEqual({ ok: false, error: { kind: "read_failed", code: null } });
    if (result.ok) throw new Error("captured");
    expect(captureErrorText(result.error)).toBe(
      "The backend refused to read the log (unknown error).",
    );
  });

  it("fails at the deadline while a slow backend is still paging one event at a time", async () => {
    vi.useFakeTimers();
    try {
      const log = issues(MAX_CAPTURE_EVENTS);
      const calls: number[] = [];
      // Each page holds one event and arrives a second after it is asked for.
      const reader: CaptureReader = {
        readEvents: (cursor) => {
          calls.push(cursor);
          return new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  value: {
                    repo: SYNTH_REPO,
                    events: log.slice(cursor, cursor + 1),
                    cursor,
                    head: log.length,
                    history: HISTORY,
                  },
                }),
              1_000,
            );
          });
        },
      };
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(), 10_500);
      const pending = captureLog(reader, SOURCE, deadline.signal);
      await vi.advanceTimersByTimeAsync(10_500);
      expect(await pending).toEqual({ ok: false, error: { kind: "timed_out" } });
      expect(calls).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toHaveLength(11);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails at once when the deadline has already passed", async () => {
    const { reader, calls } = fakeReader(issues(2));
    expect(await captureLog(reader, SOURCE, AbortSignal.abort())).toEqual({
      ok: false,
      error: { kind: "timed_out" },
    });
    expect(calls).toEqual([]);
  });

  it("refuses an event that fails validation", async () => {
    const broken = issues(2);
    broken[1] = { ...issue(2), data: { issueId: "clm_synthwrong", title: "x", body: "" } };
    const result = await captureLog(fakeReader(broken).reader, SOURCE, NO_DEADLINE);
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
    const result = await captureLog(
      fakeReader(issues(1)).reader,
      { ...SOURCE, origin: "" },
      NO_DEADLINE,
    );
    expect(result).toEqual({ ok: false, error: { kind: "malformed", path: "source.origin" } });
  });
});

const capturedEvents = async (events: readonly RailheadEvent[]) => {
  const result = await captureLog(fakeReader(events).reader, SOURCE, NO_DEADLINE);
  if (!result.ok) throw new Error(`capture failed: ${result.error.kind}`);
  return result;
};

const withBody = (body: string): IssueEvent => ({
  ...issue(1),
  data: { ...issue(1).data, body },
});

/** An Artifacts token naming `field`, so a test that misses one names the field that leaked. */
const tokenIn = (field: string) => `art_v1_${field}0123456789abcdef`;

const sha = (digit: string) => digit.repeat(40);

const header = (seq: number): Pick<RailheadEvent, "v" | "seq" | "at" | "repo"> => ({
  v: 1,
  seq,
  at: SYNTH_START_MS + seq,
  repo: SYNTH_REPO,
});

describe("captureLog redaction", () => {
  it.each([
    ["a session token", `rh login gave ${SESSION_TOKEN} to me`, "rh login gave [redacted] to me"],
    [
      "an Artifacts token",
      "remote token art_v1_0123456789abcdef0123456789abcdef?expires=1760000000 here",
      "remote token [redacted] here",
    ],
    ["a Bearer credential", "sent Bearer abcdefgh12345678 then", "sent [redacted] then"],
    ["a Basic credential", "basic dXNlcjpwYXNzd29yZA==", "[redacted]"],
    ["an Authorization value", 'Authorization: "s3cr3tvalue99"', 'Authorization: "[redacted]"'],
    [
      "a password in a remote URL",
      "git push https://agt_x:hunter2hunter2@railhead.example/demo.git",
      "git push https://[redacted]@railhead.example/demo.git",
    ],
  ])("redacts %s in an issue body", async (_label, body, expected) => {
    const result = await capturedEvents([withBody(body)]);
    expect(result.capture.events).toEqual([withBody(expected)]);
    expect(result.redacted).toBe(1);
  });

  it("redacts every free-text field an event defines", async () => {
    const leak = `see ${SESSION_TOKEN}`;
    const asked: RailheadEvent = {
      v: 1,
      seq: 2,
      at: SYNTH_START_MS + 2,
      repo: SYNTH_REPO,
      actor: { kind: "agent", id: "agt_synthatlas" },
      type: "question.asked",
      data: {
        questionId: "qst_synthsize",
        claimId: "clm_synthatlas",
        decisionId: "dec_synthsize",
        text: leak,
        options: [
          { key: "a", label: leak },
          { key: "b", label: "Keep it" },
        ],
      },
    };
    const acked: RailheadEvent = {
      v: 1,
      seq: 3,
      at: SYNTH_START_MS + 3,
      repo: SYNTH_REPO,
      actor: { kind: "agent", id: "agt_synthatlas" },
      type: "inbox.acked",
      data: { agentId: "agt_synthatlas", claimId: "clm_synthatlas", item: 1, plan: leak },
    };
    const filed: RailheadEvent = {
      ...issue(1),
      data: { ...issue(1).data, title: leak, body: leak },
    };
    const read = await capturedEvents([filed, asked, acked]);
    expect(read.redacted).toBe(5);
    expect(JSON.stringify(read.capture)).not.toContain("eyJ");
    expect(read.capture.events[1]).toMatchObject({
      data: {
        text: "see [redacted]",
        options: [{ label: "see [redacted]" }, { label: "Keep it" }],
      },
    });
  });

  it.each([
    ["a Bearer value", "Bearer abc123", "Bearer abc123", "[redacted]"],
    ["an Authorization value", "Authorization: abc123", "abc123", "Authorization: [redacted]"],
    [
      "a URL password",
      "clone https://user:secret@host/demo.git",
      "secret",
      "clone https://[redacted]@host/demo.git",
    ],
    ["a one-character Bearer value", "token Bearer Q end", "Bearer Q", "token [redacted] end"],
    [
      "a one-character Authorization value",
      "Authorization=Q",
      "Authorization=Q",
      "Authorization=[redacted]",
    ],
    ["a one-character URL password", "https://u:Q@host", ":Q@", "https://[redacted]@host"],
    [
      "a two-part Authorization value",
      "Authorization: Token secret123",
      "secret123",
      "Authorization: [redacted]",
    ],
    [
      "a quoted Authorization value with spaces",
      'Authorization = "Token secret 123" then',
      "secret 123",
      'Authorization = "[redacted]" then',
    ],
    [
      "an Authorization header inside a quoted curl argument",
      `curl -H 'Authorization: Token secret 123' https://railhead.example`,
      "secret 123",
      `curl -H 'Authorization: [redacted]' https://railhead.example`,
    ],
    [
      "a lowercase JSON authorization header",
      '{"authorization": "Token secret123", "accept": "*/*"}',
      "secret123",
      '{"authorization": "[redacted]", "accept": "*/*"}',
    ],
    [
      "an Authorization value with no closing quote",
      'Authorization: "Token secret123',
      "secret123",
      "Authorization: [redacted]",
    ],
    [
      "an Authorization value carrying a session token",
      `Authorization: Bearer ${SESSION_TOKEN}`,
      SESSION_TOKEN,
      "Authorization: [redacted]",
    ],
  ])("keeps %s out of the written file", async (_label, body, credential, expected) => {
    const result = await capturedEvents([withBody(body)]);
    expect(result.capture.events).toEqual([withBody(expected)]);
    expect(result.redacted).toBe(1);
    const written = serializeCapture(result.capture);
    if (!written.ok) throw new Error(`serialize failed: ${written.error.kind}`);
    expect(written.text).not.toContain(credential);
  });

  it("redacts an unquoted Authorization value to the end of its line only", async () => {
    const result = await capturedEvents([
      withBody("Authorization: Token secret123 was refused\nretry with rh login"),
    ]);
    expect(result.capture.events).toEqual([
      withBody("Authorization: [redacted]\nretry with rh login"),
    ]);
    expect(result.redacted).toBe(1);
  });

  it("redacts the word after Bearer or Basic in prose too", async () => {
    const result = await capturedEvents([withBody("the bearer of a basic test")]);
    expect(result.capture.events).toEqual([withBody("the [redacted] a [redacted]")]);
    expect(result.redacted).toBe(2);
  });

  it.each([
    ["Bearer with no value", "ends with Bearer"],
    ["an empty Authorization value", 'Authorization: ""'],
    ["a URL with a user and no password", "https://user@railhead.example/demo"],
    ["a URL without a password", "https://railhead.example/demo/upload-app"],
    ["a JWT-like string too short to be a token", "eyJabc.def.ghi"],
  ])("copies %s unchanged", async (_label, body) => {
    const result = await capturedEvents([withBody(body)]);
    expect(result.capture.events).toEqual([withBody(body)]);
    expect(result.redacted).toBe(0);
  });

  it("refuses a capture whose redaction lengthens a field past its bound", async () => {
    const title = `${"x".repeat(MAX_TITLE_LENGTH - " Bearer Q".length)} Bearer Q`;
    const filed: RailheadEvent = { ...issue(1), data: { ...issue(1).data, title } };
    const result = await captureLog(fakeReader([filed]).reader, SOURCE, NO_DEADLINE);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_event",
        seq: 1,
        message: `title is longer than ${MAX_TITLE_LENGTH} characters`,
      },
    });
  });

  it("redacts a credential in every string field the written file holds", async () => {
    const agent: Actor = { kind: "agent", id: "agt_synthatlas" };
    const events: RailheadEvent[] = [
      {
        ...header(1),
        actor: SYNTH_OWNER,
        type: "issue.filed",
        data: { issueId: "iss_synth000001", title: tokenIn("title"), body: tokenIn("body") },
      },
      {
        ...header(2),
        actor: agent,
        type: "claim.pushed",
        data: {
          claimId: "clm_synthatlas",
          generation: 1,
          ref: `refs/heads/${tokenIn("ref")}`,
          from: null,
          to: sha("a"),
        },
      },
      {
        ...header(3),
        actor: agent,
        type: "question.asked",
        data: {
          questionId: "qst_synthsize",
          claimId: "clm_synthatlas",
          decisionId: "dec_synthsize",
          text: tokenIn("text"),
          options: [
            { key: "a", label: tokenIn("label") },
            { key: "b", label: "Keep it" },
          ],
        },
      },
      {
        ...header(4),
        actor: SYNTH_OWNER,
        type: "decision.recorded",
        data: {
          decisionId: "dec_synthsize",
          version: 1,
          questionId: "qst_synthsize",
          option: "a",
          supersedes: null,
          scope: ["src/upload.ts", `secrets/${tokenIn("scope")}`],
        },
      },
      {
        ...header(5),
        actor: { kind: "system", id: "sys_train" },
        type: "inbox.queued",
        data: {
          agentId: "agt_synthatlas",
          claimId: "clm_synthatlas",
          item: 1,
          entry: { kind: "conflict", otherClaimId: "clm_synthbeacon", path: tokenIn("entrypath") },
        },
      },
      {
        ...header(6),
        actor: agent,
        type: "inbox.acked",
        data: {
          agentId: "agt_synthatlas",
          claimId: "clm_synthatlas",
          item: 1,
          plan: tokenIn("plan"),
        },
      },
      {
        ...header(7),
        actor: { kind: "system", id: "sys_train" },
        type: "train.check",
        data: {
          checkRunId: "chk_synthrun",
          candidate: sha("b"),
          check: `lint ${tokenIn("check")}`,
          result: "pass",
          acceptance: null,
        },
      },
      {
        ...header(8),
        actor: { kind: "system", id: "sys_train" },
        type: "train.conflict",
        data: {
          claims: ["clm_synthatlas", "clm_synthbeacon"],
          path: `src/${tokenIn("conflictpath")}`,
          class: "compatible",
          probability: 0.5,
          route: "redo",
        },
      },
    ];
    const source: Extract<CaptureSource, { kind: "captured" }> = {
      ...SOURCE,
      origin: "https://agt_x:hunter2hunter2@railhead.example",
      org: tokenIn("org"),
      name: tokenIn("name"),
    };
    const planted = [
      "title",
      "body",
      "ref",
      "text",
      "label",
      "scope",
      "entrypath",
      "plan",
      "check",
      "conflictpath",
      "org",
      "name",
      "history",
    ].map(tokenIn);
    const { reader } = fakeReader(events, { history: tokenIn("history") });

    const result = await captureLog(reader, source, NO_DEADLINE);
    if (!result.ok) throw new Error(`capture failed: ${result.error.kind}`);
    const written = serializeCapture(result.capture);
    if (!written.ok) throw new Error(`serialize failed: ${written.error.kind}`);

    for (const secret of [...planted, "hunter2hunter2"]) expect(written.text).not.toContain(secret);
    expect(written.text).not.toContain("art_v1_");
    expect(result.redacted).toBe(planted.length + 1);
    // Identifiers and commits are not secret-shaped and survive; redacted fields stay valid.
    const reopened = parseCapture(written.text);
    if (!reopened.ok) throw new Error(`reopen failed: ${reopened.error.kind}`);
    expect(reopened.capture.source).toEqual({
      ...SOURCE,
      origin: "https://[redacted]@railhead.example",
      org: "[redacted]",
      name: "[redacted]",
    });
    expect(reopened.capture.history).toBe("[redacted]");
    expect(reopened.capture.events[1]).toMatchObject({
      data: { claimId: "clm_synthatlas", ref: "refs/heads/[redacted]", to: sha("a") },
    });
    expect(reopened.capture.events[3]).toMatchObject({
      data: { scope: ["src/upload.ts", "secrets/[redacted]"] },
    });
    expect(reopened.capture.events[4]).toMatchObject({
      data: { entry: { otherClaimId: "clm_synthbeacon", path: "[redacted]" } },
    });
    expect(reopened.capture.events[6]).toMatchObject({ data: { check: "lint [redacted]" } });
    expect(reopened.capture.events[7]).toMatchObject({ data: { path: "src/[redacted]" } });
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
      reason: "lost_conflict",
      decisions: [{ decisionId: "dec_synthsize", version: 2 }],
    },
  };

  it("copies an event type no fixture log uses yet", () => {
    const events = [...issues(3), { ...reopened, data: { ...reopened.data, note: SECRET } }];
    const result = parseCapture(fileOf({ events, head: 4 }));
    expect(result.ok && result.capture.events).toEqual([...issues(3), reopened]);
  });

  it("reads a version 1 reopen recorded before reasons as a superseded decision", () => {
    const { reason: _, ...before } = reopened.data;
    const events = [...issues(3), { ...reopened, data: before }];
    const result = parseCapture(fileOf({ events, head: 4 }));
    expect(result.ok && result.capture.events).toEqual([
      ...issues(3),
      { ...reopened, data: { ...reopened.data, reason: "decision_superseded" } },
    ]);
  });

  it.each([
    ["an unknown reopen reason", "lost_race"],
    ["a null reopen reason", null],
  ])("refuses %s", (_, reason) => {
    const events = [...issues(3), { ...reopened, data: { ...reopened.data, reason } }];
    expect(parsedError(fileOf({ events, head: 4 }))).toEqual({
      kind: "malformed",
      path: "events[3].data.reason",
    });
  });

  it("reads a captured source and its history", () => {
    const result = parseCapture(fileOf({}));
    expect(result.ok && result.capture.source).toEqual(SOURCE);
    expect(result.ok && result.capture.history).toBe(HISTORY);
  });

  it("keeps secret-shaped text a file holds: opening a file redacts nothing", () => {
    const events = issues(3);
    events[0] = { ...issue(1), data: { ...issue(1).data, body: SESSION_TOKEN } };
    const result = parseCapture(fileOf({ events }));
    expect(result.ok && result.capture.events[0]).toEqual(events[0]);
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
    ["a missing history", fileOf({ history: undefined }), { kind: "malformed", path: "history" }],
    ["an empty history", fileOf({ history: "" }), { kind: "malformed", path: "history" }],
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
    events[0] = { v: 4, seq: 1 };
    expect(parsedError(fileOf({ events }))).toEqual({
      kind: "invalid_event",
      seq: 1,
      message: "unsupported schema version 4",
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

  it("refuses times a date cannot hold, which the page could not show", () => {
    const events = issues(3);
    events[1] = { ...issue(2), at: 8_640_000_000_000_001 };
    expect(parsedError(fileOf({ events }))).toEqual({
      kind: "invalid_event",
      seq: 2,
      message: "at is past the last date",
    });
    expect(
      parsedError(fileOf({ source: { ...SOURCE, capturedAt: 8_640_000_000_000_001 } })),
    ).toEqual({ kind: "malformed", path: "source.capturedAt" });
  });

  it("accepts the last time a date can hold", () => {
    const events = issues(3);
    events[2] = { ...issue(3), at: 8_640_000_000_000_000 };
    expect(parseCapture(fileOf({ events })).ok).toBe(true);
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

describe("held check events", () => {
  const TRAIN: Actor = { kind: "system", id: "sys_train" };
  const DIGEST = "d".repeat(64);
  const held: Extract<RailheadEvent, { type: "train.held" }> = {
    ...header(4),
    v: 2,
    actor: TRAIN,
    type: "train.held",
    data: {
      checkRunId: "chk_synthheld",
      expectedMain: sha("a"),
      candidate: sha("b"),
      claims: ["clm_synthatlas", "clm_synthbeacon"],
      paths: ["railhead.checks.json", "scripts/check.sh"],
      digest: DIGEST,
    },
  };
  const approved: Extract<RailheadEvent, { type: "check.approved" }> = {
    ...header(5),
    v: 2,
    actor: SYNTH_OWNER,
    type: "check.approved",
    data: { checkRunId: "chk_synthheld", candidate: sha("b"), digest: DIGEST },
  };
  const log = (heldData: unknown = held.data, approvedData: unknown = approved.data) =>
    fileOf({
      events: [...issues(3), { ...held, data: heldData }, { ...approved, data: approvedData }],
      head: 5,
    });

  it("copies both events' fields exactly and drops the ones the schema does not define", () => {
    const result = parseCapture(
      log({ ...held.data, note: SECRET }, { ...approved.data, session: SECRET }),
    );
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`);
    expect(result.capture.events.slice(3)).toEqual([held, approved]);
    expect(JSON.stringify(result.capture)).not.toContain(SECRET);
  });

  it("keeps a held event's null digest as null", () => {
    const result = parseCapture(log({ ...held.data, digest: null }));
    expect(result.ok && result.capture.events[3]).toEqual({
      ...held,
      data: { ...held.data, digest: null },
    });
  });

  it.each([
    ["a held event without a digest", { ...held.data, digest: undefined }, "events[3].data.digest"],
    ["a held digest that is not a string", { ...held.data, digest: 7 }, "events[3].data.digest"],
    ["held paths that are not a list", { ...held.data, paths: "scripts" }, "events[3].data.paths"],
    ["a held path that is not a string", { ...held.data, paths: [1] }, "events[3].data.paths[0]"],
    ["a held event without claims", { ...held.data, claims: undefined }, "events[3].data.claims"],
  ])("refuses %s by its path", (_label, heldData, path) => {
    expect(parsedError(log(heldData))).toEqual({ kind: "malformed", path });
  });

  it.each([
    ["an approval without a digest", { ...approved.data, digest: undefined }, "digest"],
    ["an approval whose digest is null", { ...approved.data, digest: null }, "digest"],
    ["an approval without a candidate", { ...approved.data, candidate: undefined }, "candidate"],
    ["an approval whose run is a number", { ...approved.data, checkRunId: 3 }, "checkRunId"],
  ])("refuses %s by its path", (_label, approvedData, field) => {
    expect(parsedError(log(held.data, approvedData))).toEqual({
      kind: "malformed",
      path: `events[4].data.${field}`,
    });
  });

  it.each([
    [
      "a held path past the length limit",
      { ...held.data, paths: ["p".repeat(MAX_PATH_LENGTH + 1)] },
      "paths[0] is not a repository path",
    ],
    [
      "a held path that climbs out of the repository",
      { ...held.data, paths: ["../secrets"] },
      "paths[0] is not a repository path",
    ],
    [
      "a held event with no paths",
      { ...held.data, paths: [] },
      "paths must name at least one path",
    ],
    [
      "a held digest that is not SHA-256",
      { ...held.data, digest: "d".repeat(65) },
      "digest is not a SHA-256 digest",
    ],
  ])("refuses %s as an invalid event", (_label, heldData, message) => {
    expect(parsedError(log(heldData))).toEqual({ kind: "invalid_event", seq: 4, message });
  });

  it("refuses an approval whose digest is not SHA-256", () => {
    expect(parsedError(log(held.data, { ...approved.data, digest: DIGEST.toUpperCase() }))).toEqual(
      {
        kind: "invalid_event",
        seq: 5,
        message: "digest is not a SHA-256 digest",
      },
    );
  });

  it("accepts a held path of exactly the length limit", () => {
    const path = "p".repeat(MAX_PATH_LENGTH);
    const result = parseCapture(log({ ...held.data, paths: [path] }));
    expect(result.ok && result.capture.events[3]).toMatchObject({ data: { paths: [path] } });
  });

  it("captures both events and redacts a credential in a held path", async () => {
    const leaky = {
      ...held,
      data: { ...held.data, paths: ["src/ok.ts", `ci/${tokenIn("path")}`] },
    };
    const result = await capturedEvents([...issues(3), leaky, approved] satisfies RailheadEvent[]);
    expect(result.redacted).toBe(1);
    expect(result.capture.events.slice(3)).toEqual([
      { ...held, data: { ...held.data, paths: ["src/ok.ts", "ci/[redacted]"] } },
      approved,
    ]);
    const written = serializeCapture(result.capture);
    if (!written.ok) throw new Error(`serialize failed: ${written.error.kind}`);
    expect(written.text).not.toContain(tokenIn("path"));
    expect(parseCapture(written.text)).toEqual({ ok: true, capture: result.capture });
  });

  it("refuses a capture whose redaction lengthens a held path past its bound", async () => {
    const path = `${"p".repeat(MAX_PATH_LENGTH - " Bearer Q".length)} Bearer Q`;
    const result = await captureLog(
      fakeReader([...issues(3), { ...held, data: { ...held.data, paths: [path] } }]).reader,
      SOURCE,
      NO_DEADLINE,
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "invalid_event", seq: 4, message: "paths[0] is not a repository path" },
    });
  });
});

describe("unreported check events", () => {
  const unreported: Extract<RailheadEvent, { type: "train.unreported" }> = {
    ...header(4),
    v: 2,
    actor: { kind: "system", id: "sys_train" },
    type: "train.unreported",
    data: { checkRunId: "chk_synthlate", candidate: sha("b"), outcome: "timed_out" },
  };
  const log = (data: unknown, v = 2) =>
    fileOf({ events: [...issues(3), { ...unreported, v, data }], head: 4 });

  it("copies the event's fields exactly and drops the ones the schema does not define", () => {
    const result = parseCapture(log({ ...unreported.data, note: SECRET }));
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`);
    expect(result.capture.events.slice(3)).toEqual([unreported]);
    expect(JSON.stringify(result.capture)).not.toContain(SECRET);
  });

  it.each([
    ["an outcome it does not define", { ...unreported.data, outcome: "lost" }, "outcome"],
    ["no candidate", { ...unreported.data, candidate: undefined }, "candidate"],
  ])("refuses an unreported event with %s by its path", (_label, data, field) => {
    expect(parsedError(log(data))).toEqual({ kind: "malformed", path: `events[3].data.${field}` });
  });

  it("refuses an unreported event stamped at version 1", () => {
    expect(parsedError(log(unreported.data, 1))).toEqual({
      kind: "invalid_event",
      seq: 4,
      message: "train.unreported is written at schema version 2",
    });
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
