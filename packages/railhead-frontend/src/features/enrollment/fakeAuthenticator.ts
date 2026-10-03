// Test support: an authenticator that stands in for the browser's, records what it was asked and
// answers with fixed bytes or a scripted refusal. Its bytes sign nothing; only the backend verifies.

import type { Authenticator } from "./webauthn";

/** How the fake answers the next ceremony. */
export type FakeAnswer =
  | "sign"
  /** The person dismissed the prompt. */
  | "dismiss"
  /** The browser returned no credential. */
  | "none"
  /** The browser failed for another reason. */
  | "error"
  /** A credential missing its signature. */
  | "malformed";

const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;

/** Base64url of the fake's fields, for asserting what reached the backend. */
export const FAKE_ENCODED = {
  credentialId: "AQID",
  clientDataJson: "BAUG",
  authenticatorData: "BwgJ",
  signature: "CgsM",
  userHandle: "DQ4P",
  attestationObject: "EBES",
} as const;

/** A fake authenticator and the options of every ceremony it was asked for. */
export const fakeAuthenticator = (answer: () => FakeAnswer = () => "sign") => {
  const requests: CredentialRequestOptions[] = [];
  const creations: CredentialCreationOptions[] = [];

  const respond = (response: Record<string, ArrayBuffer | null>): Promise<Credential | null> => {
    switch (answer()) {
      case "sign":
        break;
      case "dismiss":
        return Promise.reject(new DOMException("The operation was cancelled.", "NotAllowedError"));
      case "none":
        return Promise.resolve(null);
      case "error":
        return Promise.reject(new DOMException("No authenticator.", "InvalidStateError"));
      case "malformed":
        return Promise.resolve(credential({ clientDataJSON: bytes(4, 5, 6) }));
    }
    return Promise.resolve(credential(response));
  };

  const authenticator: Authenticator = {
    get: (options) => {
      requests.push(options);
      return respond({
        clientDataJSON: bytes(4, 5, 6),
        authenticatorData: bytes(7, 8, 9),
        signature: bytes(10, 11, 12),
        userHandle: bytes(13, 14, 15),
      });
    },
    create: (options) => {
      creations.push(options);
      return respond({ clientDataJSON: bytes(4, 5, 6), attestationObject: bytes(16, 17, 18) });
    },
  };
  return { authenticator, requests, creations };
};

// A `PublicKeyCredential` cannot be constructed outside a browser ceremony, so the fake returns a
// plain object of the same shape, which is all `webauthn.ts` reads.
const credential = (response: Record<string, ArrayBuffer | null>): Credential => {
  const value = { id: "AQID", type: "public-key", rawId: bytes(1, 2, 3), response };
  return value;
};
