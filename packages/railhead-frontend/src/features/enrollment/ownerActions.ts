// One owner action, end to end: ask the backend for a challenge bound to the action, have the
// owner's authenticator sign it, and perform it with that assertion.
//
// There is no path that performs without a fresh assertion. A dismissed prompt stops before
// `perform`, so whatever the action would have changed stays as the log last said. A result that
// names a different action or agent than the one asked for is reported as a failure, not shown as
// success.
//
// The board can stop showing current enrollment, or lose its session, while an action waits on the
// backend or the passkey. The caller then aborts the attempt: the ceremony is cancelled where the
// browser allows, and nothing is performed after the abort.

import type {
  BoardErrorCode,
  BoardFailure,
  OwnerAction,
  OwnerActionResult,
} from "@railhead/shared/board-api";
import type { OwnerPort, OwnerUnavailableReason } from "../board/boardPorts";
import { signAction, type Authenticator } from "./webauthn";

/** The enrollment actions this feature performs. */
export type EnrollmentAction = Extract<
  OwnerAction,
  { kind: "invite.create" | "agent.confirm" | "agent.revoke" }
>;

/** The result the backend reports for an enrollment action. */
export type EnrollmentResult = Extract<OwnerActionResult, { kind: EnrollmentAction["kind"] }>;

/** What became of one action. Messages are shown as plain text. */
export type ActionOutcome =
  | { kind: "performed"; result: EnrollmentResult }
  /** The owner dismissed the passkey prompt. Nothing was performed. */
  | { kind: "cancelled" }
  | { kind: "failed"; message: string }
  /**
   * The board withdrew the action before it finished. `sent` says whether `perform` had already
   * been called, in which case the backend may still have performed it.
   */
  | { kind: "withdrawn"; sent: boolean };

/** How the caller stops an attempt and learns when it reached the backend. */
export interface AttemptControl {
  /** Aborted when the board withdraws the action. */
  signal: AbortSignal;
  /** Called just before the signed action is sent to be performed. */
  onSent: () => void;
}

/** The callbacks of an available owner port. */
export type AvailableOwnerPort = Extract<OwnerPort, { kind: "available" }>;

/** Why this board cannot perform enrollment actions right now. */
export type EnrollmentBlock =
  | { kind: "unavailable"; reason: OwnerUnavailableReason }
  /** This browser cannot use passkeys here. */
  | { kind: "no_authenticator" }
  /** The board is missing events, so it may not show who is enrolled. */
  | { kind: "behind" }
  /** The board stopped reading the log. */
  | { kind: "halted" };

/**
 * Performs `action` with a fresh passkey assertion, unless `control.signal` aborts before it is
 * sent. Never throws.
 */
export const performOwnerAction = async (
  owner: AvailableOwnerPort,
  authenticator: Authenticator,
  action: EnrollmentAction,
  control: AttemptControl,
): Promise<ActionOutcome> => {
  const { signal } = control;
  try {
    const prepared = await owner.onPrepareAction(action);
    if (signal.aborted) return { kind: "withdrawn", sent: false };
    if (!prepared.ok) return failed(prepared);
    const signed = await signAction(authenticator, prepared.value, signal);
    if (signal.aborted) return { kind: "withdrawn", sent: false };
    switch (signed.kind) {
      case "cancelled":
        return signed;
      case "failed":
        return signed;
      case "done":
        break;
      default:
        return unreachable(signed);
    }
    control.onSent();
    const performed = await owner.onPerformAction(prepared.value.challengeId, signed.value);
    if (signal.aborted) return { kind: "withdrawn", sent: true };
    if (!performed.ok) return failed(performed);
    const result = matching(action, performed.value);
    if (result === null) {
      return {
        kind: "failed",
        message:
          "The backend answered for a different action. Check the agents list before retrying.",
      };
    }
    return { kind: "performed", result };
  } catch {
    return {
      kind: "failed",
      message: "The action was not confirmed. Check the agents list before retrying.",
    };
  }
};

/** The result if it answers `action` itself, or `null`. */
const matching = (action: EnrollmentAction, result: OwnerActionResult): EnrollmentResult | null => {
  switch (result.kind) {
    case "invite.create":
      return action.kind === "invite.create" ? result : null;
    case "agent.confirm":
    case "agent.revoke":
      return action.kind === result.kind && action.agentId === result.agentId ? result : null;
    case "issue.file":
    case "decision.record":
      return null;
    default:
      return unreachable(result);
  }
};

const failed = (failure: BoardFailure): ActionOutcome => ({
  kind: "failed",
  message: failureMessage(failure.code),
});

/**
 * The sentence for a refused action. The backend's own message is untrusted text and may change
 * with its version, so the board names the outcome from the closed code.
 */
export const failureMessage = (code: BoardErrorCode): string => {
  switch (code) {
    case "proof_invalid":
      return "The passkey did not verify for this action. Nothing changed.";
    case "proof_expired":
      return "The passkey request expired or was already used. Try again.";
    case "action_stale":
      return "The action no longer applies: the code differs or the agent changed. Nothing changed.";
    case "quota_exceeded":
      return "The invite limit was reached. Revoke an unused agent or wait for an invite to expire.";
    case "unavailable":
      return "This Railhead cannot perform the action: its module is not installed.";
    case "invalid_request":
      return "The backend refused the request as invalid. Nothing changed.";
    case "not_found":
      return "The repository is not available to this board.";
    case "bootstrap_closed":
      return "This Railhead already has an owner, or the bootstrap token is wrong. Use an owner passkey you already hold; if none is accepted, ask the operator.";
    case "cursor_ahead":
    case "internal":
      return "The backend failed. Check the agents list, then try again.";
    default:
      return unreachable(code);
  }
};

/** The sentence shown beside a blocked action. */
export const blockMessage = (block: EnrollmentBlock): string => {
  switch (block.kind) {
    case "behind":
      return "Blocked while the board catches up with missing events.";
    case "halted":
      return "Blocked because the board stopped reading the log. Reload the board.";
    case "no_authenticator":
      return "Blocked: this browser cannot use a passkey on this page.";
    case "unavailable":
      switch (block.reason) {
        case "offline":
          return "Blocked while the board is offline. Reconnect to act.";
        case "module_unavailable":
          return "Unavailable: this Railhead has no owner actions installed.";
        default:
          return unreachable(block.reason);
      }
    default:
      return unreachable(block);
  }
};

export const unreachable = (value: never): never => {
  throw new Error(`unhandled enrollment variant: ${JSON.stringify(value)}`);
};
