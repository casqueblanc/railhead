// The backend's own passkey verifier, loaded under `node` for the owner key's tests. Its sources
// import each other without file extensions, as the Worker bundler allows, so a resolve hook adds
// `.ts` to those imports alone. The modules are imported by a computed URL, which keeps their
// Worker-typed sources out of this package's type check; every value they return is `unknown`.

import { registerHooks } from "node:module";
import type { EnrollmentChallenge } from "../../packages/railhead-shared/src/board-api.ts";
import { register } from "./ownerKey.ts";

const BACKEND_SOURCE = new URL("../../packages/railhead-backend/src/", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const relativeWithoutExtension = /^\.\.?\/(?:.*\/)?[^./]+$/.test(specifier);
    if (relativeWithoutExtension && context.parentURL?.startsWith(BACKEND_SOURCE) === true) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const passkeyVerifier: unknown = await import(`${BACKEND_SOURCE}auth/passkeyVerifier.ts`);
const registrationModule: unknown = await import(`${BACKEND_SOURCE}modules/owner/registration.ts`);

/** A function the backend module exports, called with untyped arguments. */
type Exported = (...args: unknown[]) => Promise<unknown>;

function exported(module: unknown, name: string): Exported {
  const value: unknown =
    typeof module === "object" && module !== null ? Reflect.get(module, name) : undefined;
  if (typeof value !== "function") throw new Error(`The backend module exports no ${name}.`);
  return async (...args) => {
    const result: unknown = await Reflect.apply(value, undefined, args);
    return result;
  };
}

/** `relyingParty(host)` from `auth/passkeyVerifier.ts`. */
export const relyingParty = exported(passkeyVerifier, "relyingParty");
/** `actionChallenge(party, binding)` from `auth/passkeyVerifier.ts`. */
export const actionChallenge = exported(passkeyVerifier, "actionChallenge");
/** `verifyActionAssertion(input)` from `auth/passkeyVerifier.ts`. */
export const verifyActionAssertion = exported(passkeyVerifier, "verifyActionAssertion");
/** `verifyRegistration(input)` from `modules/owner/registration.ts`. */
export const verifyRegistration = exported(registrationModule, "verifyRegistration");

/** The credential the backend stores for an enrollment, from its own verifier. */
export interface Enrolled {
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly userHandle: string;
  readonly signCount: number;
}

/** Creates a key at `path` for `prepared` and returns the credential the backend accepted. */
export async function enroll(path: string, prepared: EnrollmentChallenge): Promise<Enrolled> {
  const registration = register(path, prepared);
  const result = await verifyRegistration({
    relyingParty: await relyingParty(prepared.rpId),
    challenge: prepared.challenge,
    registration,
  });
  if (!isRecord(result) || result.ok !== true || !isRecord(result.credential)) {
    throw new Error(`The backend refused the registration: ${JSON.stringify(result)}.`);
  }
  const { credentialId, publicKey, signCount } = result.credential;
  if (typeof credentialId !== "string" || !(publicKey instanceof Uint8Array) || signCount !== 0) {
    throw new Error("The backend stored an unexpected credential.");
  }
  return { credentialId, publicKey, userHandle: prepared.userHandle, signCount };
}

/** Whether `value` is a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
