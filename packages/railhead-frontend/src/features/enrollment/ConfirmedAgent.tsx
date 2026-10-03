import { Badge, Text } from "@cloudflare/kumo";
import type { AgentState } from "../board/boardState";
import { RevokeAgent } from "./RevokeAgent";
import type { ActionAccess } from "./useOwnerAction";

interface ConfirmedAgentProps {
  agent: AgentState;
  access: ActionAccess;
}

/** A confirmed agent, which the owner may revoke. */
export const ConfirmedAgent = ({ agent, access }: ConfirmedAgentProps) => (
  <li className="grid gap-2 px-4 py-3">
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <Text bold DANGEROUS_className="min-w-0 break-words">
        {agent.name}
      </Text>
      <Badge variant="secondary">Confirmed</Badge>
    </div>
    <RevokeAgent agent={agent} access={access} stage="confirmed" />
  </li>
);
