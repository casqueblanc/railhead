import type { FeatureEntry, OwnerSlotProps } from "../board/boardPorts";

/**
 * The board's slot for inviting, confirming and revoking agents.
 * Unavailable until this feature supplies its component.
 */
export const enrollmentEntry: FeatureEntry<OwnerSlotProps> = { kind: "unavailable" };
