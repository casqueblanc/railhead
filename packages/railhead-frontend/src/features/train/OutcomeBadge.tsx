import { Badge, type BadgeVariant } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  ClockIcon,
  GitMergeIcon,
  WarningIcon,
  XCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { TrainOutcome } from "./trainRuns";

/**
 * The outcome of a merge intent. The label carries the meaning; colour and icon only repeat it, so
 * the badge reads the same without colour or to a screen reader.
 */
export const OutcomeBadge = ({ outcome }: { outcome: TrainOutcome["kind"] }) => {
  const { label, variant, icon: OutcomeIcon } = OUTCOME_BADGE[outcome];
  return (
    <Badge variant={variant} icon={<OutcomeIcon weight="bold" aria-hidden="true" />}>
      {label}
    </Badge>
  );
};

/** Badge label, colour and icon for each outcome. */
export const OUTCOME_BADGE: Readonly<
  Record<TrainOutcome["kind"], { label: string; variant: BadgeVariant; icon: Icon }>
> = {
  pending: { label: "Merging", variant: "info", icon: ClockIcon },
  landed: { label: "Landed", variant: "success", icon: GitMergeIcon },
  landed_after_read_back: {
    label: "Landed after read-back",
    variant: "success",
    icon: CheckCircleIcon,
  },
  main_moved: { label: "Not landed: main moved", variant: "warning", icon: WarningIcon },
  not_landed_after_read_back: {
    label: "Not landed after read-back",
    variant: "error",
    icon: XCircleIcon,
  },
};
