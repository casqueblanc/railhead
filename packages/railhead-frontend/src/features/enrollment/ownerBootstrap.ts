// Enrolling the instance owner's first passkey with the operator's one-time bootstrap token.
//
// The token is only ever typed by the owner and sent once to `onPrepareEnrollment`; the board never
// reads it from the URL, stores it or offers another way in. A dismissed prompt stops before
// `onCompleteEnrollment`, so enrollment stays open and the owner can try again.
//
// The board can lose its session, or the panel can unmount, while enrollment waits on the backend
// or the passkey. The caller then aborts the attempt: the prompt is cancelled where the browser
// allows, and nothing more is sent after the abort.
//
// The backend answers `bootstrap_closed` both for a wrong token and once an owner exists, so a
// closed enrollment never shows that a particular passkey was enrolled. When the outcome of a sent
// passkey is unknown, the owner checks it with an owner action instead.

import type { UserId } from "@railhead/shared/events";
import type { EnrollmentPort } from "../board/boardPorts";
import { failureMessage, unreachable, type AttemptControl } from "./ownerActions";
import { registerPasskey, type Authenticator } from "./webauthn";

/** What to tell the owner when a sent passkey may or may not have been enrolled. */
export const UNCONFIRMED_ENROLLMENT =
  "Enrollment was not confirmed after the passkey was sent. Try again; if enrollment is closed, that does not show this passkey was enrolled, so check it with an owner action.";

/** The callbacks of an available enrollment port. */
export type AvailableEnrollmentPort = Extract<EnrollmentPort, { kind: "available" }>;

/** What became of one enrollment attempt. Messages are shown as plain text. */
export type BootstrapOutcome =
  | { kind: "enrolled"; ownerId: UserId }
  /** The owner dismissed the passkey prompt. Nothing was enrolled. */
  | { kind: "cancelled" }
  | { kind: "failed"; message: string }
  /**
   * The board withdrew enrollment before it finished. `sent` says whether the passkey had already
   * been sent to `onCompleteEnrollment`, in which case it may have been enrolled.
   */
  | { kind: "withdrawn"; sent: boolean };

/**
 * Enrolls the owner's passkey with `bootstrapToken`, unless `control.signal` aborts before the
 * passkey is sent. Never throws.
 */
export const enrollOwner = async (
  enrollment: AvailableEnrollmentPort,
  authenticator: Authenticator,
  bootstrapToken: string,
  control: AttemptControl,
): Promise<BootstrapOutcome> => {
  const { signal } = control;
  let sent = false;
  try {
    const prepared = await enrollment.onPrepareEnrollment(bootstrapToken);
    if (signal.aborted) return { kind: "withdrawn", sent: false };
    if (!prepared.ok) return { kind: "failed", message: failureMessage(prepared.code) };
    const registered = await registerPasskey(authenticator, prepared.value, signal);
    if (signal.aborted) return { kind: "withdrawn", sent: false };
    switch (registered.kind) {
      case "cancelled":
      case "failed":
        return registered;
      case "done":
        break;
      default:
        return unreachable(registered);
    }
    sent = true;
    control.onSent();
    const completed = await enrollment.onCompleteEnrollment(
      prepared.value.challengeId,
      registered.value,
    );
    if (signal.aborted) return { kind: "withdrawn", sent: true };
    if (!completed.ok) return { kind: "failed", message: failureMessage(completed.code) };
    return { kind: "enrolled", ownerId: completed.value.ownerId };
  } catch {
    return {
      kind: "failed",
      message: sent
        ? UNCONFIRMED_ENROLLMENT
        : "Enrollment failed before the passkey was sent. Nothing was enrolled. Try again.",
    };
  }
};
