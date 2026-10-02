import { Badge, Button, Text } from "@cloudflare/kumo";
import { useState } from "react";
import type { AgentState } from "../board/boardState";
import { ActionMessage } from "./ActionMessage";
import { useOwnerAction, type ActionAccess } from "./useOwnerAction";

interface ConfirmedAgentProps {
  agent: AgentState;
  access: ActionAccess;
}

/**
 * A confirmed agent, which the owner may revoke after a second, explicit step. While actions are
 * blocked the revoke control is withdrawn; the section says why.
 */
export const ConfirmedAgent = ({ agent, access }: ConfirmedAgentProps) => {
  const [confirming, setConfirming] = useState(false);
  const { state, run } = useOwnerAction(access);
  const pending = state.kind === "pending";

  const onRevoke = async () => {
    const outcome = await run({ kind: "agent.revoke", agentId: agent.agentId });
    if (outcome?.kind !== "failed") setConfirming(false);
  };

  return (
    <li className="grid gap-2 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Text bold DANGEROUS_className="min-w-0 break-words">
            {agent.name}
          </Text>
          <Badge variant="secondary">Confirmed</Badge>
        </div>
        {!confirming && access.kind === "ready" && (
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            Revoke…
          </Button>
        )}
      </div>
      {confirming && (
        <div className="grid gap-2 rounded-lg bg-kumo-tint px-3 py-2">
          <Text>Revoke {agent.name}? Its next call to Railhead fails.</Text>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={access.kind === "blocked"}
              loading={pending}
              onClick={() => void onRevoke()}
            >
              {pending ? "Waiting for passkey…" : `Revoke ${agent.name}`}
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
        <ActionMessage
          state={state}
          cancelled={`Cancelled. ${agent.name} is still confirmed.`}
          performed={`Revoked. ${agent.name} shows as revoked once the log records it.`}
        />
      </div>
    </li>
  );
};
