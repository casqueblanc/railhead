import type { FeatureEntry, OwnerSlotProps } from "../board/boardPorts";
import { browserAuthenticator } from "../enrollment/webauthn";
import { IssuesPanel } from "./IssuesPanel";

const IssuesSlot = ({ feed, owner }: OwnerSlotProps) => (
  <IssuesPanel feed={feed} owner={owner} authenticator={browserAuthenticator()} />
);

/** The board's slot for filing issues for agents and listing the filed ones. */
export const issuesEntry: FeatureEntry<OwnerSlotProps> = {
  kind: "available",
  Component: IssuesSlot,
};
