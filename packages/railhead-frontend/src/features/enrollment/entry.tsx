import type { FeatureEntry, OwnerSlotProps } from "../board/boardPorts";
import { EnrollmentPanel } from "./EnrollmentPanel";
import { browserAuthenticator } from "./webauthn";

const EnrollmentSlot = ({ feed, owner }: OwnerSlotProps) => (
  <EnrollmentPanel feed={feed} owner={owner} authenticator={browserAuthenticator()} />
);

/** The board's slot for inviting, confirming and revoking agents. */
export const enrollmentEntry: FeatureEntry<OwnerSlotProps> = {
  kind: "available",
  Component: EnrollmentSlot,
};
