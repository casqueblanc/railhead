import type { FeatureEntry, BoardSlotProps } from "../board/boardPorts";
import { TotalsPanel } from "./TotalsPanel";

/** The board's slot for measured totals, counted from the folded log. */
export const metricsEntry: FeatureEntry<BoardSlotProps> = {
  kind: "available",
  Component: TotalsPanel,
};
