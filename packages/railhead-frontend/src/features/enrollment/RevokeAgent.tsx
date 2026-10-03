import { Button, Text } from "@cloudflare/kumo";
import { useState } from "react";
import type { AgentState } from "../board/boardState";
import { ActionMessage } from "./ActionMessage";
import { unreachable } from "./ownerActions";
import { useOwnerAction, type ActionAccess } from "./useOwnerAction";

interface RevokeAgentProps {
  agent: AgentState;
  access: ActionAccess;
  /** A confirmed agent is revoked; one still awaiting confirmation is rejected. */
  stage: "confirmed" | "awaiting";
}

const copy = (stage: RevokeAgentProps["stage"], name: string) => {
  switch (stage) {
    case "confirmed":
      return {
        open: "Revoke…",
        question: `Revoke ${name}? Its next call to Railhead fails.`,
        act: `Revoke ${name}`,
        cancelled: `Cancelled. ${name} is still confirmed.`,
        performed: `Revoked. ${name} shows as revoked once the log records it.`,
      };
    case "awaiting":
      return {
        open: "Reject…",
        question: `Reject ${name}? It is revoked without ever being confirmed.`,
        act: `Reject ${name}`,
        cancelled: `Cancelled. ${name} still waits for confirmation.`,
        performed: `Rejected. ${name} shows as revoked once the log records it.`,
      };
    default:
      return unreachable(stage);
  }
};

/**
 * Revokes an agent after a second, explicit step and a passkey assertion. While actions are blocked
 * the control is withdrawn; the section says why.
 */
export const RevokeAgent = ({ agent, access, stage }: RevokeAgentProps) => {
  const [confirming, setConfirming] = useState(false);
  const { state, run } = useOwnerAction(access);
  const pending = state.kind === "pending";
  const text = copy(stage, agent.name);

  const onRevoke = async () => {
    const outcome = await run({ kind: "agent.revoke", agentId: agent.agentId });
    if (outcome?.kind !== "failed") setConfirming(false);
  };

  return (
    <div className="grid gap-2">
      {!confirming && access.kind === "ready" && (
        <div>
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            {text.open}
          </Button>
        </div>
      )}
      {confirming && (
        <div className="grid gap-2 rounded-lg bg-kumo-tint px-3 py-2">
          <Text>{text.question}</Text>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={access.kind === "blocked"}
              loading={pending}
              onClick={() => void onRevoke()}
            >
              {pending ? "Waiting for passkey…" : text.act}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              Keep
            </Button>
          </div>
        </div>
      )}
      <div aria-live="polite">
        <ActionMessage state={state} cancelled={text.cancelled} performed={text.performed} />
      </div>
    </div>
  );
};
