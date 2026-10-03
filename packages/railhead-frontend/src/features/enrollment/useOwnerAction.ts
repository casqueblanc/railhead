import {
  performOwnerAction,
  type ActionOutcome,
  type AvailableOwnerPort,
  type EnrollmentAction,
  type EnrollmentBlock,
} from "./ownerActions";
import { usePortAttempt, type AttemptState } from "./usePortAttempt";
import type { Authenticator } from "./webauthn";

/** Whether an action can be asked for from this board, and with what. */
export type ActionAccess =
  | { kind: "ready"; owner: AvailableOwnerPort; authenticator: Authenticator }
  | { kind: "blocked"; block: EnrollmentBlock };

/** One form's request: nothing yet, waiting on the backend or the passkey, or an outcome. */
export type ActionState = AttemptState<ActionOutcome>;

/**
 * Runs one owner action at a time for a form and keeps its latest outcome. The attempt belongs to
 * the owner port it started with; see {@link usePortAttempt} for what happens when access changes.
 */
export const useOwnerAction = (access: ActionAccess) => {
  const { state, start, reset } = usePortAttempt<AvailableOwnerPort, ActionOutcome>(
    access.kind === "ready" ? access.owner : null,
  );

  const run = async (action: EnrollmentAction): Promise<ActionOutcome | null> => {
    if (access.kind !== "ready") return null;
    const { owner, authenticator } = access;
    return start(owner, (control) => performOwnerAction(owner, authenticator, action, control));
  };

  return { state, run, reset };
};
