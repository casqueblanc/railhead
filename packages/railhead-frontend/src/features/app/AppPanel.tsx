import {
  Badge,
  Banner,
  Button,
  Empty,
  LayerCard,
  Link,
  SkeletonLine,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  PlugsIcon,
  QuestionIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { useId } from "react";
import type { CommitSha } from "@railhead/shared/events";
import { feedView, type BoardFeed } from "../claims/boardFeed";
import { ShortSha } from "../claims/ShortSha";
import { deploymentStatus, type AppLocation, type DeploymentStatus } from "./appRevision";
import { useAppRevision } from "./useAppRevision";

/** The only powers the embedded app gets: running its script and submitting its form. */
const APP_SANDBOX = "allow-scripts allow-forms";

interface AppPanelProps {
  feed: BoardFeed;
  location: AppLocation;
  /** Reaches the deployed app; injected so a test can stand in for it. */
  fetchRevision: typeof fetch;
}

/**
 * The demo app as deployed, with the commit it runs beside main. A deployment behind main is
 * marked stale, so what the app does is never presented as main's behaviour when it is not.
 */
export const AppPanel = ({ feed, location, fetchRevision }: AppPanelProps) => {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <LayerCard>
        <LayerCard.Secondary>
          <Text as="h2" variant="heading">
            <span id={headingId}>Demo app</span>
          </Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="p-0">
          {location.kind === "configured" ? (
            <Deployment feed={feed} origin={location.origin} fetchRevision={fetchRevision} />
          ) : (
            <Empty
              size="sm"
              icon={<PlugsIcon size={32} aria-hidden="true" />}
              title={location.kind === "invalid" ? "The app URL is not valid" : "No app configured"}
              description="This board needs the deployed app's http or https URL, on another origin than the board, in VITE_DEMO_APP_URL when it is built."
            />
          )}
        </LayerCard.Primary>
      </LayerCard>
    </section>
  );
};

interface DeploymentProps {
  feed: BoardFeed;
  origin: string;
  fetchRevision: typeof fetch;
}

const Deployment = ({ feed, origin, fetchRevision }: DeploymentProps) => {
  const view = feedView(feed);
  const main = "board" in view ? view.board.main : null;
  const { read, onRecheck } = useAppRevision(origin, main, fetchRevision);
  const status = deploymentStatus(main, read);
  const boardBehind = view.kind === "stale" || view.kind === "halted";

  return (
    <div className="grid gap-3 px-4 py-3">
      <div aria-live="polite" className="grid gap-2">
        <StatusBanner status={status} onRecheck={onRecheck} />
        {boardBehind && (
          <Text variant="secondary">
            The board is not live, so main may have moved since it was last read.
          </Text>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-kumo-subtle">Deployed</dt>
        <dd>
          <Commit sha={"deployed" in status ? status.deployed : null} />
        </dd>
        <dt className="text-kumo-subtle">Main</dt>
        <dd>
          <Commit sha={main} />
        </dd>
      </dl>
      {status.kind !== "unreachable" && status.kind !== "checking" && (
        <iframe
          src={origin}
          title="The deployed demo app"
          // Agent-written code runs in here. Without allow-same-origin the frame has an opaque
          // origin, so even a page that navigates itself to the board cannot reach the board's
          // document, storage or session; it cannot navigate the board or open windows either.
          sandbox={APP_SANDBOX}
          referrerPolicy="no-referrer"
          loading="lazy"
          className="h-80 w-full rounded-md border border-kumo-line bg-kumo-base"
        />
      )}
      <Link href={origin} variant="inline" target="_blank" rel="noreferrer">
        Open the app in a new tab
      </Link>
    </div>
  );
};

const Commit = ({ sha }: { sha: CommitSha | null }) =>
  sha === null ? <span className="text-kumo-subtle">Not known</span> : <ShortSha sha={sha} />;

const StatusBanner = ({
  status,
  onRecheck,
}: {
  status: DeploymentStatus;
  onRecheck: () => void;
}) => {
  const recheck = (
    <Button size="sm" icon={<ArrowsClockwiseIcon aria-hidden="true" />} onClick={onRecheck}>
      Check again
    </Button>
  );
  switch (status.kind) {
    case "checking":
      return (
        <div className="grid gap-2">
          <span className="sr-only">Checking which commit the app runs…</span>
          <SkeletonLine />
        </div>
      );
    case "current":
      return (
        <div>
          <Badge variant="success" icon={<CheckCircleIcon weight="bold" aria-hidden="true" />}>
            Running main
          </Badge>
        </div>
      );
    case "stale":
      return (
        <Banner
          size="sm"
          variant="alert"
          icon={<WarningIcon weight="fill" aria-hidden="true" />}
          title="Stale deployment"
          description={`The app runs ${status.deployed.slice(0, 7)}, but main is ${status.main.slice(0, 7)}. What it does below is not main's behaviour until it is deployed again.`}
          action={recheck}
        />
      );
    case "main_unknown":
      return (
        <Banner
          size="sm"
          variant="secondary"
          icon={<QuestionIcon weight="fill" aria-hidden="true" />}
          title="Main not read yet"
          description="The train has not read main, so the deployment cannot be compared with it."
        />
      );
    case "unreported":
      return (
        <Banner
          size="sm"
          variant="alert"
          icon={<WarningIcon weight="fill" aria-hidden="true" />}
          title="Revision not reported"
          description="The app was deployed without its commit, so it cannot be matched to main. Treat what it does as unverified."
          action={recheck}
        />
      );
    case "unreachable":
      return (
        <Banner
          size="sm"
          variant="error"
          icon={<XCircleIcon weight="fill" aria-hidden="true" />}
          title="App unreachable"
          description="The deployed app did not report its revision."
          action={recheck}
        />
      );
    default:
      return unreachable(status);
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled deployment status: ${JSON.stringify(value)}`);
};
