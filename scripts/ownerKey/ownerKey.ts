// A software owner passkey for qualification instances: an ES256 key in a file, which enrolls as
// the instance owner and signs owner challenges as a browser authenticator would. The owner allowed
// it on 2026-10-06 for qualification instances only, so it refuses `railhead.dev` and its
// subdomains; that instance keeps the owner's own passkey.
//
// The key file holds the P-256 private key as a JWK, the credential id, the user handle, the
// signature counter and the relying-party host. It is created with mode 0600, never inside a Git
// checkout, and refused when it is readable by anyone but its owner. Every write goes to a
// temporary file that is synced and then renamed over it, and `sign` stores the advanced counter
// before it signs, since the backend refuses a counter that does not grow. Run one signer per key
// at a time: two at once can sign with the same counter, and the backend refuses the second.
//
// Nothing here prints or logs the key, and refusals name the file, never its contents.

import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as signData,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
  ActionChallenge,
  EnrollmentChallenge,
  PasskeyAssertion,
  PasskeyRegistration,
} from "../../packages/railhead-shared/src/board-api.ts";

/** The key file layout this module reads and writes. */
const KEY_FILE_VERSION = 1;

/** The instance whose owner keeps a hardware passkey; a software key never acts on it. */
const DEMO_HOST = "railhead.dev";

/** User presence and user verification, the flags the backend requires. */
const FLAGS_UP_UV = 0x01 | 0x04;
/** Attested credential data follows the counter, in a registration only. */
const FLAG_ATTESTED_CREDENTIAL = 0x40;

/** The largest value the authenticator data's 32-bit counter holds. */
const MAX_SIGN_COUNT = 0xff_ff_ff_ff;

const CREDENTIAL_ID_BYTES = 16;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The key file was refused, or a challenge it was asked to sign was. */
export class OwnerKeyRefusal extends Error {
  override readonly name = "OwnerKeyRefusal";
}

/** What an owner challenge's `perform` takes: the challenge it answers and the assertion. */
export interface SignedChallenge {
  /** The challenge id from `prepare`. */
  readonly challengeId: string;
  /** The assertion over that challenge. */
  readonly assertion: PasskeyAssertion;
}

/** The contents of a key file. */
interface OwnerKey {
  readonly version: typeof KEY_FILE_VERSION;
  /** The relying party: the exact host of the instance the key is enrolled on. */
  readonly rpId: string;
  /** The credential id, base64url without padding. */
  readonly credentialId: string;
  /** The user handle the instance registered, base64url without padding. */
  readonly userHandle: string;
  /** The counter of the last signature, 0 before the first. */
  readonly signCount: number;
  /** The P-256 private key. */
  readonly privateKey: JsonWebKey;
}

/**
 * Creates the key file at `path` for the enrollment `prepared` opened, and returns the registration
 * `OwnerEnrollmentApi.complete` takes for it: an ES256 credential with `none` attestation. Refuses
 * an existing file, a path inside a Git checkout and a `railhead.dev` relying party.
 */
export function register(path: string, prepared: EnrollmentChallenge): PasskeyRegistration {
  const rpId = qualificationHost(prepared.rpId);
  if (!BASE64URL.test(prepared.challenge) || !BASE64URL.test(prepared.userHandle)) {
    throw new OwnerKeyRefusal(
      "The enrollment challenge's challenge and userHandle must be base64url.",
    );
  }
  const file = outsideCheckout(path);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  const id = randomBytes(CREDENTIAL_ID_BYTES);
  const key: OwnerKey = {
    version: KEY_FILE_VERSION,
    rpId,
    credentialId: id.toString("base64url"),
    userHandle: prepared.userHandle,
    signCount: 0,
    privateKey: jwk,
  };
  const authenticatorData = Buffer.concat([
    rpIdHash(rpId),
    Uint8Array.of(FLAGS_UP_UV | FLAG_ATTESTED_CREDENTIAL),
    counterBytes(0),
    Buffer.alloc(16), // AAGUID: none for a `none` attestation
    lengthBytes(id.length),
    id,
    coseKey(jwk),
  ]);
  const attestationObject = Buffer.concat([
    Uint8Array.of(0xa3),
    cborText("fmt"),
    cborText("none"),
    cborText("attStmt"),
    Uint8Array.of(0xa0),
    cborText("authData"),
    cborBytes(authenticatorData),
  ]);
  writeNew(file, key);
  return {
    credentialId: key.credentialId,
    clientDataJson: clientData("webauthn.create", prepared.challenge, rpId),
    attestationObject: attestationObject.toString("base64url"),
  };
}

/**
 * Signs `challenge`, an `OwnerApi` or `DemoSeedApi` challenge, with the key at `path`, storing the
 * advanced counter first. Refuses a challenge for another relying party or credential, and a key
 * file that is unreadable, readable by others, malformed or for `railhead.dev`.
 */
export function sign(path: string, challenge: ActionChallenge): SignedChallenge {
  const file = resolve(path);
  const key = readKey(file);
  if (challenge.rpId !== key.rpId) {
    throw new OwnerKeyRefusal(
      `The challenge is for ${JSON.stringify(challenge.rpId)}, and ${file} signs only for ${key.rpId}.`,
    );
  }
  if (!challenge.allowCredentials.includes(key.credentialId)) {
    throw new OwnerKeyRefusal(`The challenge does not allow the credential in ${file}.`);
  }
  if (!BASE64URL.test(challenge.challenge)) {
    throw new OwnerKeyRefusal("The challenge's WebAuthn challenge is not base64url.");
  }
  if (key.signCount >= MAX_SIGN_COUNT) {
    throw new OwnerKeyRefusal(`The counter in ${file} is exhausted; enroll another key.`);
  }
  const signCount = key.signCount + 1;
  replace(file, { ...key, signCount });

  const authenticatorData = Buffer.concat([
    rpIdHash(key.rpId),
    Uint8Array.of(FLAGS_UP_UV),
    counterBytes(signCount),
  ]);
  const clientDataJson = clientData("webauthn.get", challenge.challenge, key.rpId);
  const signed = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(Buffer.from(clientDataJson, "base64url")).digest(),
  ]);
  const signature = signData("sha256", signed, {
    key: privateKeyOf(key, file),
    dsaEncoding: "der",
  });
  return {
    challengeId: challenge.challengeId,
    assertion: {
      credentialId: key.credentialId,
      clientDataJson,
      authenticatorData: authenticatorData.toString("base64url"),
      signature: signature.toString("base64url"),
      userHandle: key.userHandle,
    },
  };
}

/** The relying-party host of the key at `path`, after the same checks `sign` makes. */
export function keyHost(path: string): string {
  return readKey(resolve(path)).rpId;
}

/** `host` when a software key may act on it: a lowercase host that is not `railhead.dev`'s. */
function qualificationHost(host: string): string {
  if (!HOST.test(host)) {
    throw new OwnerKeyRefusal(`${JSON.stringify(host)} is not a relying-party host.`);
  }
  if (host === DEMO_HOST || host.endsWith(`.${DEMO_HOST}`)) {
    throw new OwnerKeyRefusal(
      `A software owner key never acts on ${host}; it keeps the owner's own passkey.`,
    );
  }
  return host;
}

/** `path`, absolute, when no directory above it holds a `.git`: a key must never be committed. */
function outsideCheckout(path: string): string {
  const file = resolve(path);
  let directory: string;
  try {
    directory = realpathSync(dirname(file));
  } catch (error) {
    throw new OwnerKeyRefusal(`The directory of ${file} does not exist.`, { cause: error });
  }
  for (let at = directory; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) {
      throw new OwnerKeyRefusal(
        `${file} is inside the Git checkout ${at}; keep the key outside it.`,
      );
    }
    if (dirname(at) === at) return join(directory, basename(file));
  }
}

function readKey(file: string): OwnerKey {
  let text: string;
  try {
    // Checked before reading, so a key others can read is refused even when it parses.
    if ((statSync(file).mode & 0o077) !== 0) {
      throw new OwnerKeyRefusal(`${file} is readable by others; run chmod 600 on it.`);
    }
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof OwnerKeyRefusal) throw error;
    throw new OwnerKeyRefusal(`${file} is not a readable key file.`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new OwnerKeyRefusal(`${file} is not a key file.`, { cause: error });
  }
  const key = parseKey(value);
  if (key === undefined) throw new OwnerKeyRefusal(`${file} is not a key file.`);
  qualificationHost(key.rpId);
  privateKeyOf(key, file);
  return key;
}

function parseKey(value: unknown): OwnerKey | undefined {
  if (!isRecord(value) || !isRecord(value.privateKey)) return undefined;
  const { version, rpId, credentialId, userHandle, signCount, privateKey } = value;
  const { kty, crv, x, y, d } = privateKey;
  if (
    version !== KEY_FILE_VERSION ||
    typeof rpId !== "string" ||
    !isBase64Url(credentialId) ||
    !isBase64Url(userHandle) ||
    typeof signCount !== "number" ||
    !Number.isSafeInteger(signCount) ||
    signCount < 0 ||
    signCount > MAX_SIGN_COUNT ||
    kty !== "EC" ||
    crv !== "P-256" ||
    !isBase64Url(x) ||
    !isBase64Url(y) ||
    !isBase64Url(d)
  ) {
    return undefined;
  }
  return {
    version,
    rpId,
    credentialId,
    userHandle,
    signCount,
    privateKey: { kty, crv, x, y, d },
  };
}

function privateKeyOf(key: OwnerKey, file: string): KeyObject {
  try {
    return createPrivateKey({ key: key.privateKey, format: "jwk" });
  } catch (error) {
    throw new OwnerKeyRefusal(`${file} does not hold a usable P-256 key.`, { cause: error });
  }
}

/** Writes `key` to `file`, which must not exist yet. */
function writeNew(file: string, key: OwnerKey): void {
  const temporary = writeTemporary(file, key);
  try {
    // A hard link fails on an existing file, so an enrolled key is never overwritten.
    linkSync(temporary, file);
  } catch (error) {
    throw new OwnerKeyRefusal(`${file} already exists or cannot be created.`, { cause: error });
  } finally {
    unlinkSync(temporary);
  }
}

/** Replaces `file` with `key` in one rename. */
function replace(file: string, key: OwnerKey): void {
  const temporary = writeTemporary(file, key);
  try {
    renameSync(temporary, file);
  } catch (error) {
    unlinkSync(temporary);
    throw new OwnerKeyRefusal(`${file} cannot be updated.`, { cause: error });
  }
}

/** Writes `key` to a new 0600 file beside `file`, synced to disk, and returns its path. */
function writeTemporary(file: string, key: OwnerKey): string {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number;
  try {
    fd = openSync(temporary, "wx", 0o600);
  } catch (error) {
    throw new OwnerKeyRefusal(`Cannot write beside ${file}.`, { cause: error });
  }
  try {
    writeSync(fd, `${JSON.stringify(key)}\n`);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw new OwnerKeyRefusal(`Cannot write beside ${file}.`, { cause: error });
  }
  closeSync(fd);
  return temporary;
}

/** `clientDataJSON` as a browser on `https://<rpId>` writes it, base64url. */
function clientData(
  type: "webauthn.create" | "webauthn.get",
  challenge: string,
  rpId: string,
): string {
  return Buffer.from(
    JSON.stringify({ type, challenge, origin: `https://${rpId}`, crossOrigin: false }),
  ).toString("base64url");
}

function rpIdHash(rpId: string): Buffer {
  return createHash("sha256").update(rpId).digest();
}

function counterBytes(count: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(count);
  return bytes;
}

function lengthBytes(length: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(length);
  return bytes;
}

/** The public half of `jwk` as the ES256 COSE_Key: {1: 2, 3: -7, -1: 1, -2: x, -3: y}. */
function coseKey(jwk: JsonWebKey): Buffer {
  const x = Buffer.from(jwk.x ?? "", "base64url");
  const y = Buffer.from(jwk.y ?? "", "base64url");
  if (x.length !== 32 || y.length !== 32)
    throw new Error("Node exported a P-256 key without its point.");
  return Buffer.concat([
    Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21),
    cborBytes(x),
    Uint8Array.of(0x22),
    cborBytes(y),
  ]);
}

/** A CBOR text string of fewer than 24 bytes, which is all the attestation object needs. */
function cborText(text: string): Buffer {
  const bytes = Buffer.from(text);
  return Buffer.concat([Uint8Array.of(0x60 | bytes.length), bytes]);
}

/** A CBOR byte string with its head in the shortest form. */
function cborBytes(bytes: Uint8Array): Buffer {
  const head =
    bytes.length < 24
      ? Uint8Array.of(0x40 | bytes.length)
      : bytes.length < 0x100
        ? Uint8Array.of(0x58, bytes.length)
        : Uint8Array.of(0x59, bytes.length >> 8, bytes.length & 0xff);
  return Buffer.concat([head, bytes]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBase64Url(value: unknown): value is string {
  return typeof value === "string" && BASE64URL.test(value);
}
