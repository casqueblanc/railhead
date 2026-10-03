import { Badge, Empty, LayerCard, SkeletonLine, Text } from "@cloudflare/kumo";
import { ListChecksIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useId } from "react";
import type { OwnerPort } from "../board/boardPorts";
import type { BoardState } from "../board/boardState";
import { feedView, type BoardFeed } from "../claims/boardFeed";
import { BlockedNote } from "../enrollment/BlockedNote";
import { actionAccess } from "../enrollment/EnrollmentPanel";
import type { Authenticator } from "../enrollment/webauthn";
import { IssueForm } from "./IssueForm";
import { issueList, type IssueStatus } from "./issueList";

interface IssuesPanelProps {
  feed: BoardFeed;
  owner: OwnerPort;
  /** The browser's authenticator, or `null` when this page cannot use passkeys. */
  authenticator: Authenticator | null;
}

/** Files issues for agents and lists the ones the log records, newest first. */
export const IssuesPanel = ({ feed, owner, authenticator }: IssuesPanelProps) => {
  const headingId = useId();
  const view = feedView(feed);

  return (
    <section aria-labelledby={headingId} aria-busy={view.kind === "loading"}>
      <LayerCard>
        <LayerCard.Secondary>
          <Text as="h2" variant="heading" DANGEROUS_className="text-balance">
            <span id={headingId}>Issues</span>
          </Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="grid gap-0 p-0">
          {view.kind === "loading" && (
            <div className="grid gap-2 px-4 py-3">
              <span className="sr-only">Loading issues…</span>
              <SkeletonLine />
              <SkeletonLine />
            </div>
          )}
          {view.kind === "failed" && (
            <Empty
              size="sm"
              icon={<WarningCircleIcon size={32} aria-hidden="true" />}
              title="Issues did not load"
              description="The board could not be read from the backend, so no issue can be filed."
            />
          )}
          {"board" in view && (
            <Issues board={view.board} owner={owner} authenticator={authenticator} />
          )}
        </LayerCard.Primary>
      </LayerCard>
    </section>
  );
};

const Issues = ({
  board,
  owner,
  authenticator,
}: {
  board: BoardState;
  owner: OwnerPort;
  authenticator: Authenticator | null;
}) => {
  const access = actionAccess(owner, authenticator, board.stream);
  const { rows, hidden } = issueList(board);
  const listId = useId();
  return (
    <>
      <div className="grid gap-3 px-4 py-3">
        {access.kind === "blocked" && (
          <div aria-live="polite">
            <BlockedNote block={access.block} />
          </div>
        )}
        <IssueForm access={access} board={board} />
      </div>
      {rows.length === 0 ? (
        <Empty
          size="sm"
          icon={<ListChecksIcon size={32} aria-hidden="true" />}
          title="No issues yet"
          description="A filed issue appears here once the log records it. The next agent to ask for work takes it."
        />
      ) : (
        <div className="border-t border-kumo-line">
          <Text as="h3" variant="secondary" DANGEROUS_className="px-4 pt-3">
            <span id={listId}>Filed</span>
          </Text>
          <ul aria-labelledby={listId} className="grid divide-y divide-kumo-line">
            {rows.map((issue) => (
              <li key={issue.issueId} className="grid min-w-0 gap-1 px-4 py-3">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <Text bold DANGEROUS_className="min-w-0 break-words">
                    {issue.title}
                  </Text>
                  <StatusBadge status={issue.status} />
                </div>
                {issue.body !== "" && (
                  <Text
                    variant="secondary"
                    DANGEROUS_className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words"
                  >
                    {issue.body}
                  </Text>
                )}
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <Text variant="secondary" DANGEROUS_className="px-4 pb-3">
              {hidden === 1
                ? "1 older issue is not listed."
                : `${hidden} older issues are not listed.`}
            </Text>
          )}
        </div>
      )}
    </>
  );
};

const StatusBadge = ({ status }: { status: IssueStatus }) => {
  switch (status.kind) {
    case "open":
      return <Badge variant="neutral">Waiting for an agent</Badge>;
    case "claimed":
      return (
        <Badge variant="neutral">
          <span className="break-all">Claimed by {status.agent}</span>
        </Badge>
      );
    case "landed":
      return <Badge variant="neutral">Landed</Badge>;
    default:
      return unreachable(status);
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled issue status: ${JSON.stringify(value)}`);
};
