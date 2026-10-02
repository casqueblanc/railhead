import { Badge, Table, Text } from "@cloudflare/kumo";
import type { AgentState, InboxDelivery, RippleRow } from "../board/boardState";

interface DecisionRippleTableProps {
  version: number;
  rows: readonly RippleRow[];
  agents: Readonly<Record<string, AgentState>>;
}

const DELIVERY_LABEL: Record<InboxDelivery, string> = {
  queued: "Queued",
  delivered: "Delivered",
  acknowledged: "Acknowledged",
};

/**
 * Where the current version stands with each agent. Delivery and acknowledgement come from the
 * agent's inbox; "Adapted" is the system's verdict on landed work and never the agent's word.
 */
export const DecisionRippleTable = ({ version, rows, agents }: DecisionRippleTableProps) => {
  if (rows.length === 0) {
    return <Text variant="secondary">No agent has been sent version {version} yet.</Text>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <caption className="sr-only">Agents sent version {version}</caption>
        <Table.Header>
          <Table.Row>
            <Table.Head>Agent</Table.Head>
            <Table.Head>Delivery</Table.Head>
            <Table.Head>Adapted</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((row) => (
            <Table.Row key={`${row.agentId}/${row.claimId}`}>
              <Table.Cell className="max-w-48 break-words">
                {Object.hasOwn(agents, row.agentId) ? agents[row.agentId]?.name : row.agentId}
              </Table.Cell>
              <Table.Cell>{DELIVERY_LABEL[row.delivery]}</Table.Cell>
              <Table.Cell>
                {row.adapted ? (
                  <Badge variant="success">Adapted</Badge>
                ) : (
                  <Text as="span" variant="secondary">
                    Not yet
                  </Text>
                )}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
};
