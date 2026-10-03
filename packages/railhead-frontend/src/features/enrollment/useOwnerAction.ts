import { useEffect, useRef, useState } from "react";
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

interface Attempt {
  owner: AvailableOwnerPort;
  controller: AbortController;
  sent: boolean;
}

/**
 * Runs one owner action at a time for a form and keeps its latest outcome.
 *
 * An attempt belongs to the owner port it started with. When access is blocked, the port is
 * replaced or the form unmounts, the attempt is aborted and its late result is dropped, so a board
 * that may no longer show current enrollment performs nothing more and a replaced session's form
 * never shows the old one's answer. The binding keeps one owner port object per session.
 */
export const useOwnerAction = (access: ActionAccess) => {
  const [state, setState] = useState<ActionState>({ kind: "idle" });
  // `pending` is captured at render, so two submits in one tick would both pass it.
  const attempt = useRef<Attempt | null>(null);
  const owner = access.kind === "ready" ? access.owner : null;

  useEffect(
    () => () => {
      const current = attempt.current;
      if (current === null || current.owner !== owner) return;
      attempt.current = null;
      current.controller.abort();
      setState({ kind: "withdrawn", sent: current.sent });
    },
    [owner],
  );

  const run = async (action: EnrollmentAction): Promise<ActionOutcome | null> => {
    if (access.kind !== "ready" || attempt.current !== null) return null;
    const current: Attempt = {
      owner: access.owner,
      controller: new AbortController(),
      sent: false,
    };
    attempt.current = current;
    setState({ kind: "pending" });
    const outcome = await performOwnerAction(access.owner, access.authenticator, action, {
      signal: current.controller.signal,
      onSent: () => {
        current.sent = true;
      },
    });
    if (attempt.current !== current) return null;
    attempt.current = null;
    setState(outcome);
    return outcome;
  };

  return { state, run, reset: () => setState({ kind: "idle" }) };
};
