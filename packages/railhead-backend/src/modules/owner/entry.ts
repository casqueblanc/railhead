// Owner: the human-only actions on one repository, each performed once for one passkey assertion
// bound to it, and the enrollment of the instance owner's passkey. Until its task installs the
// module, every call refuses with `unavailable` and has no effect: no challenge is issued and no
// action is performed.

import type {
  ActionChallenge,
  EnrollmentChallenge,
  OwnerAction,
  OwnerActionResult,
  PasskeyAssertion,
  PasskeyRegistration,
} from "@railhead/shared/board-api";
import type { UserId } from "@railhead/shared/events";
import { fail, type PortFailure, type PortResult } from "../../contracts/result";
import type { ModuleFactory } from "../../repo/composeRepo";

/** The owner's actions on one repository. */
export interface OwnerPort {
  /** Issues a challenge bound to `action`. */
  prepare(action: OwnerAction): Promise<PortResult<ActionChallenge>>;
  /** Performs the action the challenge names, if `assertion` verifies for it; at most once. */
  perform(challengeId: string, assertion: PasskeyAssertion): Promise<PortResult<OwnerActionResult>>;
}

/** Enrollment of the instance owner's passkey. It belongs to the instance, not to a repository. */
export interface OwnerEnrollmentPort {
  /** Starts enrollment with the one-time bootstrap token. */
  prepare(bootstrapToken: string): Promise<PortResult<EnrollmentChallenge>>;
  /** Completes enrollment and closes it. */
  complete(
    challengeId: string,
    registration: PasskeyRegistration,
  ): Promise<PortResult<{ ownerId: UserId }>>;
}

/** Builds the owner module of one repository. */
export const owner: ModuleFactory<OwnerPort> = () => ({ prepare: refuse, perform: refuse });

/** Builds the instance owner's enrollment. */
export function ownerEnrollment(_env: Env): OwnerEnrollmentPort {
  return { prepare: refuse, complete: refuse };
}

async function refuse(): Promise<PortFailure> {
  return fail("unavailable", "The owner module is not available.");
}
