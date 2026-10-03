import type { FeatureEntry, BoardSlotProps } from "../board/boardPorts";

/**
 * The board's slot for links that open questions and confirmations on a phone.
 * Unavailable until this feature supplies its component.
 */
export const phoneEntry: FeatureEntry<BoardSlotProps> = { kind: "unavailable" };
