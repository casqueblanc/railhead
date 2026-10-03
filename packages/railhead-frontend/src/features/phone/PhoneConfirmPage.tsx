import { Badge, Empty, LayerCard, Text } from "@cloudflare/kumo";
import { LinkBreakIcon } from "@phosphor-icons/react";
import type { AgentId } from "@railhead/shared/events";
import { gateOnConnection, type BoardPorts, type OwnerPort } from "../board/boardPorts";
import type { BoardState } from "../board/boardState";
import { AwaitingAgent } from "../enrollment/AwaitingAgent";
import { BlockedNote } from "../enrollment/BlockedNote";
import { actionAccess } from "../enrollment/EnrollmentPanel";
import { unreachable } from "../enrollment/ownerActions";
import type { Authenticator } from "../enrollment/webauthn";
import { InvalidLink } from "./InvalidLink";
import { PhoneFrame } from "./PhoneFrame";
import type { PhoneTarget } from "./phoneLinks";

interface PhoneConfirmPageProps {
  ports: BoardPorts;
  /** The agent the link names. The link grants nothing; confirming needs the code and a passkey. */
  target: PhoneTarget<AgentId>;
  /** The browser's authenticator, or `null` when this page cannot use passkeys. */
  authenticator: Authenticator | null;
}

/**
 * One agent's join confirmation, opened from a link on a phone. The owner types the code the
 * agent's terminal shows; neither the link nor this page carries it.
 */
export const PhoneConfirmPage = ({ ports, target, authenticator }: PhoneConfirmPageProps) => {
  const gated = gateOnConnection(ports);
  if (target.kind === "invalid") return <InvalidLink />;
  return (
    <PhoneFrame ports={gated} title="Confirm an agent">
      {(board) => (
        <Agent
          board={board}
          agentId={target.id}
          owner={gated.owner}
          authenticator={authenticator}
        />
      )}
    </PhoneFrame>
  );
};

interface AgentProps {
  board: BoardState;
  agentId: AgentId;
  owner: OwnerPort;
  authenticator: Authenticator | null;
}

const Agent = ({ board, agentId, owner, authenticator }: AgentProps) => {
  const agent = Object.hasOwn(board.agents, agentId) ? board.agents[agentId] : undefined;
  if (agent === undefined) {
    return (
      <Empty
        icon={<LinkBreakIcon size={48} aria-hidden="true" />}
        title="This agent is not on the board"
        description="The link may be for another Railhead, or the board has not reached it yet. Open the board to see the agents waiting for you."
      />
    );
  }
  switch (agent.status) {
    case "awaiting_confirmation": {
      const access = actionAccess(owner, authenticator, board.stream);
      return (
        <LayerCard>
          <LayerCard.Secondary>Waiting for you</LayerCard.Secondary>
          <LayerCard.Primary className="grid gap-0 p-0">
            {access.kind === "blocked" && (
              <div className="px-4 pt-3">
                <BlockedNote block={access.block} />
              </div>
            )}
            <ul>
              <AwaitingAgent key={agent.agentId} agent={agent} access={access} />
            </ul>
          </LayerCard.Primary>
        </LayerCard>
      );
    }
    case "confirmed":
    case "revoked":
      return (
        <LayerCard>
          <LayerCard.Primary className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3">
            <Text bold DANGEROUS_className="min-w-0 break-words">
              {agent.name}
            </Text>
            <Badge variant="neutral">
              {agent.status === "confirmed" ? "Confirmed" : "Revoked"}
            </Badge>
            <Text as="span" variant="secondary">
              {agent.status === "confirmed"
                ? "Nothing to confirm: the agent can already work."
                : "Nothing to confirm: the agent was revoked and cannot work."}
            </Text>
          </LayerCard.Primary>
        </LayerCard>
      );
    default:
      return unreachable(agent.status);
  }
};
