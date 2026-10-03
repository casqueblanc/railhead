import { describe, expect, it } from "vitest";
import {
  ACTION_CHALLENGE_TTL_MS,
  type ActionChallenge,
  type EnrollmentChallenge,
} from "@railhead/shared/board-api";
import { FAKE_ENCODED, fakeAuthenticator } from "./fakeAuthenticator";
import { fromBase64Url, registerPasskey, signAction, toBase64Url } from "./webauthn";

const NOW = Date.UTC(2026, 9, 2, 12);

/** A signal no one aborts. */
const live = new AbortController().signal;

const actionChallenge = (overrides: Partial<ActionChallenge> = {}): ActionChallenge => ({
  challengeId: "chl_1",
  challenge: "AAECAw",
  rpId: "railhead.dev",
  allowCredentials: ["AQID"],
  expiresAt: NOW + 60_000,
  ...overrides,
});

const enrollmentChallenge = (
  overrides: Partial<EnrollmentChallenge> = {},
): EnrollmentChallenge => ({
  challengeId: "enr_1",
  challenge: "AAECAw",
  rpId: "railhead.dev",
  userHandle: "BAUG",
  expiresAt: NOW + 60_000,
  ...overrides,
});

describe("base64url", () => {
  it("round-trips bytes without padding or URL-unsafe characters", () => {
    const bytes = new Uint8Array([251, 255, 191, 0]);
    const text = toBase64Url(bytes.buffer);
    expect(text).toBe("-_-_AA");
    expect(fromBase64Url(text)).toEqual(bytes);
  });

  it("encodes no bytes as the empty string", () => {
    expect(toBase64Url(new ArrayBuffer(0))).toBe("");
    expect(fromBase64Url("")).toEqual(new Uint8Array(0));
  });

  it("refuses padding, standard base64 and impossible lengths", () => {
    expect(fromBase64Url("AA==")).toBeNull();
    expect(fromBase64Url("+/AA")).toBeNull();
    expect(fromBase64Url("AAAAA")).toBeNull();
  });
});

describe("signAction", () => {
  it("asks for a user-verified assertion over the challenge and encodes the credential", async () => {
    const { authenticator, requests } = fakeAuthenticator();
    const outcome = await signAction(authenticator, actionChallenge(), live);

    expect(outcome).toEqual({
      kind: "done",
      value: {
        credentialId: FAKE_ENCODED.credentialId,
        clientDataJson: FAKE_ENCODED.clientDataJson,
        authenticatorData: FAKE_ENCODED.authenticatorData,
        signature: FAKE_ENCODED.signature,
        userHandle: FAKE_ENCODED.userHandle,
      },
    });
    const publicKey = requests[0]?.publicKey;
    expect(publicKey?.rpId).toBe("railhead.dev");
    expect(publicKey?.userVerification).toBe("required");
    expect(publicKey?.timeout).toBe(ACTION_CHALLENGE_TTL_MS);
    expect(publicKey?.challenge).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(publicKey?.allowCredentials).toEqual([
      { type: "public-key", id: new Uint8Array([1, 2, 3]) },
    ]);
  });

  it("hands the browser the signal that cancels its prompt", async () => {
    const { authenticator, requests } = fakeAuthenticator();
    const controller = new AbortController();
    await signAction(authenticator, actionChallenge(), controller.signal);

    controller.abort();
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  it("reports a dismissed prompt and a missing credential as cancelled", async () => {
    for (const answer of ["dismiss", "none"] as const) {
      const { authenticator } = fakeAuthenticator(() => answer);
      expect(await signAction(authenticator, actionChallenge(), live)).toEqual({
        kind: "cancelled",
      });
    }
  });

  it("does not prompt for a challenge it cannot decode", async () => {
    const { authenticator, requests } = fakeAuthenticator();
    const unreadable = await signAction(authenticator, actionChallenge({ challenge: "A=" }), live);
    const badCredential = await signAction(
      authenticator,
      actionChallenge({ allowCredentials: ["AQID", "not base64!"] }),
      live,
    );

    expect(unreadable.kind).toBe("failed");
    expect(badCredential.kind).toBe("failed");
    expect(requests).toHaveLength(0);
  });

  it("leaves expiry to the backend's clock and prompts for the challenge lifetime", async () => {
    const { authenticator, requests } = fakeAuthenticator();
    const outcome = await signAction(authenticator, actionChallenge({ expiresAt: 0 }), live);

    expect(outcome.kind).toBe("done");
    expect(requests[0]?.publicKey?.timeout).toBe(ACTION_CHALLENGE_TTL_MS);
  });

  it("fails on a browser error or a credential without a signature", async () => {
    for (const answer of ["error", "malformed"] as const) {
      const { authenticator } = fakeAuthenticator(() => answer);
      const outcome = await signAction(authenticator, actionChallenge(), live);
      expect(outcome.kind).toBe("failed");
    }
  });
});

describe("registerPasskey", () => {
  it("creates an ES256 passkey for the owner's user handle and encodes the attestation", async () => {
    const { authenticator, creations } = fakeAuthenticator();
    const outcome = await registerPasskey(authenticator, enrollmentChallenge(), live);

    expect(outcome).toEqual({
      kind: "done",
      value: {
        credentialId: FAKE_ENCODED.credentialId,
        clientDataJson: FAKE_ENCODED.clientDataJson,
        attestationObject: FAKE_ENCODED.attestationObject,
      },
    });
    const publicKey = creations[0]?.publicKey;
    expect(publicKey?.rp).toEqual({ id: "railhead.dev", name: "Railhead" });
    expect(publicKey?.user.id).toEqual(new Uint8Array([4, 5, 6]));
    expect(publicKey?.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
    expect(publicKey?.authenticatorSelection?.userVerification).toBe("required");
  });

  it("hands the browser the signal that cancels its prompt", async () => {
    const { authenticator, creations } = fakeAuthenticator();
    const controller = new AbortController();
    await registerPasskey(authenticator, enrollmentChallenge(), controller.signal);

    controller.abort();
    expect(creations[0]?.signal?.aborted).toBe(true);
  });

  it("reports a dismissed prompt as cancelled", async () => {
    const { authenticator } = fakeAuthenticator(() => "dismiss");
    expect(await registerPasskey(authenticator, enrollmentChallenge(), live)).toEqual({
      kind: "cancelled",
    });
  });

  it("does not prompt for an unreadable user handle", async () => {
    const { authenticator, creations } = fakeAuthenticator();
    const unreadable = await registerPasskey(
      authenticator,
      enrollmentChallenge({ userHandle: "?" }),
      live,
    );
    expect(unreadable.kind).toBe("failed");
    expect(creations).toHaveLength(0);
  });

  it("leaves expiry to the backend's clock and prompts for the challenge lifetime", async () => {
    const { authenticator, creations } = fakeAuthenticator();
    const outcome = await registerPasskey(
      authenticator,
      enrollmentChallenge({ expiresAt: 0 }),
      live,
    );

    expect(outcome.kind).toBe("done");
    expect(creations[0]?.publicKey?.timeout).toBe(ACTION_CHALLENGE_TTL_MS);
  });

  it("fails on a credential without an attestation object", async () => {
    const { authenticator } = fakeAuthenticator(() => "malformed");
    expect((await registerPasskey(authenticator, enrollmentChallenge(), live)).kind).toBe("failed");
  });
});
