import type { FeatureEntry, OwnerSlotProps } from "../board/boardPorts";
import { browserAuthenticator } from "../enrollment/webauthn";
import { HeldChecks } from "./HeldChecks";

/** What the held checks slot receives: the owner slot's props and the page's reconnect. */
export interface HeldSlotProps extends OwnerSlotProps {
  /** Reopens the session and reads the board again. */
  onRetry: () => void;
}

const HeldChecksSlot = ({ feed, owner, onRetry }: HeldSlotProps) => (
  <HeldChecks feed={feed} owner={owner} authenticator={browserAuthenticator()} onRetry={onRetry} />
);

/** The board's slot for checks held for the owner's approval. */
export const heldChecksEntry: FeatureEntry<HeldSlotProps> = {
  kind: "available",
  Component: HeldChecksSlot,
};
