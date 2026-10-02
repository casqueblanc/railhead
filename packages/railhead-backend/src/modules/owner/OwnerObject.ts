// The instance owner's Durable Object, named `OWNER_OBJECT_NAME`. Reached only through this
// Worker's `OWNER` binding: by the enrollment adapter, and by each repository's owner module to
// read the passkey and advance its signature counter. It holds no state outside its storage.

import { DurableObject } from "cloudflare:workers";
import type { EnrollmentChallenge, PasskeyRegistration } from "@railhead/shared/board-api";
import type { UserId } from "@railhead/shared/events";
import { relyingParty } from "../../auth/passkeyVerifier";
import type { PortResult } from "../../contracts/result";
import { InstanceOwner, type OwnerCredential } from "./instance";

/** The name of the one `Owner` object of an instance. */
export const OWNER_OBJECT_NAME = "owner";

/** The instance owner. */
export class Owner extends DurableObject<Env> {
  readonly #owner: InstanceOwner;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#owner = new InstanceOwner(ctx.storage, {
      bootstrapToken: env.OWNER_BOOTSTRAP_TOKEN,
      relyingParty: relyingParty(env.RELYING_PARTY_HOST),
      clock: Date.now,
    });
  }

  /** Opens an enrollment ceremony with the bootstrap token. */
  prepareEnrollment(bootstrapToken: string): Promise<PortResult<EnrollmentChallenge>> {
    return this.#owner.prepareEnrollment(bootstrapToken);
  }

  /** Enrolls the owner's passkey and closes enrollment. */
  completeEnrollment(
    challengeId: string,
    registration: PasskeyRegistration,
  ): Promise<PortResult<{ ownerId: UserId }>> {
    return this.#owner.completeEnrollment(challengeId, registration);
  }

  /** The enrolled owner, or `null` before enrollment. */
  credential(): OwnerCredential | null {
    return this.#owner.credential();
  }

  /** Advances the passkey's signature counter; `false` when it would not advance. */
  recordSignCount(credentialId: string, signCount: number): boolean {
    return this.#owner.recordSignCount(credentialId, signCount);
  }
}
