import { Badge, type BadgeVariant } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  ClockIcon,
  WarningIcon,
  XCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { CheckRunOutcome } from "./checkRuns";

/** How a check ended. The label carries the meaning; colour and icon only repeat it. */
export const CheckResultBadge = ({ result }: { result: CheckRunOutcome }) => {
  const { label, variant, icon: ResultIcon } = CHECK_RESULT_BADGE[result];
  return (
    <Badge variant={variant} icon={<ResultIcon weight="bold" aria-hidden="true" />}>
      {label}
    </Badge>
  );
};

/** Badge label, colour and icon for each way a check ends. */
export const CHECK_RESULT_BADGE: Readonly<
  Record<CheckRunOutcome, { label: string; variant: BadgeVariant; icon: Icon }>
> = {
  pass: { label: "Passed", variant: "success", icon: CheckCircleIcon },
  fail: { label: "Failed", variant: "error", icon: XCircleIcon },
  error: { label: "Could not run", variant: "warning", icon: WarningIcon },
  timed_out: { label: "Timed out", variant: "warning", icon: ClockIcon },
};
