import type { ReactNode } from "react";
import { Link } from "@cloudflare/kumo";
import { appEntry } from "../../features/app/entry";
import { gateOnConnection, type BoardPorts } from "../../features/board/boardPorts";
import { ClaimLanes } from "../../features/claims/ClaimLanes";
import { enrollmentEntry } from "../../features/enrollment/entry";
import { issuesEntry } from "../../features/issues/entry";
import { metricsEntry } from "../../features/metrics/entry";
import { phoneEntry } from "../../features/phone/entry";
import { TrainOutcomes } from "../../features/train/TrainOutcomes";
import { BoardUnavailable } from "./BoardUnavailable";
import { FeatureSlot } from "./FeatureSlot";
import { QuestionsSection } from "./QuestionsSection";

interface HomePageProps {
  ports: BoardPorts;
}

/** The sections in page order, which is also their order on a phone. */
const SECTIONS = [
  { id: "questions", label: "Questions" },
  { id: "claims", label: "Claims" },
  { id: "train", label: "Train" },
  { id: "agents", label: "Agents" },
  { id: "issues", label: "Issues" },
  { id: "app", label: "Demo app" },
  { id: "totals", label: "Totals" },
  { id: "phone", label: "Phone" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** Wraps a section so the page's navigation can reach it. */
const Anchor = ({ id, children }: { id: SectionId; children: ReactNode }) => (
  <div id={id} className="min-w-0 scroll-mt-4">
    {children}
  </div>
);

/**
 * The board: questions, claim lanes and train outcomes first, then each leaf feature in its fixed
 * slot. The page gets its data and actions only through `ports`.
 */
export const HomePage = ({ ports }: HomePageProps) => {
  const { board, decisions, owner, connection, onReconnect } = gateOnConnection(ports);

  if (board.kind === "unavailable") {
    return (
      <div className="flex flex-1 items-center justify-center p-4" aria-live="polite">
        <BoardUnavailable connection={connection} onReconnect={onReconnect} />
      </div>
    );
  }

  const { feed } = board;
  return (
    <div className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-4 sm:px-6">
      <nav aria-label="Board sections">
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {SECTIONS.map(({ id, label }) => (
            <li key={id}>
              <Link href={`#${id}`} variant="plain">
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <div className="grid min-w-0 gap-6">
          <Anchor id="questions">
            <QuestionsSection feed={feed} actions={decisions} onRetry={onReconnect} />
          </Anchor>
          <Anchor id="claims">
            <ClaimLanes feed={feed} onRetry={onReconnect} />
          </Anchor>
          <Anchor id="train">
            <TrainOutcomes feed={feed} onRetry={onReconnect} />
          </Anchor>
        </div>
        <div className="grid min-w-0 gap-6">
          <Anchor id="agents">
            <FeatureSlot
              entry={enrollmentEntry}
              props={{ feed, owner }}
              title="Agents"
              unavailable="This board cannot invite, confirm or revoke agents yet."
            />
          </Anchor>
          <Anchor id="issues">
            <FeatureSlot
              entry={issuesEntry}
              props={{ feed, owner }}
              title="Issues"
              unavailable="This board cannot file issues for agents yet."
            />
          </Anchor>
          <Anchor id="app">
            <FeatureSlot
              entry={appEntry}
              props={{ feed }}
              title="Demo app"
              unavailable="This board does not show the app deployed from main yet."
            />
          </Anchor>
          <Anchor id="totals">
            <FeatureSlot
              entry={metricsEntry}
              props={{ feed }}
              title="Totals"
              unavailable="This board does not count questions, checks or merges yet."
            />
          </Anchor>
          <Anchor id="phone">
            <FeatureSlot
              entry={phoneEntry}
              props={{ feed }}
              title="Phone"
              unavailable="This board cannot open questions or confirmations on a phone yet."
            />
          </Anchor>
        </div>
      </div>
    </div>
  );
};
