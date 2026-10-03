// Verifies WebAuthn assertions for action-bound owner passkeys, with WebCrypto. The challenge the
// browser signs is a digest of the exact owner action, the repository, the challenge id, a server
// nonce and the expiry, so an assertion approves one action and nothing else. The relying party is
// fixed per instance: the RP ID is the exact host and the origin is `https://` on that host.
//
// This module only verifies. Recording a challenge as used, so an assertion works at most once,
// belongs to the module that issues and consumes challenges. Reference: WebAuthn Level 3, section
// 7.2 "Verifying an Authentication Assertion".

import type {
  BoardErrorCode,
  DemoSeedAction,
  OwnerAction,
  PasskeyAssertion,
} from "@railhead/shared/board-api";
import type { RepoId } from "@railhead/shared/events";

/** The hosts a Railhead instance may use as its relying party: submission, then development. */
export const RELYING_PARTY_HOSTS = ["railhead.dev", "railhead.mashin.workers.dev"] as const;

/** One of {@link RELYING_PARTY_HOSTS}. */
export type RelyingPartyHost = (typeof RELYING_PARTY_HOSTS)[number];

/** Domain separator for the action digest; the version names the layout of the digested fields. */
export const ACTION_DIGEST_DOMAIN = "railhead-passkey-action-v1";

/** Fewest random bytes a challenge nonce must carry (WebAuthn asks for at least 16). */
export const MIN_NONCE_BYTES = 16;

/** Upper bound on a credential id, in bytes, from the WebAuthn credential id limit. */
export const MAX_CREDENTIAL_ID_BYTES = 1023;

/** Upper bound on `clientDataJSON`, in bytes. A browser's is a few hundred. */
export const MAX_CLIENT_DATA_BYTES = 4096;

/** Upper bound on authenticator data, in bytes. Assertions without extensions are 37. */
export const MAX_AUTHENTICATOR_DATA_BYTES = 1024;

/** Upper bound on an ES256 DER signature, in bytes. */
export const MAX_SIGNATURE_BYTES = 72;

/** Upper bound on a stored COSE public key, in bytes. */
export const MAX_COSE_KEY_BYTES = 256;

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const AUTH_DATA_MIN = 37;
const COSE_ALG_ES256 = -7;
const COSE_KTY_EC2 = 2;
const COSE_CRV_P256 = 1;

/** The fixed relying party of one instance. Build it with {@link relyingParty}. */
export interface RelyingParty {
  /** The RP ID: the exact host. */
  readonly rpId: RelyingPartyHost;
  /** The only origin an assertion may come from. */
  readonly origin: `https://${RelyingPartyHost}`;
}

/** Returns the relying party for `host`, or `undefined` when it is not a Railhead instance host. */
export function relyingParty(host: string): RelyingParty | undefined {
  const rpId = RELYING_PARTY_HOSTS.find((known) => known === host);
  return rpId === undefined ? undefined : { rpId, origin: `https://${rpId}` };
}

/** An action an owner passkey can approve. */
export type ApprovableAction = OwnerAction | DemoSeedAction;

/**
 * What an action challenge commits to, for an action of type `A`, a repository's own by default.
 * The issuer stores it and passes it back to verify.
 */
export interface ActionBinding<A extends ApprovableAction = OwnerAction> {
  /** The repository the action applies to. */
  readonly repoId: RepoId;
  /** The challenge id quoted by `perform`. */
  readonly challengeId: string;
  /** At least {@link MIN_NONCE_BYTES} random bytes from the issuer, base64url without padding. */
  readonly nonce: string;
  /** When the challenge stops being usable, in milliseconds since the Unix epoch. */
  readonly expiresAt: number;
  /** The exact action the owner approves. */
  readonly action: A;
}

/** The owner's enrolled credential, as the enrollment module stored it. */
export interface StoredCredential {
  /** The credential id, base64url without padding. */
  readonly credentialId: string;
  /** The `credentialPublicKey` COSE key from the registration's authenticator data. */
  readonly publicKey: Uint8Array;
  /** The user handle registered with the credential, base64url without padding. */
  readonly userHandle: string;
  /** The last signature counter accepted, 0 when the authenticator does not count. */
  readonly signCount: number;
}

/** Why an assertion was refused. Every case is final for that assertion. */
export type PasskeyFailure =
  /** The binding is not one this verifier can issue: bad nonce, expiry or relying party. */
  | "invalid-binding"
  /** The stored credential's public key is not an ES256 COSE key. */
  | "credential-unusable"
  /** The challenge's expiry has passed. */
  | "expired"
  /** The assertion names a credential other than the owner's. */
  | "unknown-credential"
  /** A field is not canonical base64url, exceeds its bound, or does not parse. */
  | "malformed"
  /** `clientDataJSON` is not a `webauthn.get` response. */
  | "wrong-type"
  /** `clientDataJSON` carries another challenge, so another action or challenge id. */
  | "challenge-mismatch"
  /** `clientDataJSON` names another origin, or a cross-origin or embedded call. */
  | "origin-mismatch"
  /** The authenticator data is for another RP ID. */
  | "rp-mismatch"
  /** The authenticator did not report user presence. */
  | "user-not-present"
  /** The authenticator did not report user verification (biometric or device unlock). */
  | "user-not-verified"
  /** The authenticator reported a backed-up credential that is not backup eligible. */
  | "backup-state-invalid"
  /** The user handle differs from the one registered with the credential. */
  | "user-mismatch"
  /** The signature counter did not advance past the stored one: a possible cloned authenticator. */
  | "counter-regressed"
  /** The signature does not verify under the stored key. */
  | "bad-signature";

/** The outcome of {@link verifyActionAssertion}. */
export type PasskeyResult =
  /** Verified. Store `signCount` as the credential's new counter when consuming the challenge. */
  | { readonly ok: true; readonly signCount: number }
  | { readonly ok: false; readonly reason: PasskeyFailure };

/** What {@link verifyActionAssertion} checks. */
export interface ActionAssertionInput {
  /** The instance's relying party. */
  readonly relyingParty: RelyingParty;
  /** The stored challenge being performed. */
  readonly binding: ActionBinding<ApprovableAction>;
  /** The owner's credential. */
  readonly credential: StoredCredential;
  /** The browser's assertion, untrusted. */
  readonly assertion: PasskeyAssertion;
  /** The current time, in milliseconds since the Unix epoch. */
  readonly now: number;
}

/** The board error a failure is reported as. */
export function boardErrorFor(reason: PasskeyFailure): BoardErrorCode {
  switch (reason) {
    case "expired":
      return "proof_expired";
    case "invalid-binding":
    case "credential-unusable":
      return "internal";
    case "unknown-credential":
    case "malformed":
    case "wrong-type":
    case "challenge-mismatch":
    case "origin-mismatch":
    case "rp-mismatch":
    case "user-not-present":
    case "user-not-verified":
    case "backup-state-invalid":
    case "user-mismatch":
    case "counter-regressed":
    case "bad-signature":
      return "proof_invalid";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

/**
 * The WebAuthn challenge for `binding` on `party`, base64url without padding: SHA-256 over the
 * JSON array of {@link ACTION_DIGEST_DOMAIN}, the RP ID, the binding's fields and the action's
 * fields in a fixed order. Fails with `invalid-binding` when the nonce or expiry is unusable.
 */
export async function actionChallenge(
  party: RelyingParty,
  binding: ActionBinding<ApprovableAction>,
): Promise<{ ok: true; challenge: string } | { ok: false; reason: "invalid-binding" }> {
  const nonce = decodeBase64Url(binding.nonce, MAX_CLIENT_DATA_BYTES);
  if (
    nonce === undefined ||
    nonce.length < MIN_NONCE_BYTES ||
    !Number.isSafeInteger(binding.expiresAt) ||
    binding.expiresAt < 0
  ) {
    return { ok: false, reason: "invalid-binding" };
  }
  const fields: (string | number | null)[] = [
    ACTION_DIGEST_DOMAIN,
    party.rpId,
    binding.repoId,
    binding.challengeId,
    binding.nonce,
    binding.expiresAt,
    ...actionFields(binding.action),
  ];
  const digest = await sha256(new TextEncoder().encode(JSON.stringify(fields)));
  return { ok: true, challenge: encodeBase64Url(digest) };
}

function actionFields(action: ApprovableAction): (string | number | null)[] {
  switch (action.kind) {
    case "invite.create":
      return [action.kind, action.name];
    case "agent.confirm":
      return [action.kind, action.agentId, action.code];
    case "agent.revoke":
      return [action.kind, action.agentId];
    case "issue.file":
      return [action.kind, action.title, action.body];
    case "decision.record":
      return [action.kind, action.decisionId, action.option, action.expectedVersion];
    case "demo.seed":
      return [action.kind, action.head];
    case "demo.reset":
      return [action.kind];
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

/**
 * Verifies that `assertion` is the owner's approval of exactly `binding`, from the fixed origin,
 * with user verification, before the challenge expires. It does not record the challenge as used.
 */
export async function verifyActionAssertion(input: ActionAssertionInput): Promise<PasskeyResult> {
  const { relyingParty: party, binding, credential, assertion, now } = input;
  // Recheck the relying party: a caller can build the object without `relyingParty()`.
  const known = relyingParty(party.rpId);
  if (known === undefined || known.origin !== party.origin) return fail("invalid-binding");
  const expected = await actionChallenge(known, binding);
  if (!expected.ok) return fail(expected.reason);
  if (now >= binding.expiresAt) return fail("expired");

  const publicKey = await importCoseKey(credential.publicKey);
  if (publicKey === undefined) return fail("credential-unusable");
  if (assertion.credentialId !== credential.credentialId) return fail("unknown-credential");

  const credentialId = decodeBase64Url(assertion.credentialId, MAX_CREDENTIAL_ID_BYTES);
  const clientDataBytes = decodeBase64Url(assertion.clientDataJson, MAX_CLIENT_DATA_BYTES);
  const authData = decodeBase64Url(assertion.authenticatorData, MAX_AUTHENTICATOR_DATA_BYTES);
  const derSignature = decodeBase64Url(assertion.signature, MAX_SIGNATURE_BYTES);
  if (
    credentialId === undefined ||
    credentialId.length === 0 ||
    clientDataBytes === undefined ||
    authData === undefined ||
    authData.length < AUTH_DATA_MIN ||
    derSignature === undefined
  ) {
    return fail("malformed");
  }
  const signature = derToRawSignature(derSignature);
  if (signature === undefined) return fail("malformed");

  const clientData = parseClientData(clientDataBytes);
  if (clientData === undefined) return fail("malformed");
  if (clientData.type !== "webauthn.get") return fail("wrong-type");
  if (clientData.challenge !== expected.challenge) return fail("challenge-mismatch");
  if (
    clientData.origin !== known.origin ||
    clientData.crossOrigin === true ||
    clientData.topOrigin !== undefined
  ) {
    return fail("origin-mismatch");
  }

  const rpIdHash = await sha256(new TextEncoder().encode(known.rpId));
  if (!equalBytes(authData.subarray(0, 32), rpIdHash)) return fail("rp-mismatch");
  const flags = authData[32] ?? 0;
  if ((flags & FLAG_USER_PRESENT) === 0) return fail("user-not-present");
  if ((flags & FLAG_USER_VERIFIED) === 0) return fail("user-not-verified");
  // WebAuthn L3 7.2 step 18: backup state without backup eligibility is invalid.
  if ((flags & FLAG_BACKED_UP) !== 0 && (flags & FLAG_BACKUP_ELIGIBLE) === 0) {
    return fail("backup-state-invalid");
  }

  if (assertion.userHandle !== null && assertion.userHandle !== credential.userHandle) {
    return fail("user-mismatch");
  }

  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0, false);
  if ((signCount !== 0 || credential.signCount !== 0) && signCount <= credential.signCount) {
    return fail("counter-regressed");
  }

  const clientDataHash = await sha256(clientDataBytes);
  const signed = new Uint8Array(authData.length + clientDataHash.length);
  signed.set(authData, 0);
  signed.set(clientDataHash, authData.length);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    signed,
  );
  if (!valid) return fail("bad-signature");
  return { ok: true, signCount };
}

function fail(reason: PasskeyFailure): PasskeyResult {
  return { ok: false, reason };
}

interface ClientData {
  type: unknown;
  challenge: unknown;
  origin: unknown;
  crossOrigin: unknown;
  topOrigin: unknown;
}

function parseClientData(bytes: Uint8Array<ArrayBuffer>): ClientData | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return undefined;
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = { ...value };
  return {
    type: record["type"],
    challenge: record["challenge"],
    origin: record["origin"],
    crossOrigin: record["crossOrigin"],
    topOrigin: record["topOrigin"],
  };
}

/** Imports an ES256 COSE_Key (RFC 9053) as a WebCrypto verification key. */
async function importCoseKey(bytes: Uint8Array): Promise<CryptoKey | undefined> {
  if (bytes.length > MAX_COSE_KEY_BYTES) return undefined;
  const map = readCborIntMap(bytes);
  if (map === undefined) return undefined;
  const x = map.get(-2);
  const y = map.get(-3);
  if (
    map.size !== 5 ||
    map.get(1) !== COSE_KTY_EC2 ||
    map.get(3) !== COSE_ALG_ES256 ||
    map.get(-1) !== COSE_CRV_P256 ||
    !(x instanceof Uint8Array) ||
    x.length !== 32 ||
    !(y instanceof Uint8Array) ||
    y.length !== 32
  ) {
    return undefined;
  }
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(x, 1);
  raw.set(y, 33);
  try {
    return await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch (error) {
    // A point that is not on the curve is refused by WebCrypto with a DataError.
    if (error instanceof DOMException) return undefined;
    throw error;
  }
}

/**
 * Reads one definite-length CBOR map whose keys are integers and whose values are integers or byte
 * strings, consuming all of `bytes`. Anything else, including duplicate keys, is refused.
 */
function readCborIntMap(bytes: Uint8Array): Map<number, number | Uint8Array> | undefined {
  let offset = 0;
  const head = (): { major: number; value: number } | undefined => {
    const first = bytes[offset];
    if (first === undefined) return undefined;
    offset += 1;
    const major = first >> 5;
    const info = first & 0x1f;
    if (info < 24) return { major, value: info };
    if (info === 24) {
      const b = bytes[offset];
      if (b === undefined || b < 24) return undefined;
      offset += 1;
      return { major, value: b };
    }
    if (info === 25) {
      const hi = bytes[offset];
      const lo = bytes[offset + 1];
      if (hi === undefined || lo === undefined) return undefined;
      offset += 2;
      const value = (hi << 8) | lo;
      return value < 256 ? undefined : { major, value };
    }
    return undefined;
  };
  const item = (): number | Uint8Array | undefined => {
    const h = head();
    if (h === undefined) return undefined;
    switch (h.major) {
      case 0:
        return h.value;
      case 1:
        return -1 - h.value;
      case 2: {
        const end = offset + h.value;
        if (end > bytes.length) return undefined;
        const out = bytes.slice(offset, end);
        offset = end;
        return out;
      }
      default:
        return undefined;
    }
  };
  const top = head();
  if (top === undefined || top.major !== 5) return undefined;
  const map = new Map<number, number | Uint8Array>();
  for (let i = 0; i < top.value; i += 1) {
    const key = item();
    if (typeof key !== "number" || map.has(key)) return undefined;
    const value = item();
    if (value === undefined) return undefined;
    map.set(key, value);
  }
  return offset === bytes.length ? map : undefined;
}

/** Converts a strict DER ECDSA P-256 signature to the 64-byte `r || s` form WebCrypto verifies. */
function derToRawSignature(der: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) return undefined;
  const out = new Uint8Array(64);
  let offset = 2;
  for (const slot of [0, 32]) {
    if (der[offset] !== 0x02) return undefined;
    const length = der[offset + 1];
    if (length === undefined || length < 1 || length > 33) return undefined;
    const start = offset + 2;
    const end = start + length;
    if (end > der.length) return undefined;
    const value = der.subarray(start, end);
    const first = value[0] ?? 0;
    // Negative, or led by a zero byte that is not needed to keep the next byte's sign bit clear.
    if ((first & 0x80) !== 0) return undefined;
    if (length > 1 && first === 0 && ((value[1] ?? 0) & 0x80) === 0) return undefined;
    if (length === 33 && first !== 0) return undefined;
    const trimmed = length === 33 ? value.subarray(1) : value;
    out.set(trimmed, slot + 32 - trimmed.length);
    offset = end;
  }
  return offset === der.length ? out : undefined;
}

/** Decodes canonical base64url without padding, refusing more than `maxBytes` decoded bytes. */
function decodeBase64Url(text: string, maxBytes: number): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  if (Math.floor((text.length * 3) / 4) > maxBytes) return undefined;
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  // Refuse non-zero trailing bits, so each byte string has exactly one accepted spelling.
  return encodeBase64Url(bytes) === text ? bytes : undefined;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
