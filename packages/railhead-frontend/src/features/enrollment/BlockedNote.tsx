import { Text } from "@cloudflare/kumo";
import { LockSimpleIcon } from "@phosphor-icons/react";
import { blockMessage, type EnrollmentBlock } from "./ownerActions";

/** Says why the action beside it cannot be asked for. */
export const BlockedNote = ({ block }: { block: EnrollmentBlock }) => (
  <span className="flex min-w-0 items-start gap-1.5">
    <span className="flex h-lh items-center text-kumo-subtle">
      <LockSimpleIcon size={14} aria-hidden="true" />
    </span>
    <Text as="span" variant="secondary">
      {blockMessage(block)}
    </Text>
  </span>
);
