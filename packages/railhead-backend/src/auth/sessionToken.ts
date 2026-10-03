// Session tokens: `<header>.<claims>.<mac>`, each part base64url without padding. The header is
// fixed, the claims are `SessionClaims` as JSON, and the MAC is HMAC-SHA256 over the first two
// parts with a key only the issuing repository holds. Only that repository verifies its tokens, so
// a symmetric key is enough and no other party ever needs to read one.

import { isSessionTokenForm, SESSION_TTL_MS } from "@railhead/shared/agent-api";
import { isId } from "@railhead/shared/events";
import type { SessionClaims } from "../contracts/principals";
import { decodeBase64Url, encodeBase64Url } from "../modules/owner/encoding";

/** The only header a token carries, already encoded. */
const HEADER = encodeBase64Url(new TextEncoder().encode('{"alg":"HS256","typ":"JWT"}'));

/** Largest claims part read, in bytes; real claims are under 200. */
const MAX_CLAIMS_BYTES = 1024;

/** Length of a session HMAC key, in bytes. */
export const SESSION_KEY_BYTES = 32;

const JTI = /^[0-9a-f]{32}$/;

/** Why a token was not accepted. Every case is `unauthenticated` to the caller. */
export type SessionTokenFailure = "malformed" | "bad-mac" | "expired";

/** The outcome of {@link verifySessionToken}. */
export type SessionTokenResult =
  | { readonly ok: true; readonly claims: SessionClaims }
  | { readonly ok: false; readonly reason: SessionTokenFailure };

/** Imports `secret`, {@link SESSION_KEY_BYTES} random bytes, as the HMAC key tokens are signed with. */
export function importSessionKey(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Signs `claims` with `key`. */
export async function signSessionToken(key: CryptoKey, claims: SessionClaims): Promise<string> {
  const body = `${HEADER}.${encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${encodeBase64Url(new Uint8Array(mac))}`;
}

/**
 * Verifies `token`'s MAC with `key` and returns its claims while `now` is before their expiry. The
 * token is untrusted: its form, header, MAC and every claim are checked here.
 */
export async function verifySessionToken(
  key: CryptoKey,
  token: string,
  now: number,
): Promise<SessionTokenResult> {
  if (!isSessionTokenForm(token)) return { ok: false, reason: "malformed" };
  const [header, payload, macText] = token.split(".");
  if (header !== HEADER || payload === undefined || macText === undefined) {
    return { ok: false, reason: "malformed" };
  }
  const mac = decodeBase64Url(macText, 32);
  if (mac === undefined || mac.length !== 32) return { ok: false, reason: "malformed" };
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    mac,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!valid) return { ok: false, reason: "bad-mac" };
  const claims = parseClaims(payload);
  if (claims === undefined) return { ok: false, reason: "malformed" };
  if (now >= claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

function parseClaims(payload: string): SessionClaims | undefined {
  const bytes = decodeBase64Url(payload, MAX_CLAIMS_BYTES);
  if (bytes === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return undefined;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const [v, sub, owner, repo, iat, exp, jti] = [
    "v",
    "sub",
    "owner",
    "repo",
    "iat",
    "exp",
    "jti",
  ].map((name): unknown => Object.getOwnPropertyDescriptor(parsed, name)?.value);
  if (
    v !== 1 ||
    typeof sub !== "string" ||
    !isId("agent", sub) ||
    typeof owner !== "string" ||
    !isId("user", owner) ||
    typeof repo !== "string" ||
    !isId("repo", repo) ||
    typeof iat !== "number" ||
    !Number.isSafeInteger(iat) ||
    iat < 0 ||
    typeof exp !== "number" ||
    exp !== iat + SESSION_TTL_MS ||
    typeof jti !== "string" ||
    !JTI.test(jti)
  ) {
    return undefined;
  }
  return { v, sub, owner, repo, iat, exp, jti };
}
