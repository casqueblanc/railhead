// Reads a deployed instance's public board for `scripts/qualify-slice.mjs`: the event log `slice`
// records, and what `gate` reads again to confirm a slice report against the live instance.
//
// A report is a file the operator hands over, so checks over the report alone pass a forgery that
// is consistent with itself. The log is append-only and the instance keeps its check runs, so at
// gate time the instance must still hold the recorded events at their recorded positions under the
// recorded history, and each landed batch's check run as recorded. Everything the instance answers
// is untrusted and validated here; a failure names what was refused, never what the instance said.

import { MAX_EVENT_PAGE } from "../../packages/railhead-shared/src/board-api.ts";
import {
  type Check,
  check,
  eventsWithToken,
  record,
  sha,
  sliceBatches,
  sliceEvents,
  sliceObservations,
  text,
} from "./evidence.ts";

/** How long one board call may take. */
export const BOARD_TIMEOUT_MS = 30_000;
/** The longest event log read. */
export const MAX_EVENTS = 20_000;

/** The board calls the harness makes, as a Cap'n Web stub of `BoardApi` offers them. */
export interface LiveBoard {
  readEvents(cursor: number, limit: number, history?: string): Promise<unknown>;
  checkDetail(checkRunId: string): Promise<unknown>;
}

/** The instance's API session, as a Cap'n Web stub of `RailheadApi` offers it. */
export interface LiveInstance {
  openBoard(org: string, name: string): Promise<unknown>;
}

/** The instance refused a read, answered out of shape or did not answer in time. */
export class LiveReadFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveReadFailure";
  }
}

function withTimeout<T>(promise: Promise<T>, what: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new LiveReadFailure(`${what} did not answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** The value of a successful `BoardResult`, or `null`. */
function okValue(answer: unknown): unknown {
  const result = record(answer);
  return result?.ok === true ? result.value : null;
}

function isBoard(value: unknown): value is LiveBoard & Partial<Disposable> {
  // A Cap'n Web stub is a callable proxy, so its methods are checked as functions.
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "readEvents") === "function" &&
    typeof Reflect.get(value, "checkDetail") === "function"
  );
}

interface EventPage {
  repo: string;
  events: unknown[];
  cursor: number;
  head: number;
  history: string;
}

function eventPage(answer: unknown): EventPage | null {
  const page = record(okValue(answer));
  const repo = text(page?.repo);
  const history = text(page?.history);
  const { cursor, head, events } = page ?? {};
  if (
    repo === null ||
    history === null ||
    !Array.isArray(events) ||
    typeof cursor !== "number" ||
    typeof head !== "number" ||
    !Number.isSafeInteger(cursor) ||
    !Number.isSafeInteger(head)
  ) {
    return null;
  }
  return { repo, events, cursor, head, history };
}

/** A repository's log as read: its events up to `head`, under one history. */
export interface LiveLog {
  repo: string;
  events: unknown[];
  head: number;
  history: string;
}

/** Where `readLog` stops and which history it requires. */
export interface ReadLogOptions {
  /** Read only up to this `seq`; the whole log when absent. */
  upTo?: number;
  /** Fail with `cursor_ahead` unless the log is still under this history. */
  history?: string;
  timeoutMs?: number;
}

/**
 * Opens `org/name`'s board on `instance`, runs `use` with it and disposes it. Throws
 * `LiveReadFailure` when the instance refuses the repository.
 */
export async function withBoard<T>(
  instance: LiveInstance,
  org: string,
  name: string,
  use: (board: LiveBoard) => Promise<T>,
  timeoutMs = BOARD_TIMEOUT_MS,
): Promise<T> {
  const board = okValue(await withTimeout(instance.openBoard(org, name), "openBoard", timeoutMs));
  if (!isBoard(board)) throw new LiveReadFailure(`the instance refused to open ${org}/${name}`);
  try {
    return await use(board);
  } finally {
    board[Symbol.dispose]?.();
  }
}

/** Pages `board`'s event log from the start, as `options` bounds it. */
export async function readLog(board: LiveBoard, options: ReadLogOptions = {}): Promise<LiveLog> {
  const { upTo, timeoutMs = BOARD_TIMEOUT_MS } = options;
  const events: unknown[] = [];
  let cursor = 0;
  let history = options.history;
  while (events.length < MAX_EVENTS) {
    const page = eventPage(
      await withTimeout(
        history === undefined
          ? board.readEvents(cursor, MAX_EVENT_PAGE)
          : board.readEvents(cursor, MAX_EVENT_PAGE, history),
        "readEvents",
        timeoutMs,
      ),
    );
    if (page === null || (history !== undefined && page.history !== history)) {
      throw new LiveReadFailure("the instance refused a page of the event log");
    }
    history = page.history;
    events.push(...page.events);
    const end = upTo ?? page.head;
    if (page.events.length === 0 || page.cursor >= end) {
      const kept = events.filter((event) => {
        const seq = record(event)?.seq;
        return typeof seq === "number" && seq <= end;
      });
      return { repo: page.repo, events: kept, head: page.head, history };
    }
    if (page.cursor <= cursor) throw new LiveReadFailure("the event log did not advance");
    cursor = page.cursor;
  }
  throw new LiveReadFailure(`the event log is longer than ${MAX_EVENTS} events`);
}

/** Whether the instance's record of `checkRunId` is a passing run of `candidate` on `expectedMain`. */
async function checkRunMatches(
  board: LiveBoard,
  batch: { checkRunId: string; candidate: string; expectedMain: string },
  timeoutMs: number,
): Promise<boolean> {
  const detail = record(
    okValue(await withTimeout(board.checkDetail(batch.checkRunId), "checkDetail", timeoutMs)),
  );
  const state = record(detail?.state);
  return (
    detail?.checkRunId === batch.checkRunId &&
    sha(detail.candidate) === batch.candidate &&
    sha(detail.expectedMain) === batch.expectedMain &&
    state?.kind === "reported" &&
    state.result === "pass"
  );
}

/**
 * Confirms a slice report against the live instance: `slice.live-log` holds when the log, read again
 * under the recorded history up to the recorded length, gives exactly the recorded slice events and
 * token count; `slice.live-check` holds when the instance still records each landed batch's check
 * run as a pass on its exact candidate and expected main. An instance that refuses or cannot be
 * reached fails both.
 */
export async function confirmSlice(
  report: unknown,
  instance: LiveInstance,
  timeoutMs = BOARD_TIMEOUT_MS,
): Promise<Check[]> {
  const obs = sliceObservations(record(report)?.observations);
  const [org, name] = obs?.repo.split("/") ?? [];
  if (obs === null || org === undefined || name === undefined) {
    return [check("slice.live-log", false, "the slice report is malformed or incomplete")];
  }
  const batches = sliceBatches(obs);
  try {
    return await withBoard(
      instance,
      org,
      name,
      async (board) => {
        const log = await readLog(board, {
          upTo: obs.eventCount,
          history: obs.history,
          timeoutMs,
        });
        const recorded = JSON.stringify(sliceEvents(obs.events));
        const sameLog =
          log.head >= obs.eventCount &&
          log.events.length === obs.eventCount &&
          JSON.stringify(sliceEvents(log.events)) === recorded &&
          eventsWithToken(log.events) === obs.logTokens;
        const runs: boolean[] = [];
        for (const batch of batches) runs.push(await checkRunMatches(board, batch, timeoutMs));
        const confirmed = runs.filter(Boolean).length;
        return [
          check(
            "slice.live-log",
            sameLog,
            sameLog
              ? `the live log holds the ${obs.eventCount} recorded events under the recorded history`
              : `the live log's first ${obs.eventCount} events differ from the report`,
          ),
          check(
            "slice.live-check",
            batches.length > 0 && confirmed === batches.length,
            `${confirmed} of ${batches.length} landed batches' check runs confirmed by the instance`,
          ),
        ];
      },
      timeoutMs,
    );
  } catch (error) {
    // Only this module's own sentences are kept: a transport error can quote what a server sent.
    const why = error instanceof LiveReadFailure ? error.message : "the instance could not be read";
    return [check("slice.live-log", false, why), check("slice.live-check", false, why)];
  }
}
