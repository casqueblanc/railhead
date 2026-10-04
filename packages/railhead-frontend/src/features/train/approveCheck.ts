// Approving a held check, end to end: ask the backend for a challenge bound to the exact attempt,
// candidate and definition digest, have the owner's authenticator sign it, and perform it with that
// assertion.
//
// The approval runs a definition the candidate wrote instead of main's, so the board sends exactly
// the digest the log recorded for that hold and shows the check as approved only once the log
// records it. Once the signed approval is sent, only a refusal the backend states is proof that
// nothing was approved; a lost answer leaves it unconfirmed until the log says.

import type { BoardErrorCode, BoardFailure } from "@railhead/shared/board-api";
import type { HeldCheckState } from "../board/boardState";
import type { AttemptControl, AvailableOwnerPort } from "../enrollment/ownerActions";
import { signAction, type Authenticator } from "../enrollment/webauthn";

/** What became of one approval. Messages are shown as plain text. */
export type ApproveOutcome =
  | { kind: "approved" }
  /** The owner dismissed the passkey prompt. Nothing was approved. */
  | { kind: "cancelled" }
  /** The approval was refused or never sent. Nothing was approved. */
  | { kind: "failed"; message: string }
  /** The approval was sent and its result is unknown. The backend may have recorded it. */
  | { kind: "unconfirmed" }
  /**
   * The board withdrew the approval before it finished. `sent` says whether `perform` had already
   * been called, in which case the backend may still have recorded it.
   */
  | { kind: "withdrawn"; sent: boolean };

/**
 * Approves running `held`'s candidate definition with a fresh passkey assertion, unless
 * `control.signal` aborts before it is sent. `held` must have a digest. Never throws.
 */
export const approveCheck = async (
  owner: AvailableOwnerPort,
  authenticator: Authenticator,
  held: HeldCheckState & { digest: string },
  control: AttemptControl,
): Promise<ApproveOutcome> => {
  const { signal } = control;
  let sent = false;
  try {
    const prepared = await owner.onPrepareAction({
      kind: "check.approve",
      checkRunId: held.checkRunId,
      candidate: held.candidate,
      digest: held.digest,
    });
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
    sent = true;
    const performed = await owner.onPerformAction(prepared.value.challengeId, signed.value);
    if (signal.aborted) return { kind: "withdrawn", sent: true };
    if (!performed.ok) return refusedAfterSending(performed) ? failed(performed) : UNCONFIRMED;
    const { value } = performed;
    if (value.kind !== "check.approve" || value.checkRunId !== held.checkRunId) return UNCONFIRMED;
    return { kind: "approved" };
  } catch {
    return sent ? UNCONFIRMED : { kind: "failed", message: NOT_SENT };
  }
};

const UNCONFIRMED: ApproveOutcome = { kind: "unconfirmed" };

const NOT_SENT = "The approval could not be sent. Nothing was approved. Try again.";

const failed = (failure: BoardFailure): ApproveOutcome => ({
  kind: "failed",
  message: failureMessage(failure.code),
});

/** Whether a failed `perform` proves nothing was approved. See `fileIssue` for the same rule. */
const refusedAfterSending = (failure: BoardFailure): boolean => {
  switch (failure.code) {
    case "proof_invalid":
    case "proof_expired":
    case "action_stale":
    case "quota_exceeded":
    case "unavailable":
    case "invalid_request":
    case "not_found":
    case "bootstrap_closed":
    case "busy":
      return true;
    case "cursor_ahead":
    case "internal":
      return false;
    default:
      return unreachable(failure.code);
  }
};

/**
 * The sentence for an approval refused before or after it was sent. The backend's own message is
 * untrusted text, so the board names the outcome from the closed code.
 */
export const failureMessage = (code: BoardErrorCode): string => {
  switch (code) {
    case "proof_invalid":
      return "The passkey did not verify for this approval. Nothing was approved.";
    case "proof_expired":
      return "The passkey request expired or was already used. Approve again.";
    case "action_stale":
      return "This check is no longer held for that definition. Nothing was approved.";
    case "quota_exceeded":
      return "A limit was reached. Nothing was approved.";
    case "unavailable":
      return "This Railhead cannot approve held checks: its checks module is not installed.";
    case "busy":
      return "The backend is busy. Nothing was approved; try again shortly.";
    case "invalid_request":
      return "The backend refused the approval as invalid. Nothing was approved.";
    case "not_found":
      return "The repository is not available to this board.";
    case "bootstrap_closed":
      return "The backend refused the owner passkey. Nothing was approved.";
    case "cursor_ahead":
    case "internal":
      return NOT_SENT;
    default:
      return unreachable(code);
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled approval variant: ${JSON.stringify(value)}`);
};
