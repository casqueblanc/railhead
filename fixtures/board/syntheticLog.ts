// SYNTHETIC. Hand-written event logs for developing and testing the board. None of them is a
// captured run, and none may be presented as one. Every identifier carries `synth` so a synthetic
// log is recognisable on sight.

// The fixtures sit outside any package, so they reach the shared types by path.
import {
  eventVersion,
  type Actor,
  type AgentId,
  type CommitSha,
  type EventPayload,
  type RailheadEvent,
} from "../../packages/railhead-shared/src/events";

/** A hand-written event log. `synthetic` is always `true`; a captured run is never built here. */
export interface SyntheticLog {
  readonly synthetic: true;
  /** What the log shows, for a developer choosing a fixture. */
  readonly description: string;
  /** Gapless from seq 1. */
  readonly events: readonly RailheadEvent[];
}

/** One event before the log assigns its position, time and repository. */
export type SyntheticStep = EventPayload & { actor: Actor };

/** The repository every synthetic log belongs to. */
export const SYNTH_REPO = "rep_synthrepo";
/** The synthetic owner. */
export const SYNTH_OWNER: Actor = { kind: "human", id: "usr_synthowner" };
/** The synthetic train. */
export const SYNTH_TRAIN: Actor = { kind: "system", id: "sys_train" };
/** The synthetic adaptation recorder. */
export const SYNTH_ADAPTATION: Actor = { kind: "system", id: "sys_adaptation" };
/** The synthetic join service. */
export const SYNTH_GATEWAY: Actor = { kind: "system", id: "sys_gateway" };
/** The time of a synthetic log's first event: 1 October 2026, 00:00 UTC. */
export const SYNTH_START_MS = Date.UTC(2026, 9, 1);
/** Milliseconds between consecutive synthetic events. */
export const SYNTH_STEP_MS = 1000;

/** The actor for a synthetic agent. */
export const synthAgent = (id: AgentId): Actor => ({ kind: "agent", id });

/** A synthetic commit id: `5e` followed by `n` in hexadecimal, zero-padded to 40 characters. */
export const synthCommit = (n: number): CommitSha => `5e${n.toString(16).padStart(38, "0")}`;

/** Numbers `steps` from seq 1, one second apart, in the synthetic repository. */
export const syntheticLog = (
  description: string,
  steps: readonly SyntheticStep[],
): SyntheticLog => ({
  synthetic: true,
  description,
  events: steps.map((step, index): RailheadEvent => ({
    v: eventVersion(step.type),
    seq: index + 1,
    at: SYNTH_START_MS + index * SYNTH_STEP_MS,
    repo: SYNTH_REPO,
    ...step,
  })),
});

/**
 * The log as a reconnecting client receives it: events up to `overlapFrom + overlap - 1`, then a
 * replay from `overlapFrom` that repeats `overlap` events it already has, then the rest.
 */
export const withReplayOverlap = (
  log: SyntheticLog,
  overlapFrom: number,
  overlap: number,
): readonly RailheadEvent[] => {
  const cut = overlapFrom - 1 + overlap;
  return [...log.events.slice(0, cut), ...log.events.slice(overlapFrom - 1)];
};

/** The log with the events at `seqs` lost in transit. */
export const withLostEvents = (
  log: SyntheticLog,
  seqs: readonly number[],
): readonly RailheadEvent[] => log.events.filter((event) => !seqs.includes(event.seq));

/** The sequence number of the first event matching `predicate`; throws when none does. */
export const seqWhere = (
  log: SyntheticLog,
  predicate: (event: RailheadEvent) => boolean,
): number => {
  const event = log.events.find(predicate);
  if (event === undefined) throw new Error(`no event in "${log.description}" matches`);
  return event.seq;
};
