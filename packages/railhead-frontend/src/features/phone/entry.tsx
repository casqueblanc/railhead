import type { BoardSlotProps, FeatureEntry } from "../board/boardPorts";
import { PhoneLinksPanel } from "./PhoneLinksPanel";

const PhoneSlot = ({ feed }: BoardSlotProps) => (
  <PhoneLinksPanel feed={feed} origin={window.location.origin} />
);

/** The board's slot for links that open questions and confirmations on a phone. */
export const phoneEntry: FeatureEntry<BoardSlotProps> = { kind: "available", Component: PhoneSlot };
