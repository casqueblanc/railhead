// The main writer: moves main for an authorized merge intent, conditionally, and records what
// happened.
//
// Each write attempt is recorded before it starts: one Repo transaction checks that every pin's
// claim generation and every decision version the intent rests on is still current, and counts the
// attempt on the intent. Only then does the writer ask main's ref to move from `expectedMain` to
// `candidate`, which the ref does only if main is still at `expectedMain`. A second transaction
// records the outcome on the intent and appends `train.main`.
//
// An intent still `authorized` with attempts counted may have moved main without the writer
// hearing it: the response was lost or late, or the object was recreated mid-write. Such intents
// are found in storage, not in memory, so before any write, for this intent or another, the writer
// reads main back and settles each one it can. Main at an intent's candidate means its write
// landed. Main anywhere else but its expected commit means it can no longer land, because main
// only moves forward and never returns to a commit it left; and it did not land, because no write
// moves main off a candidate before that candidate's intent is settled. Main still at its expected
// commit leaves it unsettled: its write may yet apply. While one is unsettled, only a write from
// that same expected commit may start, so whichever of the two lands, the other's conditional
// update can no longer apply and the next read-back tells them apart. Nothing here forces main.
//
// That window has an end. Main's ref promises that an update which has not applied within
// `MAIN_UPDATE_LIFETIME_MS` of being sent never will, so once an intent's last attempt is older
// than that, main read back at its expected commit means the write did not land, and the intent
// settles `reconciled` at that commit. The writer applies this wherever waiting would otherwise
// hold the train: to another intent that holds this one back, and to this intent once its fence
// has moved. An intent whose fence still holds writes again instead, conditionally, which starts
// a new window.
//
// A claim or decision fence that moves while the intent's own earlier write is unsettled stops any
// further write, but until the window ends the publication returns `unavailable`, not the fence's
// refusal: that write may still land, and a definitive refusal would let the train fail work that
// then reaches main. Once main moves or the window ends, the read-back settles the intent and the
// publication returns what it found.
//
// Every call to main's ref is bounded by a deadline. A read that does not answer in time refuses
// the publication; an update that does not answer in time stays counted and is read back on the
// next publication, like any uncertain write.
//
// One publication makes at most `MAX_WRITE_ATTEMPTS` updates. The count on the intent only grows,
// and fences each attempt; it is not a budget. A publication refused as `unavailable` leaves the
// intent authorized, and the train publishes it again on its next drive, after reading main back,
// so an intent whose writes failed while Git was down still lands once Git answers.

import { isId, type CommitSha, type IntentId } from "@railhead/shared/events";
import { fail, ok, type PortErrorCode, type PortResult } from "../../contracts/result";
import type {
  AuthorizationPort,
  MainRefPort,
  MainUpdate,
  MainWriterPort,
  MergeIntentRecord,
  MergeIntentStatus,
} from "../../contracts/train";
import type { EventLog } from "../../repo/eventLog";
import { checkFence, TRAIN_ACTOR, type AuthorizationReaders } from "../../train/authorize";

/** Updates one publication may make before it returns `unavailable`; a later one may try again. */
export const MAX_WRITE_ATTEMPTS = 3;

/** Publications that may wait behind the one in progress before more are refused as `busy`. */
export const MAX_QUEUED_PUBLICATIONS = 32;

/**
 * How long one call to main's ref may take before the writer stops waiting for it. A publication
 * makes up to `2 * MAX_WRITE_ATTEMPTS + 1` calls, so a slow one can outlast the train's own
 * `PORT_TIMEOUT_MS` and its `DRIVE_LEASE_MS`. The train then reports the drive unavailable while
 * the publication carries on and records its outcome, which the train's next drive reads; only the
 * wake's retry budget pays. Publications run one at a time, so a later drive's publication waits.
 */
export const MAIN_REF_TIMEOUT_MS = 10_000;

/**
 * How long after it is sent an update of main may still apply. `MainRefPort` promises that an
 * update which has not applied by then never will; past it, the writer reads main at an intent's
 * expected commit as proof that the intent's write did not land. This is a design value, not a
 * measurement: thirty times the writer's own wait for an answer. It must stay well inside the
 * train's alarm retries (`MAX_WAKE_FAILURES`, about 85 minutes), so a held batch is driven again
 * after the window ends.
 */
export const MAIN_UPDATE_LIFETIME_MS = 30 * MAIN_REF_TIMEOUT_MS;

/** What the main writer needs from its Repo. */
export interface MainWriterContext {
  /** The event log, whose transactions fence each attempt and record each outcome. */
  readonly log: EventLog;
  /** The current time, in milliseconds since the Unix epoch; the same clock authorization uses. */
  readonly clock: () => number;
}

/**
 * The other modules the writer reads, resolved when a publication runs: the intents, and the same
 * fence readers authorization uses. The readers are called only inside the writer's transaction;
 * `null` from any of them refuses the write.
 */
export interface MainWriterDeps extends AuthorizationReaders {
  /** The intents and their progress. */
  readonly authorization: AuthorizationPort;
}

/**
 * Builds the main writer over main's ref. `refTimeoutMs` bounds each ref call; a publication makes
 * at most `MAX_WRITE_ATTEMPTS` updates and one read before each, so it settles within a bound too.
 */
export function createMainWriter(
  context: MainWriterContext,
  deps: () => MainWriterDeps,
  ref: MainRefPort,
  refTimeoutMs: number = MAIN_REF_TIMEOUT_MS,
): MainWriterPort {
  const mainRef = boundedRef(ref, refTimeoutMs);
  // Publications run one at a time, so no two attempts interleave across an `await`.
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  return {
    head: () => mainRef.read(),
    publish: async (intentId) => {
      if (!isId("intent", intentId)) {
        return fail("invalid_request", "The intent id is not an intent identifier.");
      }
      if (queued >= MAX_QUEUED_PUBLICATIONS) {
        return fail("busy", "Too many publications are waiting; try again.");
      }
      queued += 1;
      const run = tail.then(() => publish(context, deps(), mainRef, intentId));
      tail = run.catch(() => undefined);
      try {
        return await run;
      } finally {
        queued -= 1;
      }
    },
  };
}

async function publish(
  { log, clock }: MainWriterContext,
  deps: MainWriterDeps,
  mainRef: BoundedRef,
  intentId: IntentId,
): Promise<PortResult<MergeIntentRecord>> {
  for (let tries = 0; ; tries += 1) {
    let record = deps.authorization.record(intentId);
    // The async read tells an unknown intent from a missing module.
    if (record === null) return refusal(await deps.authorization.intent(intentId));
    if (record.status !== "authorized") return ok(record);

    const unsettled = deps.authorization.unsettled();
    if (unsettled.length > 0) {
      // A write may have landed unheard: read main and settle what it shows before writing.
      const main = await mainRef.read();
      if (!main.ok) return main;
      const settled = reconcile(log, deps, unsettled, main.value, intentId, clock());
      if (!settled.ok) return settled;
      record = deps.authorization.record(intentId);
      if (record === null) return refusal(await deps.authorization.intent(intentId));
      if (record.status !== "authorized") return ok(record);
      const others = settled.value.filter((pending) => pending.intentId !== intentId);
      if (others.length > 0 && record.expectedMain !== main.value) {
        return fail("unavailable", "An earlier write to main is unresolved; try again later.");
      }
    }

    if (tries >= MAX_WRITE_ATTEMPTS) {
      return fail("unavailable", "Main could not be confirmed moved; it will be read back again.");
    }
    const begun = begin(log, deps, record);
    if (!begun.ok) {
      // Main was read back at the expected commit, so an earlier attempt may still land: a fence
      // that moved since says nothing yet about whether this intent's work reaches main, until
      // the last attempt outlives the update lifetime.
      if (record.attempts > 0 && isFenceRefusal(begun.code)) {
        if (expired(record, clock())) {
          return settle(log, deps, record, "reconciled", record.expectedMain);
        }
        return fail("unavailable", "An earlier write of this intent may still land; try again.");
      }
      return begun;
    }
    const update = await mainRef.update(begun.value.expectedMain, begun.value.candidate);
    if (!update.ok) return update;
    switch (update.value.kind) {
      case "updated":
        return settle(log, deps, begun.value, "updated", begun.value.candidate);
      case "rejected": {
        // Main at the candidate after an earlier attempt means that attempt landed late.
        const landed = record.attempts > 0 && update.value.actual === begun.value.candidate;
        return settle(
          log,
          deps,
          begun.value,
          landed ? "reconciled" : "rejected",
          update.value.actual,
        );
      }
      case "uncertain":
        // The loop reads main back before deciding whether to write again.
        continue;
      case "timeout":
        return fail("unavailable", "Main did not answer in time; it will be read back first.");
      default:
        return unreachable(update.value);
    }
  }
}

/**
 * Settles every unsettled intent that `main` decides, each with its event, and returns the ones
 * whose write may still apply: those whose expected commit is still main. An intent other than
 * `publishing` whose last attempt has outlived the update lifetime is settled as not landed;
 * `publishing` itself may write again from the same commit, so `publish` decides it.
 */
function reconcile(
  log: EventLog,
  deps: MainWriterDeps,
  unsettled: readonly MergeIntentRecord[],
  main: CommitSha,
  publishing: IntentId,
  now: number,
): PortResult<MergeIntentRecord[]> {
  const pending: MergeIntentRecord[] = [];
  for (const record of unsettled) {
    const open = main === record.expectedMain && main !== record.candidate;
    if (open && (record.intentId === publishing || !expired(record, now))) {
      pending.push(record);
      continue;
    }
    const settled = settle(log, deps, record, "reconciled", main);
    if (!settled.ok) return settled;
  }
  return ok(pending);
}

/**
 * Fences one write attempt and counts it on the intent, in one transaction. Nothing is counted
 * when a fence refuses.
 */
function begin(
  log: EventLog,
  deps: MainWriterDeps,
  record: MergeIntentRecord,
): PortResult<MergeIntentRecord> {
  const { value } = log.transaction((): PortResult<MergeIntentRecord> => {
    const current = deps.authorization.record(record.intentId);
    if (
      current === null ||
      current.status !== "authorized" ||
      current.attempts !== record.attempts
    ) {
      return fail("busy", "The merge intent changed during publication; try again.");
    }
    const outcome = deps.attemptOutcome(current.checkAttemptId);
    if (outcome === null) {
      return fail("check_mismatch", "The check attempt the merge rests on is unknown.");
    }
    const fenced = checkFence(
      deps,
      current.pins,
      current.decisions,
      outcome.attempt.definition.acceptance?.decision ?? null,
    );
    if (!fenced.ok) return fenced;
    const counted = deps.authorization.recordWrite(current.intentId, current.attempts, {
      status: "authorized",
      attempts: current.attempts + 1,
      main: current.main,
    });
    return counted === null
      ? fail("busy", "The merge intent changed during publication; try again.")
      : ok(counted);
  });
  return value;
}

/** Records how the intent settled and appends `train.main`, in one transaction. */
function settle(
  log: EventLog,
  deps: MainWriterDeps,
  record: MergeIntentRecord,
  status: Exclude<MergeIntentStatus, "authorized">,
  main: CommitSha,
): PortResult<MergeIntentRecord> {
  const { value } = log.transaction((tx): PortResult<MergeIntentRecord> => {
    const settled = deps.authorization.recordWrite(record.intentId, record.attempts, {
      status,
      attempts: record.attempts,
      main,
    });
    if (settled === null) {
      return fail("busy", "The merge intent changed during publication; try again.");
    }
    tx.append(TRAIN_ACTOR, {
      type: "train.main",
      data: { intentId: settled.intentId, outcome: status, main },
    });
    return ok(settled);
  });
  return value;
}

/** A refusal from `begin` because the work the intent rests on is no longer current. */
function isFenceRefusal(code: PortErrorCode): boolean {
  return code === "stale_generation" || code === "decision_superseded" || code === "check_mismatch";
}

/** Whether the intent's last attempt is old enough that it can no longer apply. */
function expired(record: MergeIntentRecord, now: number): boolean {
  return now - record.updatedAt >= MAIN_UPDATE_LIFETIME_MS;
}

/** Passes on the refusal of an intent read that found no record. */
function refusal(result: PortResult<MergeIntentRecord>): PortResult<MergeIntentRecord> {
  return result.ok
    ? fail("busy", "The merge intent changed during publication; try again.")
    : result;
}

/** An update that did not answer before the deadline; it may still apply. */
type BoundedUpdate = MainUpdate | { kind: "timeout" };

/** Main's ref as the writer calls it, with every call bounded. */
interface BoundedRef {
  read(): Promise<PortResult<CommitSha>>;
  update(expected: CommitSha, next: CommitSha): Promise<PortResult<BoundedUpdate>>;
}

/** Main's ref with every call bounded by `timeoutMs`. A late answer is dropped. */
function boundedRef(ref: MainRefPort, timeoutMs: number): BoundedRef {
  return {
    read: () =>
      within(
        ref.read(),
        timeoutMs,
        fail("unavailable", "Main could not be read in time; try again."),
      ),
    update: (expected, next) =>
      within<BoundedUpdate>(ref.update(expected, next), timeoutMs, ok({ kind: "timeout" })),
  };
}

/** `call`'s result, or `late` if it has not settled after `timeoutMs`. */
async function within<T>(
  call: Promise<PortResult<T>>,
  timeoutMs: number,
  late: PortResult<T>,
): Promise<PortResult<T>> {
  // A failure after the deadline has no one waiting for it.
  call.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<PortResult<T>>((resolve) => {
    timer = setTimeout(() => resolve(late), timeoutMs);
  });
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled main update: ${JSON.stringify(value)}`);
}
