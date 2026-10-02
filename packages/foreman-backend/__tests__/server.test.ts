import { SELF } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";
import { API_PATH, type PublicApi } from "@foreman/shared/api";

const API_URL = `https://foreman.invalid${API_PATH}`;

async function openSocket(): Promise<WebSocket> {
  const response = await SELF.fetch(API_URL, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return socket;
}

describe("RPC session", () => {
  it("answers ping", async () => {
    using api = newWebSocketRpcSession<PublicApi>(await openSocket());

    await expect(api.ping()).resolves.toBeUndefined();
  });

  it("rejects a method the public interface does not declare", async () => {
    using api = newWebSocketRpcSession<PublicApi & { secret(): Promise<void> }>(await openSocket());

    await expect(api.secret()).rejects.toThrow(TypeError);
  });

  it("aborts only the session that sent a malformed frame", async () => {
    const socket = await openSocket();
    using broken = newWebSocketRpcSession<PublicApi>(socket);
    await broken.ping();

    socket.send("not a capnweb message");

    await expect(broken.ping()).rejects.toThrow();
    using fresh = newWebSocketRpcSession<PublicApi>(await openSocket());
    await expect(fresh.ping()).resolves.toBeUndefined();
  });
});

describe("routing", () => {
  it("refuses an API request that is not a WebSocket upgrade", async () => {
    const response = await SELF.fetch(API_URL, { method: "POST", body: "not a capnweb batch" });

    expect(response.status).toBe(426);
    expect(response.headers.get("Upgrade")).toBe("websocket");
  });

  it("answers a path it does not serve with 404", async () => {
    const response = await SELF.fetch(`${API_URL}/unknown`, { headers: { Upgrade: "websocket" } });

    expect(response.status).toBe(404);
    expect(response.webSocket).toBeNull();
  });
});
