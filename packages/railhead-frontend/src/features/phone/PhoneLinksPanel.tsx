import { Button, Empty, LayerCard, Link, SkeletonLine, Text } from "@cloudflare/kumo";
import { DeviceMobileIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import type { BoardState } from "../board/boardState";
import type { BoardFeed } from "../claims/boardFeed";
import { decisionQueue } from "../decisions/decisionQueue";
import {
  confirmLink,
  phoneOrigin,
  PHONE_ORIGINS,
  questionLink,
  type PhoneOrigin,
} from "./phoneLinks";
import { QrCode } from "./QrCode";

interface PhoneLinksPanelProps {
  feed: BoardFeed;
  /** The origin this board is served from. Links are offered only on a reviewed one. */
  origin: string;
}

/**
 * QR codes that open one open question, or one agent waiting for confirmation, on the owner's
 * phone. A code carries only the identifier; the phone still asks for the owner's passkey.
 */
export const PhoneLinksPanel = ({ feed, origin }: PhoneLinksPanelProps) => {
  const headingId = useId();
  const reviewed = phoneOrigin(origin);

  return (
    <section aria-labelledby={headingId} aria-busy={feed.kind === "loading"}>
      <LayerCard>
        <LayerCard.Secondary>
          <Text as="h2" variant="heading">
            <span id={headingId}>Phone</span>
          </Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="grid gap-3 px-4 py-3">
          {reviewed === null ? (
            <Text variant="secondary" DANGEROUS_className="break-words">
              Phone links open only on {PHONE_ORIGINS.join(" or ")}, where the owner’s passkey
              works. This board is served from another address.
            </Text>
          ) : (
            <Links feed={feed} origin={reviewed} />
          )}
        </LayerCard.Primary>
      </LayerCard>
    </section>
  );
};

const Links = ({ feed, origin }: { feed: BoardFeed; origin: PhoneOrigin }) => {
  switch (feed.kind) {
    case "loading":
      return (
        <div className="grid gap-2">
          <span className="sr-only">Loading phone links…</span>
          <SkeletonLine />
        </div>
      );
    case "failed":
      return (
        <Empty
          size="sm"
          icon={<WarningCircleIcon size={32} aria-hidden="true" />}
          title="Phone links did not load"
          description="The board could not be read from the backend."
        />
      );
    case "board":
      return <LinkList board={feed.board} origin={origin} />;
    default:
      return unreachable(feed);
  }
};

interface PhoneItem {
  key: string;
  /** What the item is, untrusted text shown inert. */
  title: string;
  /** What the phone page asks the owner to do. */
  purpose: string;
  href: string;
}

const LinkList = ({ board, origin }: { board: BoardState; origin: PhoneOrigin }) => {
  const [shown, setShown] = useState<string | null>(null);
  const questions = decisionQueue(board).open.map((view): PhoneItem => ({
    key: view.decisionId,
    title: view.questions[0]?.text ?? view.decisionId,
    purpose: "Answer this question",
    href: questionLink(origin, view.decisionId),
  }));
  const agents = Object.values(board.agents)
    .filter((agent) => agent.status === "awaiting_confirmation")
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.agentId.localeCompare(b.agentId))
    .map((agent): PhoneItem => ({
      key: agent.agentId,
      title: agent.name,
      purpose: "Confirm this agent",
      href: confirmLink(origin, agent.agentId),
    }));
  const items = [...questions, ...agents];

  if (items.length === 0) {
    return (
      <Empty
        size="sm"
        icon={<DeviceMobileIcon size={32} aria-hidden="true" />}
        title="Nothing to open on a phone"
        description="Open questions and agents waiting for confirmation get a code here."
      />
    );
  }

  return (
    <>
      <Text variant="secondary">
        Scan a code to act on your phone. The phone asks for your passkey before anything changes.
      </Text>
      <ul className="grid divide-y divide-kumo-line">
        {items.map((item) => {
          const open = shown === item.key;
          return (
            <li key={item.key} className="grid gap-2 py-3">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                  <Text variant="secondary">{item.purpose}</Text>
                  <Text DANGEROUS_className="break-words line-clamp-2">{item.title}</Text>
                </div>
                <Button
                  size="sm"
                  aria-expanded={open}
                  onClick={() => setShown(open ? null : item.key)}
                >
                  {open ? "Hide code" : "Show code"}
                </Button>
              </div>
              {open && (
                <div className="grid justify-items-start gap-2">
                  <QrCode value={item.href} label={`QR code: ${item.purpose.toLowerCase()}`} />
                  <Link href={item.href} variant="inline" className="break-all">
                    {item.href}
                  </Link>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled phone links variant: ${JSON.stringify(value)}`);
};
