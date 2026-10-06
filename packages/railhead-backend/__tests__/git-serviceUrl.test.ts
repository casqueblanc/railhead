import { describe, expect, it } from "vitest";
import { artifactsHost } from "../src/checks/sdkCheckout";
import { gitServiceUrl } from "../src/git/serviceUrl";

describe("gitServiceUrl", () => {
  it("joins the suffix under an HTTPS remote", () => {
    expect(
      gitServiceUrl("https://a.example/r.git", "info/refs?service=git-upload-pack")?.href,
    ).toBe("https://a.example/r.git/info/refs?service=git-upload-pack");
  });

  it("drops trailing slashes before the join", () => {
    expect(gitServiceUrl("https://a.example/r.git//", "git-receive-pack")?.href).toBe(
      "https://a.example/r.git/git-receive-pack",
    );
  });

  it.each([
    "not a url",
    "http://a.example/r.git",
    "https://user@a.example/r.git",
    "https://:pw@a.example/r.git",
    "https://a.example/r.git?x=1",
    "https://a.example/r.git#f",
  ])("refuses %s", (remote) => {
    expect(gitServiceUrl(remote, "git-receive-pack")).toBeNull();
  });
});

describe("artifactsHost", () => {
  it("names the account's Artifacts host", () => {
    expect(artifactsHost("0123456789abcdef0123456789abcdef")).toBe(
      "0123456789abcdef0123456789abcdef.artifacts.cloudflare.net",
    );
  });

  it.each([
    ["an empty ID", ""],
    ["31 digits", "0123456789abcdef0123456789abcde"],
    ["33 digits", "0123456789abcdef0123456789abcdef0"],
    ["uppercase hex", "0123456789ABCDEF0123456789ABCDEF"],
    ["another host", "evil.example.com/x"],
  ])("refuses %s", (_name, accountId) => {
    expect(artifactsHost(accountId)).toBeNull();
  });
});
