// Verifies OpenSSH `SSHSIG` Ed25519 signatures with WebCrypto and derives the enrolment
// confirmation code. Format reference: openssh-portable PROTOCOL.sshsig. Ported from the SSH
// signature spike (#8).

/** The signing namespace reserved for Railhead login challenges. */
export const SSHSIG_NAMESPACE = "railhead-auth";

/** Upper bound on a public key line or an armored signature, in UTF-16 code units. */
export const MAX_SSHSIG_TEXT = 4096;

/** Upper bound on a signed message, in bytes. Login challenges are a few hundred bytes. */
export const MAX_SSHSIG_MESSAGE = 4096;

/** Upper bound on an invite identifier fed to {@link confirmationCode}, in bytes. */
export const MAX_INVITE_ID = 256;

const KEY_TYPE = "ssh-ed25519";
const MAGIC = new TextEncoder().encode("SSHSIG");
const ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----";
const ARMOR_END = "-----END SSH SIGNATURE-----";
const CODE_DOMAIN = "railhead-confirm-v1";

/** Why a verification failed. Every case is a rejection; none is retryable. */
export type SshSigFailure =
  | "malformed-public-key"
  | "malformed-signature"
  | "malformed-message"
  | "unsupported-algorithm"
  | "key-mismatch"
  | "namespace-mismatch"
  | "bad-signature";

/** The outcome of {@link verifySshSig}. */
export type SshSigResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SshSigFailure };

/** A parsed `ssh-ed25519` public key: the SSH wire blob and the 32 raw key bytes. */
export interface Ed25519PublicKey {
  readonly blob: Uint8Array<ArrayBuffer>;
  readonly raw: Uint8Array<ArrayBuffer>;
}

class ParseError extends Error {}

class Reader {
  #offset = 0;
  readonly #bytes: Uint8Array<ArrayBuffer>;

  constructor(bytes: Uint8Array<ArrayBuffer>) {
    this.#bytes = bytes;
  }

  take(length: number): Uint8Array<ArrayBuffer> {
    const end = this.#offset + length;
    if (end > this.#bytes.length) throw new ParseError("truncated");
    const out = this.#bytes.slice(this.#offset, end);
    this.#offset = end;
    return out;
  }

  u32(): number {
    const b = this.take(4);
    return new DataView(b.buffer).getUint32(0, false);
  }

  string(): Uint8Array<ArrayBuffer> {
    return this.take(this.u32());
  }

  text(): string {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(this.string());
    } catch (error) {
      if (error instanceof TypeError) throw new ParseError("invalid utf-8");
      throw error;
    }
  }

  end(): void {
    if (this.#offset !== this.#bytes.length) throw new ParseError("trailing bytes");
  }
}

function base64Decode(text: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(text);
  } catch (error) {
    if (error instanceof DOMException) throw new ParseError("invalid base64");
    throw error;
  }
  // atob accepts some non-canonical input; requiring a round trip rejects it.
  if (btoa(binary) !== text) throw new ParseError("non-canonical base64");
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function sshString(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, false);
  out.set(bytes, 4);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function parseKeyBlob(blob: Uint8Array<ArrayBuffer>): Ed25519PublicKey {
  const r = new Reader(blob);
  if (r.text() !== KEY_TYPE) throw new ParseError("not ssh-ed25519");
  const raw = r.string();
  if (raw.length !== 32) throw new ParseError("bad key length");
  r.end();
  return { blob, raw };
}

function parseKeyLine(line: unknown): Ed25519PublicKey {
  if (typeof line !== "string" || line.length > MAX_SSHSIG_TEXT) {
    throw new ParseError("not a key line");
  }
  const [type, data] = line.trim().split(/\s+/);
  if (type !== KEY_TYPE || data === undefined) throw new ParseError("not ssh-ed25519");
  return parseKeyBlob(base64Decode(data));
}

/**
 * Parses an OpenSSH public key line (`ssh-ed25519 <base64> [comment]`). Returns `undefined` for
 * anything else, including other key types and input over {@link MAX_SSHSIG_TEXT}.
 */
export function parsePublicKey(line: unknown): Ed25519PublicKey | undefined {
  try {
    return parseKeyLine(line);
  } catch (error) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
}

interface SshSig {
  readonly publicKey: Uint8Array;
  readonly namespace: string;
  readonly hashAlgorithm: string;
  readonly signature: Uint8Array<ArrayBuffer>;
}

function parseArmored(armored: unknown): SshSig {
  if (typeof armored !== "string" || armored.length > MAX_SSHSIG_TEXT) {
    throw new ParseError("not text");
  }
  const lines = armored.trim().split(/\r?\n/);
  if (lines[0] !== ARMOR_BEGIN || lines.at(-1) !== ARMOR_END) throw new ParseError("bad armor");
  const r = new Reader(base64Decode(lines.slice(1, -1).join("")));
  if (!equalBytes(r.take(MAGIC.length), MAGIC)) throw new ParseError("bad magic");
  if (r.u32() !== 1) throw new ParseError("bad version");
  const publicKey = r.string();
  const namespace = r.text();
  // PROTOCOL.sshsig defines the reserved field as empty; nothing Railhead accepts sets it.
  if (r.string().length !== 0) throw new ParseError("reserved field set");
  const hashAlgorithm = r.text();
  const signature = parseSignatureBlob(r.string());
  r.end();
  return { publicKey, namespace, hashAlgorithm, signature };
}

function parseSignatureBlob(blob: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const r = new Reader(blob);
  if (r.text() !== KEY_TYPE) throw new ParseError("not ssh-ed25519");
  const sig = r.string();
  if (sig.length !== 64) throw new ParseError("bad signature length");
  r.end();
  return sig;
}

function hashName(alg: string): "SHA-256" | "SHA-512" | undefined {
  switch (alg) {
    case "sha256":
      return "SHA-256";
    case "sha512":
      return "SHA-512";
    default:
      return undefined;
  }
}

/**
 * Verifies an armored `SSHSIG` over `message`, made by `publicKeyLine`'s key in
 * {@link SSHSIG_NAMESPACE}. The key line and signature are untrusted and checked here; the
 * message must be at most {@link MAX_SSHSIG_MESSAGE} bytes.
 */
export async function verifySshSig(
  publicKeyLine: unknown,
  armored: unknown,
  message: Uint8Array,
): Promise<SshSigResult> {
  if (message.length > MAX_SSHSIG_MESSAGE) return { ok: false, reason: "malformed-message" };
  const key = parsePublicKey(publicKeyLine);
  if (key === undefined) return { ok: false, reason: "malformed-public-key" };
  let sig: SshSig;
  try {
    sig = parseArmored(armored);
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, reason: "malformed-signature" };
    throw error;
  }
  const hash = hashName(sig.hashAlgorithm);
  if (hash === undefined) return { ok: false, reason: "unsupported-algorithm" };
  if (!equalBytes(sig.publicKey, key.blob)) return { ok: false, reason: "key-mismatch" };
  if (sig.namespace !== SSHSIG_NAMESPACE) return { ok: false, reason: "namespace-mismatch" };

  const enc = new TextEncoder();
  const digest = new Uint8Array(await crypto.subtle.digest(hash, concat([message])));
  const signed = concat([
    MAGIC,
    sshString(enc.encode(sig.namespace)),
    sshString(new Uint8Array()),
    sshString(enc.encode(sig.hashAlgorithm)),
    sshString(digest),
  ]);
  const cryptoKey = await crypto.subtle.importKey("raw", key.raw, { name: "Ed25519" }, false, [
    "verify",
  ]);
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, sig.signature, signed);
  return valid ? { ok: true } : { ok: false, reason: "bad-signature" };
}

/**
 * The six-digit confirmation code a person compares between the agent's terminal and the board.
 * It must match the CLI's derivation:
 * SHA-256(string("railhead-confirm-v1") || string(key blob) || string(invite id)), the first eight
 * bytes as a big-endian u64, modulo 10^6, zero-padded. `string` is the SSH wire encoding.
 * Returns `undefined` for an invite identifier over {@link MAX_INVITE_ID} bytes.
 */
export async function confirmationCode(
  key: Ed25519PublicKey,
  inviteId: string,
): Promise<string | undefined> {
  const enc = new TextEncoder();
  const invite = enc.encode(inviteId);
  if (invite.length > MAX_INVITE_ID) return undefined;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    concat([sshString(enc.encode(CODE_DOMAIN)), sshString(key.blob), sshString(invite)]),
  );
  const head = new DataView(digest).getBigUint64(0, false);
  return (head % 1_000_000n).toString().padStart(6, "0");
}
