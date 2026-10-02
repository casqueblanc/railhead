import { describe, expect, it } from "vitest";
import { apiUrl } from "./apiSession";

describe("apiUrl", () => {
  it("uses a plain WebSocket on an http origin", () => {
    expect(apiUrl({ protocol: "http:", host: "localhost:3000" })).toBe("ws://localhost:3000/api");
  });

  it("uses a secure WebSocket on an https origin", () => {
    expect(apiUrl({ protocol: "https:", host: "foreman.example" })).toBe(
      "wss://foreman.example/api",
    );
  });
});
