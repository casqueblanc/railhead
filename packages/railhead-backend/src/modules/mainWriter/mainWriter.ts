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
// hearing it: the response was lost, or the object was recreated mid-write. So before any new
// write, the writer reads main back. Main at the candidate means the write landed; main anywhere
// else but the expected commit means main moved for another reason and the intent cannot apply;
// main still at the expected commit means the write never applied and may be tried again, within
// `MAX_WRITE_ATTEMPTS`. Nothing here forces main.

import { isId, type CommitSha, type IntentId } from "@railhead/shared/events";
import type { ClaimId, DecisionRef } from "@railhead/shared/events";
import { fail, ok, type PortResult } from "../../contracts/result";
import type {
  AuthorizationPort,
  MainRefPort,
  MainWriterPort,
  MergeIntentRecord,
  MergeIntentStatus,
} from "../../contracts/train";
import type { EventLog } from "../../repo/eventLog";
import { TRAIN_ACTOR } from "../../train/authorize";

/** Write attempts one intent may make before the writer stops trying and only reads main back. */
export const MAX_WRITE_ATTEMPTS = 3;

/** Publications that may wait behind the one in progress before more are refused as `busy`. */
export const MAX_QUEUED_PUBLICATIONS = 32;

/** What the main writer needs from its Repo. */
export interface MainWriterContext {
  /** The event log, whose transactions fence each attempt and record each outcome. */
  readonly log: EventLog;
}

/**
 * The other modules the writer reads, resolved when a publication runs. The two fence readers are
 * called only inside the writer's transaction; `null` from either refuses the write.
 */
export interface MainWriterDeps {
  /** The intents and their progress. */
  readonly authorization: AuthorizationPort;
  /** The claim's current ownership generation, or `null`. */
  currentGeneration(claimId: ClaimId): number | null;
  /** The current version of every decision the claim's work must satisfy, or `null`. */
  currentVersions(claimId: ClaimId): DecisionRef[] | null;
}

/** Builds the main writer over main's ref. */
export function createMainWriter(
  context: MainWriterContext,
  deps: () => MainWriterDeps,
  mainRef: MainRefPort,
): MainWriterPort {
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
      const run = tail.then(() => publish(context.log, deps(), mainRef, intentId));
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
  log: EventLog,
  deps: MainWriterDeps,
  mainRef: MainRefPort,
  intentId: IntentId,
): Promise<PortResult<MergeIntentRecord>> {
  for (;;) {
    const record = deps.authorization.record(intentId);
    // The async read tells an unknown intent from a missing module.
    if (record === null) return refusal(await deps.authorization.intent(intentId));
    if (record.status !== "authorized") return ok(record);

    if (record.attempts > 0) {
      // An earlier attempt may have landed unheard: read main before anything else.
      const main = await mainRef.read();
      if (!main.ok) return main;
      if (main.value !== record.expectedMain) {
        return settle(log, deps, record, "reconciled", main.value);
      }
    }

    const begun = begin(log, deps, record);
    if (!begun.ok) return begun;
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
      default:
        return unreachable(update.value);
    }
  }
}

/**
 * Fences one write attempt and counts it on the intent, in one transaction. Nothing is counted
 * when a fence refuses or the attempts are used up.
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
    if (current.attempts >= MAX_WRITE_ATTEMPTS) {
      return fail("unavailable", "Main could not be confirmed moved; it will be read back again.");
    }
    for (const pin of current.pins) {
      if (deps.currentGeneration(pin.claimId) !== pin.generation) {
        return fail("stale_generation", "A claim changed owner since the merge was authorized.");
      }
    }
    const authorized = new Map(current.decisions.map((ref) => [ref.decisionId, ref.version]));
    for (const pin of current.pins) {
      const refs = deps.currentVersions(pin.claimId);
      if (refs === null) {
        return fail("decision_superseded", "The decisions a claim must satisfy are unknown.");
      }
      for (const ref of refs) {
        if (authorized.get(ref.decisionId) !== ref.version) {
          return fail("decision_superseded", "A decision changed since the merge was authorized.");
        }
      }
    }
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

/** Passes on the refusal of an intent read that found no record. */
function refusal(result: PortResult<MergeIntentRecord>): PortResult<MergeIntentRecord> {
  return result.ok
    ? fail("busy", "The merge intent changed during publication; try again.")
    : result;
}

function unreachable(value: never): never {
  throw new Error(`unhandled main update: ${JSON.stringify(value)}`);
}
