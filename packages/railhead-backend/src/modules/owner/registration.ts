// Verifies the WebAuthn registration that enrolls the instance owner's passkey (WebAuthn Level 3,
// section 7.1 "Registering a New Credential"). Enrollment asks for an ES256 credential with user
// verification and no attestation, so only the `none` attestation format is accepted: the passkey
// is trusted because the one-time bootstrap token opened the ceremony, not because of its maker.

import type { PasskeyRegistration } from "@railhead/shared/board-api";
import {
  MAX_CLIENT_DATA_BYTES,
  MAX_COSE_KEY_BYTES,
  MAX_CREDENTIAL_ID_BYTES,
  type RelyingParty,
} from "../../auth/passkeyVerifier";
import { readCbor } from "./cbor";
import { decodeBase64Url, equalBytes, sha256 } from "./encoding";

/** Upper bound on an attestation object, in bytes. A `none` attestation is a few hundred. */
export const MAX_ATTESTATION_OBJECT_BYTES = 4096;

/** The only credential algorithm enrollment requests: ES256 (COSE -7). */
export const ENROLLMENT_ALGORITHM = -7;

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED_CREDENTIAL = 0x40;
const FLAG_EXTENSIONS = 0x80;
/** rpIdHash (32), flags (1), signCount (4), AAGUID (16), credentialIdLength (2). */
const CREDENTIAL_ID_OFFSET = 55;

/** A verified registration: what is stored as the owner's credential. */
export interface RegisteredCredential {
  /** The credential id, base64url without padding. */
  readonly credentialId: string;
  /** The credential's ES256 COSE key, exactly as the authenticator encoded it. */
  readonly publicKey: Uint8Array;
  /** The authenticator's signature counter at registration. */
  readonly signCount: number;
}

/** Why a registration was refused. Every case is final for that registration. */
export type RegistrationFailure =
  /** A field is not canonical base64url, exceeds its bound, or does not parse. */
  | "malformed"
  /** `clientDataJSON` is not a `webauthn.create` response. */
  | "wrong-type"
  /** `clientDataJSON` carries another challenge. */
  | "challenge-mismatch"
  /** `clientDataJSON` names another origin, or a cross-origin or embedded call. */
  | "origin-mismatch"
  /** The authenticator data is for another RP ID. */
  | "rp-mismatch"
  /** The authenticator did not report user presence and user verification. */
  | "user-not-verified"
  /** The authenticator reported a backed-up credential that is not backup eligible. */
  | "backup-state-invalid"
  /** The attestation is not `none`, or carries no credential. */
  | "attestation-unsupported"
  /** The credential id differs from the one the browser reported. */
  | "credential-mismatch"
  /** The credential's key is not an ES256 P-256 key. */
  | "key-unsupported";

/** The outcome of {@link verifyRegistration}. */
export type RegistrationResult =
  | { readonly ok: true; readonly credential: RegisteredCredential }
  | { readonly ok: false; readonly reason: RegistrationFailure };

/** What {@link verifyRegistration} checks. */
export interface RegistrationInput {
  /** The instance's relying party. */
  readonly relyingParty: RelyingParty;
  /** The stored WebAuthn challenge, base64url without padding. */
  readonly challenge: string;
  /** The browser's registration, untrusted. */
  readonly registration: PasskeyRegistration;
}

/** Verifies that `registration` creates an ES256 credential for this ceremony and origin. */
export async function verifyRegistration(input: RegistrationInput): Promise<RegistrationResult> {
  const { relyingParty: party, challenge, registration } = input;
  const clientDataBytes = decodeBase64Url(registration.clientDataJson, MAX_CLIENT_DATA_BYTES);
  const attestation = decodeBase64Url(registration.attestationObject, MAX_ATTESTATION_OBJECT_BYTES);
  const reportedId = decodeBase64Url(registration.credentialId, MAX_CREDENTIAL_ID_BYTES);
  if (clientDataBytes === undefined || attestation === undefined || reportedId === undefined) {
    return refuse("malformed");
  }

  const clientData = parseJsonObject(clientDataBytes);
  if (clientData === undefined) return refuse("malformed");
  if (clientData["type"] !== "webauthn.create") return refuse("wrong-type");
  if (clientData["challenge"] !== challenge) return refuse("challenge-mismatch");
  if (
    clientData["origin"] !== party.origin ||
    clientData["crossOrigin"] === true ||
    clientData["topOrigin"] !== undefined
  ) {
    return refuse("origin-mismatch");
  }

  const object = readCbor(attestation);
  if (object === undefined || object.end !== attestation.length) return refuse("malformed");
  if (!(object.value instanceof Map) || object.value.size !== 3) return refuse("malformed");
  const fmt = object.value.get("fmt");
  const statement = object.value.get("attStmt");
  const authData = object.value.get("authData");
  if (!(authData instanceof Uint8Array) || authData.length < CREDENTIAL_ID_OFFSET) {
    return refuse("malformed");
  }
  if (fmt !== "none" || !(statement instanceof Map) || statement.size !== 0) {
    return refuse("attestation-unsupported");
  }

  const rpIdHash = await sha256(new TextEncoder().encode(party.rpId));
  if (!equalBytes(authData.subarray(0, 32), rpIdHash)) return refuse("rp-mismatch");
  const flags = authData[32] ?? 0;
  if ((flags & FLAG_USER_PRESENT) === 0 || (flags & FLAG_USER_VERIFIED) === 0) {
    return refuse("user-not-verified");
  }
  if ((flags & FLAG_BACKED_UP) !== 0 && (flags & FLAG_BACKUP_ELIGIBLE) === 0) {
    return refuse("backup-state-invalid");
  }
  if ((flags & FLAG_ATTESTED_CREDENTIAL) === 0) return refuse("attestation-unsupported");
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  const signCount = view.getUint32(33, false);

  const idLength = view.getUint16(53, false);
  const keyOffset = CREDENTIAL_ID_OFFSET + idLength;
  if (idLength === 0 || idLength > MAX_CREDENTIAL_ID_BYTES || keyOffset > authData.length) {
    return refuse("malformed");
  }
  if (!equalBytes(authData.subarray(CREDENTIAL_ID_OFFSET, keyOffset), reportedId)) {
    return refuse("credential-mismatch");
  }

  const key = readCbor(authData, keyOffset);
  if (key === undefined) return refuse("malformed");
  // Extensions, when flagged, are one more map after the key; otherwise the key ends the data.
  if ((flags & FLAG_EXTENSIONS) === 0) {
    if (key.end !== authData.length) return refuse("malformed");
  } else {
    const extensions = readCbor(authData, key.end);
    if (
      extensions === undefined ||
      !(extensions.value instanceof Map) ||
      extensions.end !== authData.length
    ) {
      return refuse("malformed");
    }
  }
  const publicKey = authData.slice(keyOffset, key.end);
  if (publicKey.length > MAX_COSE_KEY_BYTES || !(await isEs256Key(key.value))) {
    return refuse("key-unsupported");
  }
  return {
    ok: true,
    credential: { credentialId: registration.credentialId, publicKey, signCount },
  };
}

/** Whether `value` is an ES256 COSE_Key (RFC 9053) whose point is on P-256. */
async function isEs256Key(value: unknown): Promise<boolean> {
  if (!(value instanceof Map) || value.size !== 5) return false;
  const x: unknown = value.get(-2);
  const y: unknown = value.get(-3);
  if (
    value.get(1) !== 2 ||
    value.get(3) !== ENROLLMENT_ALGORITHM ||
    value.get(-1) !== 1 ||
    !(x instanceof Uint8Array) ||
    x.length !== 32 ||
    !(y instanceof Uint8Array) ||
    y.length !== 32
  ) {
    return false;
  }
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(x, 1);
  raw.set(y, 33);
  try {
    await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    return true;
  } catch (error) {
    // A point that is not on the curve is refused by WebCrypto with a DataError.
    if (error instanceof DOMException) return false;
    throw error;
  }
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return undefined;
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return { ...value };
}

function refuse(reason: RegistrationFailure): RegistrationResult {
  return { ok: false, reason };
}
