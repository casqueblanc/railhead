import { Badge, Empty, LayerCard, SkeletonLine, Text } from "@cloudflare/kumo";
import { RobotIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { EnrollmentPort, OwnerPort } from "../board/boardPorts";
import type { BoardState, StreamStatus } from "../board/boardState";
import { feedView, type BoardFeed } from "../claims/boardFeed";
import { AwaitingAgent } from "./AwaitingAgent";
import { BlockedNote } from "./BlockedNote";
import { ConfirmedAgent } from "./ConfirmedAgent";
import { InviteForm } from "./InviteForm";
import { OwnerPasskeySetup } from "./OwnerPasskeySetup";
import { unreachable } from "./ownerActions";
import { nextExpiry, roster } from "./roster";
import type { ActionAccess } from "./useOwnerAction";
import type { Authenticator } from "./webauthn";

interface EnrollmentPanelProps {
  feed: BoardFeed;
  owner: OwnerPort;
  enrollment: EnrollmentPort;
  /** The browser's authenticator, or `null` when this page cannot use passkeys. */
  authenticator: Authenticator | null;
}

/**
 * Resolves whether owner actions can be asked for. A board that is behind or halted may not show
 * who is enrolled, so it blocks them even when the port is available.
 */
export const actionAccess = (
  owner: OwnerPort,
  authenticator: Authenticator | null,
  stream: StreamStatus,
): ActionAccess => {
  switch (stream.kind) {
    case "halted":
      return { kind: "blocked", block: { kind: "halted" } };
    case "gap":
      return { kind: "blocked", block: { kind: "behind" } };
    case "consistent":
      break;
    default:
      return unreachable(stream);
  }
  if (owner.kind === "unavailable") {
    return { kind: "blocked", block: { kind: "unavailable", reason: owner.reason } };
  }
  if (authenticator === null) return { kind: "blocked", block: { kind: "no_authenticator" } };
  return { kind: "ready", owner, authenticator };
};

/**
 * Invites agents, confirms each one against the code its terminal shows, and revokes them; on a new
 * instance, enrolls the owner's passkey those actions need.
 */
export const EnrollmentPanel = ({
  feed,
  owner,
  enrollment,
  authenticator,
}: EnrollmentPanelProps) => {
  const headingId = useId();
  const view = feedView(feed);

  return (
    <section aria-labelledby={headingId} aria-busy={view.kind === "loading"}>
      <LayerCard>
        <LayerCard.Secondary>
          <Text as="h2" variant="heading" DANGEROUS_className="text-balance">
            <span id={headingId}>Agents</span>
          </Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="grid gap-0 p-0">
          {view.kind === "loading" && (
            <div className="grid gap-2 px-4 py-3">
              <span className="sr-only">Loading agents…</span>
              <SkeletonLine />
              <SkeletonLine />
            </div>
          )}
          {view.kind === "failed" && (
            <Empty
              size="sm"
              icon={<WarningCircleIcon size={32} aria-hidden="true" />}
              title="Agents did not load"
              description="The board could not be read from the backend, so no agent can be invited or confirmed."
            />
          )}
          {"board" in view && (
            <Roster
              board={view.board}
              access={actionAccess(owner, authenticator, view.board.stream)}
            />
          )}
          <OwnerPasskeySetup enrollment={enrollment} authenticator={authenticator} />
        </LayerCard.Primary>
      </LayerCard>
    </section>
  );
};

/** The longest the roster waits before rereading the clock, so a clock moved forward shows soon. */
const EXPIRY_RECHECK_MS = 60_000;

const Roster = ({ board, access }: { board: BoardState; access: ActionAccess }) => {
  const [now, setNow] = useState(Date.now);
  const rows = roster(board, now);
  const expiry = nextExpiry(rows.invites);
  // No event records an expiry, so the clock moves the next invite to the expired rows. The wall
  // clock can move while a timeout waits, so each callback rereads it and waits again, at most
  // EXPIRY_RECHECK_MS at a time, until it reaches the expiry.
  useEffect(() => {
    if (expiry === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const current = Date.now();
      if (current < expiry) {
        timer = setTimeout(check, Math.min(EXPIRY_RECHECK_MS, expiry - current));
        return;
      }
      setNow(current);
    };
    timer = setTimeout(check, Math.min(EXPIRY_RECHECK_MS, Math.max(0, expiry - Date.now())));
    return () => clearTimeout(timer);
  }, [expiry]);
  const empty =
    rows.invites.length +
      rows.expired.length +
      rows.awaiting.length +
      rows.confirmed.length +
      rows.revoked.length ===
    0;
  return (
    <>
      <div className="grid gap-3 px-4 py-3">
        {access.kind === "blocked" && (
          <div aria-live="polite">
            <BlockedNote block={access.block} />
          </div>
        )}
        <InviteForm access={access} />
      </div>
      {empty && (
        <Empty
          size="sm"
          icon={<RobotIcon size={32} aria-hidden="true" />}
          title="No agents yet"
          description="An agent appears here when it joins with an invite. Confirm it once its code matches."
        />
      )}
      {rows.invites.length > 0 && (
        <Group title="Invited">
          {rows.invites.map((invite) => (
            <li
              key={invite.inviteId}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3"
            >
              <Text bold DANGEROUS_className="min-w-0 break-words">
                {invite.name}
              </Text>
              <Text as="span" variant="secondary">
                Waiting for the agent to join.
              </Text>
            </li>
          ))}
        </Group>
      )}
      {rows.expired.length > 0 && (
        <Group title="Expired invites">
          {rows.expired.map((invite) => (
            <li
              key={invite.inviteId}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3"
            >
              <Text variant="secondary" DANGEROUS_className="min-w-0 break-words">
                {invite.name}
              </Text>
              <Badge variant="neutral">Expired</Badge>
              <Text as="span" variant="secondary">
                No agent joined in time. Create a new invite to add it.
              </Text>
            </li>
          ))}
        </Group>
      )}
      {rows.awaiting.length > 0 && (
        <Group title="Waiting for you">
          {rows.awaiting.map((agent) => (
            <AwaitingAgent key={agent.agentId} agent={agent} access={access} />
          ))}
        </Group>
      )}
      {rows.confirmed.length > 0 && (
        <Group title="Confirmed">
          {rows.confirmed.map((agent) => (
            <ConfirmedAgent key={agent.agentId} agent={agent} access={access} />
          ))}
        </Group>
      )}
      {rows.revoked.length > 0 && (
        <Group title="Revoked">
          {rows.revoked.map((agent) => (
            <li
              key={agent.agentId}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3"
            >
              <Text variant="secondary" DANGEROUS_className="min-w-0 break-words">
                {agent.name}
              </Text>
              <Badge variant="neutral">Revoked</Badge>
            </li>
          ))}
        </Group>
      )}
    </>
  );
};

const Group = ({ title, children }: { title: string; children: ReactNode }) => {
  const id = useId();
  return (
    <div className="border-t border-kumo-line">
      <Text as="h3" variant="secondary" DANGEROUS_className="px-4 pt-3">
        <span id={id}>{title}</span>
      </Text>
      <ul aria-labelledby={id} className="grid divide-y divide-kumo-line">
        {children}
      </ul>
    </div>
  );
};
