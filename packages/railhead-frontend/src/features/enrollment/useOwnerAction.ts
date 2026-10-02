import { useRef, useState } from "react";
import {
  performOwnerAction,
  type ActionOutcome,
  type AvailableOwnerPort,
  type EnrollmentAction,
  type EnrollmentBlock,
} from "./ownerActions";
import type { Authenticator } from "./webauthn";

/** Whether an action can be asked for from this board, and with what. */
export type ActionAccess =
  | { kind: "ready"; owner: AvailableOwnerPort; authenticator: Authenticator }
  | { kind: "blocked"; block: EnrollmentBlock };

/** One form's request: nothing yet, waiting on the backend or the passkey, or an outcome. */
export type ActionState = { kind: "idle" } | { kind: "pending" } | ActionOutcome;

/** Runs one owner action at a time for a form and keeps its latest outcome. */
export const useOwnerAction = (access: ActionAccess) => {
  const [state, setState] = useState<ActionState>({ kind: "idle" });
  // `pending` is captured at render, so two submits in one tick would both pass it.
  const inFlight = useRef(false);

  const run = async (action: EnrollmentAction): Promise<ActionOutcome | null> => {
    if (access.kind !== "ready" || inFlight.current) return null;
    inFlight.current = true;
    setState({ kind: "pending" });
    const outcome = await performOwnerAction(access.owner, access.authenticator, action);
    inFlight.current = false;
    setState(outcome);
    return outcome;
  };

  return { state, run, reset: () => setState({ kind: "idle" }) };
};
