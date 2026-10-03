import { useEffect, useRef, useState } from "react";
import type { AttemptControl } from "./ownerActions";

/** An attempt the board withdrew before it finished. `sent` says whether its last step was sent. */
export interface Withdrawn {
  kind: "withdrawn";
  sent: boolean;
}

/** One form's request: nothing yet, waiting on the backend or the passkey, or an outcome. */
export type AttemptState<Outcome> = { kind: "idle" } | { kind: "pending" } | Outcome | Withdrawn;

interface Attempt<Port> {
  port: Port;
  controller: AbortController;
  sent: boolean;
}

/**
 * Runs one attempt at a time against a port and keeps its latest outcome.
 *
 * An attempt belongs to the port it started with. When the port is withdrawn (`null`) or replaced,
 * or the form unmounts, the attempt is aborted and its late result is dropped, so a board that may
 * no longer show current state performs nothing more and a replaced session's form never shows the
 * old one's answer. The binding keeps one port object per session.
 */
export const usePortAttempt = <Port extends object, Outcome>(port: Port | null) => {
  const [state, setState] = useState<AttemptState<Outcome>>({ kind: "idle" });
  // `pending` is captured at render, so two submits in one tick would both pass it.
  const attempt = useRef<Attempt<Port> | null>(null);

  useEffect(
    () => () => {
      const current = attempt.current;
      if (current === null || current.port !== port) return;
      attempt.current = null;
      current.controller.abort();
      setState({ kind: "withdrawn", sent: current.sent });
    },
    [port],
  );

  /**
   * Runs `perform` against `started`, the port current at submit. Resolves to its outcome, or
   * `null` when another attempt is in flight or this one was withdrawn.
   */
  const start = async (
    started: Port,
    perform: (control: AttemptControl) => Promise<Outcome>,
  ): Promise<Outcome | null> => {
    if (attempt.current !== null) return null;
    const current: Attempt<Port> = {
      port: started,
      controller: new AbortController(),
      sent: false,
    };
    attempt.current = current;
    setState({ kind: "pending" });
    const outcome = await perform({
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

  return { state, start, reset: () => setState({ kind: "idle" }) };
};
