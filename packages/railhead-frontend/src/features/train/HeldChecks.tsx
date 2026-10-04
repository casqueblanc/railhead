import { Button, Empty, LayerCard, SkeletonLine, Text } from "@cloudflare/kumo";
import { ShieldCheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import type { OwnerPort } from "../board/boardPorts";
import type { BoardState } from "../board/boardState";
import { feedView, type BoardFeed } from "../claims/boardFeed";
import { FeedStatus } from "../claims/FeedStatus";
import { actionAccess } from "../enrollment/EnrollmentPanel";
import type { Authenticator } from "../enrollment/webauthn";
import { HeldCheckItem, type SentApprovals } from "./HeldCheckItem";
import { heldCheckRows, MAX_SHOWN_HELD_CHECKS, type HeldCheckRow } from "./heldCheckRows";

interface HeldChecksProps {
  feed: BoardFeed;
  owner: OwnerPort;
  /** The browser's authenticator, or `null` when this page cannot use passkeys. */
  authenticator: Authenticator | null;
  /** Reopens the session and reads the board again. */
  onRetry: () => void;
}

/**
 * Checks the train holds because a candidate changes what its check runs, with the owner's
 * approval for each. Those waiting for approval come first, and at most `MAX_SHOWN_HELD_CHECKS`
 * are listed.
 */
export const HeldChecks = ({ feed, owner, authenticator, onRetry }: HeldChecksProps) => {
  const headingId = useId();
  // Kept here rather than in each row, so an approval that may have been recorded stays withheld
  // when the list remounts, as it does while a reloaded board loads again.
  const [sentKeys, setSentKeys] = useState<ReadonlySet<string>>(() => new Set());
  const view = feedView(feed);
  const rows = "board" in view ? heldCheckRows(view.board) : [];
  const waiting = rows.filter((row) => row.status.kind === "waiting").length;
  // A stopped or behind board shows its rows as of its cursor, as the status banner says, so its
  // rows say so too and the heading count, which would read as current, is left out.
  const current = view.kind === "live" || view.kind === "recovered";
  const sent: SentApprovals = {
    keys: sentKeys,
    onChange: (key, isSent) =>
      setSentKeys((keys) => {
        const next = new Set(keys);
        if (isSent) next.add(key);
        else next.delete(key);
        return next;
      }),
  };

  return (
    <section aria-labelledby={headingId} aria-busy={view.kind === "loading"}>
      <LayerCard>
        <LayerCard.Secondary className="flex items-center justify-between gap-2">
          <Text as="h2" variant="heading" DANGEROUS_className="text-balance">
            <span id={headingId}>Held checks</span>
          </Text>
          {current && waiting > 0 && (
            <span className="tabular-nums text-kumo-subtle">
              {waiting}
              <span className="sr-only"> waiting for approval</span>
            </span>
          )}
        </LayerCard.Secondary>
        <LayerCard.Primary className="grid gap-0 p-0">
          <div aria-live="polite" className="empty:hidden px-4 pt-3">
            <FeedStatus view={view} onRetry={onRetry} />
          </div>
          {view.kind === "loading" && (
            <div className="grid gap-2 px-4 py-3">
              <span className="sr-only">Loading held checks…</span>
              <SkeletonLine />
              <SkeletonLine />
            </div>
          )}
          {view.kind === "failed" && (
            <Empty
              size="sm"
              icon={<WarningCircleIcon size={32} aria-hidden="true" />}
              title="Held checks did not load"
              description="The board could not be read from the backend, so no check can be approved."
              contents={
                <Button variant="primary" onClick={onRetry}>
                  Try again
                </Button>
              }
            />
          )}
          {"board" in view && rows.length === 0 && (
            <Empty
              size="sm"
              icon={<ShieldCheckIcon size={32} aria-hidden="true" />}
              title="No checks are held"
              description="A check waits here for your approval when a candidate changes .railhead/check.json or a path it protects."
            />
          )}
          {"board" in view && rows.length > 0 && (
            <HeldList
              rows={rows}
              stream={view.board.stream}
              owner={owner}
              authenticator={authenticator}
              sent={sent}
              asOf={current ? null : view.board.cursor}
            />
          )}
        </LayerCard.Primary>
      </LayerCard>
    </section>
  );
};

const HeldList = ({
  rows,
  stream,
  owner,
  authenticator,
  sent,
  asOf,
}: {
  rows: readonly HeldCheckRow[];
  stream: BoardState["stream"];
  owner: OwnerPort;
  authenticator: Authenticator | null;
  sent: SentApprovals;
  asOf: number | null;
}) => {
  const access = actionAccess(owner, authenticator, stream);
  const hidden = rows.length - MAX_SHOWN_HELD_CHECKS;
  return (
    <>
      <ul className="grid divide-y divide-kumo-line">
        {rows.slice(0, MAX_SHOWN_HELD_CHECKS).map((row) => (
          <HeldCheckItem
            key={row.held.checkRunId}
            row={row}
            access={access}
            sent={sent}
            asOf={asOf}
          />
        ))}
      </ul>
      {hidden > 0 && (
        <Text variant="secondary" DANGEROUS_className="border-t border-kumo-line px-4 py-3">
          {hidden === 1
            ? "1 more held check is not shown."
            : `${hidden} more held checks are not shown.`}
        </Text>
      )}
    </>
  );
};
