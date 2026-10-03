// Byte helpers shared by the owner module's enrollment and action challenges.

/** Decodes canonical base64url without padding, refusing more than `maxBytes` decoded bytes. */
export function decodeBase64Url(
  text: string,
  maxBytes: number,
): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  if (Math.floor((text.length * 3) / 4) > maxBytes) return undefined;
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  // Refuse non-zero trailing bits, so each byte string has exactly one accepted spelling.
  return encodeBase64Url(bytes) === text ? bytes : undefined;
}

/** Encodes `bytes` as base64url without padding. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** `count` random bytes as lowercase hex. */
export function randomHex(count: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(count)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** `count` random bytes as base64url without padding. */
export function randomBase64Url(count: number): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(count)));
}

/** The SHA-256 digest of `bytes`. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

/** Compares two byte strings in time that depends only on their lengths. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
