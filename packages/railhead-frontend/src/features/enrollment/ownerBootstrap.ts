// Enrolling the instance owner's first passkey with the operator's one-time bootstrap token.
//
// The token is only ever typed by the owner and sent once to `onPrepareEnrollment`; the board never
// reads it from the URL, stores it or offers another way in. A dismissed prompt stops before
// `onCompleteEnrollment`, so enrollment stays open and the owner can try again.

import type { UserId } from "@railhead/shared/events";
import type { EnrollmentPort } from "../board/boardPorts";
import { failureMessage, unreachable } from "./ownerActions";
import { registerPasskey, type Authenticator } from "./webauthn";

/** The callbacks of an available enrollment port. */
export type AvailableEnrollmentPort = Extract<EnrollmentPort, { kind: "available" }>;

/** What became of one enrollment attempt. Messages are shown as plain text. */
export type BootstrapOutcome =
  | { kind: "enrolled"; ownerId: UserId }
  /** The owner dismissed the passkey prompt. Nothing was enrolled. */
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

/** Enrolls the owner's passkey with `bootstrapToken`. Never throws. */
export const enrollOwner = async (
  enrollment: AvailableEnrollmentPort,
  authenticator: Authenticator,
  bootstrapToken: string,
): Promise<BootstrapOutcome> => {
  try {
    const prepared = await enrollment.onPrepareEnrollment(bootstrapToken);
    if (!prepared.ok) return { kind: "failed", message: failureMessage(prepared.code) };
    const registered = await registerPasskey(authenticator, prepared.value);
    switch (registered.kind) {
      case "cancelled":
      case "failed":
        return registered;
      case "done":
        break;
      default:
        return unreachable(registered);
    }
    const completed = await enrollment.onCompleteEnrollment(
      prepared.value.challengeId,
      registered.value,
    );
    if (!completed.ok) return { kind: "failed", message: failureMessage(completed.code) };
    return { kind: "enrolled", ownerId: completed.value.ownerId };
  } catch {
    return {
      kind: "failed",
      message:
        "Enrollment was not confirmed. Try again; if enrollment is closed, the passkey was enrolled.",
    };
  }
};
