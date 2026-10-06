// Encoders for the WebAuthn messages a software passkey builds: base64url, SHA-256, CBOR heads and
// text, and DER integers.

const enc = new TextEncoder();

/** Unpadded base64url text of `bytes`. */
export function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The SHA-256 digest of `bytes`. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

/** A CBOR head for `major` with `length`, which must be below 65,536. */
export function cborHead(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length];
  if (length < 256) return [(major << 5) | 24, length];
  return [(major << 5) | 25, length >> 8, length & 0xff];
}

/** A CBOR text string holding `text`. */
export function cborText(text: string): number[] {
  const bytes = enc.encode(text);
  return [...cborHead(3, bytes.length), ...bytes];
}

/** A DER INTEGER for the unsigned big-endian `raw`, minimally encoded. */
export function derInteger(raw: Uint8Array): number[] {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start += 1;
  const body = [...raw.subarray(start)];
  if ((body[0] ?? 0) & 0x80) body.unshift(0);
  return [0x02, body.length, ...body];
}
