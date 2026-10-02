import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { API_PATH, type PublicApi } from "@railhead/shared/api";

@validateRpc<PublicApi>()
class PublicApiImpl extends RpcTarget implements PublicApi {
  async ping(): Promise<void> {}
}

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== API_PATH) return new Response("Not found", { status: 404 });

    // WebSocket sessions only. capnweb's HTTP batch handler throws on a body that is not valid
    // JSON, while a session answers a malformed frame by aborting itself.
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", {
        status: 426,
        headers: { Upgrade: "websocket" },
      });
    }

    // Sessions are accepted from any origin, which is sound only while every authority is granted
    // in band: a method that takes credentials and returns the authorized capability.
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    newWebSocketRpcSession(server, new PublicApiImpl());
    return new Response(null, { status: 101, webSocket: client });
  },
} satisfies ExportedHandler<Env>;
