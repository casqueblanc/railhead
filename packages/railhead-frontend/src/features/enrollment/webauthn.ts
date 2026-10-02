// The browser side of the owner's passkey: turning a backend challenge into WebAuthn options, and
// the authenticator's credential back into the wire shape the backend verifies.
//
// The authenticator is injected so tests can stand in for the browser. Whatever it returns is
// treated as unknown and checked field by field; nothing here trusts a credential's shape. The
// backend verifies the signature, the action the challenge commits to and the origin; this module
// only carries bytes.

import type {
  ActionChallenge,
  EnrollmentChallenge,
  PasskeyAssertion,
  PasskeyRegistration,
} from "@railhead/shared/board-api";

/** The two calls of `navigator.credentials` the owner's passkey uses. */
export interface Authenticator {
  get(options: CredentialRequestOptions): Promise<Credential | null>;
  create(options: CredentialCreationOptions): Promise<Credential | null>;
}

/** What became of one authenticator ceremony. */
export type CeremonyOutcome<T> =
  | { kind: "done"; value: T }
  /** The person dismissed the prompt or it timed out. Nothing was signed. */
  | { kind: "cancelled" }
  /** The authenticator or browser refused, or returned something unusable. */
  | { kind: "failed"; message: string };

/** COSE algorithm ES256, the only key type the backend verifies. */
const COSE_ALG_ES256 = -7;

/**
 * The browser's authenticator, or `null` when this page cannot use passkeys: no WebAuthn support,
 * or a page that is not a secure context.
 */
export const browserAuthenticator = (): Authenticator | null => {
  if (typeof window === "undefined" || !window.isSecureContext) return null;
  if (typeof window.PublicKeyCredential !== "function") return null;
  const { credentials } = navigator;
  return {
    get: (options) => credentials.get(options),
    create: (options) => credentials.create(options),
  };
};

/** Encodes bytes as base64url without padding. */
export const toBase64Url = (bytes: ArrayBuffer): string => {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/** Decodes base64url without padding, or returns `null` for anything else. */
export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

/** Milliseconds left until `expiresAt`, never negative. */
const remaining = (expiresAt: number, now: number): number => Math.max(0, expiresAt - now);

/** Asks the authenticator to sign the challenge the backend bound to one owner action. */
export const signAction = async (
  authenticator: Authenticator,
  challenge: ActionChallenge,
  now: number = Date.now(),
): Promise<CeremonyOutcome<PasskeyAssertion>> => {
  const bytes = fromBase64Url(challenge.challenge);
  const allow = challenge.allowCredentials.map(fromBase64Url);
  if (bytes === null || allow.some((id) => id === null)) {
    return { kind: "failed", message: "The backend sent a challenge this browser cannot read." };
  }
  if (remaining(challenge.expiresAt, now) === 0) {
    return {
      kind: "failed",
      message: "The passkey request expired before it was shown. Try again.",
    };
  }
  return ceremony(
    () =>
      authenticator.get({
        publicKey: {
          challenge: bytes,
          rpId: challenge.rpId,
          allowCredentials: allow.flatMap((id) =>
            id === null ? [] : [{ type: "public-key", id }],
          ),
          userVerification: "required",
          timeout: remaining(challenge.expiresAt, now),
        },
      }),
    readAssertion,
  );
};

/** Asks the authenticator to create the owner's passkey for the enrollment challenge. */
export const registerPasskey = async (
  authenticator: Authenticator,
  challenge: EnrollmentChallenge,
  now: number = Date.now(),
): Promise<CeremonyOutcome<PasskeyRegistration>> => {
  const bytes = fromBase64Url(challenge.challenge);
  const userHandle = fromBase64Url(challenge.userHandle);
  if (bytes === null || userHandle === null) {
    return { kind: "failed", message: "The backend sent a challenge this browser cannot read." };
  }
  if (remaining(challenge.expiresAt, now) === 0) {
    return {
      kind: "failed",
      message: "The passkey request expired before it was shown. Try again.",
    };
  }
  return ceremony(
    () =>
      authenticator.create({
        publicKey: {
          challenge: bytes,
          rp: { id: challenge.rpId, name: "Railhead" },
          user: { id: userHandle, name: "owner", displayName: "Railhead owner" },
          pubKeyCredParams: [{ type: "public-key", alg: COSE_ALG_ES256 }],
          authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
          attestation: "none",
          timeout: remaining(challenge.expiresAt, now),
        },
      }),
    readRegistration,
  );
};

const ceremony = async <T>(
  run: () => Promise<Credential | null>,
  read: (credential: unknown) => T | null,
): Promise<CeremonyOutcome<T>> => {
  let credential: Credential | null;
  try {
    credential = await run();
  } catch (error) {
    // WebAuthn reports a dismissed prompt and a timeout alike, as `NotAllowedError`.
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      return { kind: "cancelled" };
    }
    return { kind: "failed", message: "This browser could not use the passkey." };
  }
  if (credential === null) return { kind: "cancelled" };
  const value = read(credential);
  if (value === null) {
    return {
      kind: "failed",
      message: "The authenticator returned a credential Railhead cannot use.",
    };
  }
  return { kind: "done", value };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const bufferField = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return value instanceof ArrayBuffer ? toBase64Url(value) : null;
};

/** The parts every public-key credential shares, or `null`. */
const readCredential = (credential: unknown) => {
  if (!isRecord(credential) || credential["type"] !== "public-key") return null;
  const credentialId = bufferField(credential, "rawId");
  const response = credential["response"];
  if (credentialId === null || !isRecord(response)) return null;
  const clientDataJson = bufferField(response, "clientDataJSON");
  return clientDataJson === null ? null : { credentialId, clientDataJson, response };
};

const readAssertion = (credential: unknown): PasskeyAssertion | null => {
  const common = readCredential(credential);
  if (common === null) return null;
  const authenticatorData = bufferField(common.response, "authenticatorData");
  const signature = bufferField(common.response, "signature");
  const rawHandle = common.response["userHandle"];
  const userHandle = rawHandle instanceof ArrayBuffer ? toBase64Url(rawHandle) : null;
  if (authenticatorData === null || signature === null) return null;
  if (userHandle === null && rawHandle !== null && rawHandle !== undefined) return null;
  return {
    credentialId: common.credentialId,
    clientDataJson: common.clientDataJson,
    authenticatorData,
    signature,
    userHandle,
  };
};

const readRegistration = (credential: unknown): PasskeyRegistration | null => {
  const common = readCredential(credential);
  if (common === null) return null;
  const attestationObject = bufferField(common.response, "attestationObject");
  if (attestationObject === null) return null;
  return {
    credentialId: common.credentialId,
    clientDataJson: common.clientDataJson,
    attestationObject,
  };
};
