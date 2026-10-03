// The result every internal port returns: a value, or a closed error code. Ports never throw for an
// expected refusal, so an adapter maps each code to the agent wire or the board without guessing.

import type { AgentErrorCode } from "@railhead/shared/agent-api";
import type { BoardErrorCode } from "@railhead/shared/board-api";

/** Refusals that only the train's internal ports produce. */
export type TrainErrorCode =
  /** A decision the work relied on has a newer version than the one recorded. */
  | "decision_superseded"
  /** A check report does not match the persisted attempt, candidate or definition. */
  | "check_mismatch"
  /** The check for this candidate did not pass, or has not finished. */
  | "check_not_passed"
  /** The candidate edits its check definition or a path it protects; a person must approve it. */
  | "check_held"
  /** Main is no longer at the expected commit. */
  | "main_moved";

/** Every code a port may fail with. */
export type PortErrorCode = AgentErrorCode | BoardErrorCode | TrainErrorCode;

/** A port's refusal. `message` is written by the backend and never echoes untrusted text. */
export interface PortFailure {
  /** Always `false`. */
  ok: false;
  /** Why. */
  code: PortErrorCode;
  /** One sentence for the caller. */
  message: string;
}

/** A port's result. */
export type PortResult<T> = { ok: true; value: T } | PortFailure;

/** The names of the ports, as `unavailable` failures report them. */
export type PortName =
  | "identity"
  | "sessions"
  | "claims"
  | "inbox"
  | "decisions"
  | "artifacts"
  | "merge"
  | "checks"
  | "train"
  | "authorization"
  | "mainWriter";

/** A successful result. */
export function ok<T>(value: T): PortResult<T> {
  return { ok: true, value };
}

/** A refusal with `code`. */
export function fail(code: PortErrorCode, message: string): PortFailure {
  return { ok: false, code, message };
}

/** The refusal of a port whose module is not installed. It had no effect. */
export function unavailable(port: PortName): PortFailure {
  return fail("unavailable", `The ${port} module is not available.`);
}
