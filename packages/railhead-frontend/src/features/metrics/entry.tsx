import type { FeatureEntry, BoardSlotProps } from "../board/boardPorts";

/**
 * The board's slot for measured totals.
 * Unavailable until this feature supplies its component.
 */
export const metricsEntry: FeatureEntry<BoardSlotProps> = { kind: "unavailable" };
