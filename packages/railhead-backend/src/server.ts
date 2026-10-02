import { newWebSocketRpcSession } from "capnweb";
import { AGENT_PATH_PREFIX } from "@railhead/shared/agent-api";
import { API_PATH } from "@railhead/shared/api";
import { serveAgent } from "./gateway/agentHttp";
import { GIT_PATH_PREFIX, serveGit } from "./gateway/gitHttp";
import { RailheadApiImpl } from "./gateway/rpc";

export { Repo } from "./repo/RepoObject";
export { ContainerProxy, RailheadSandbox } from "./sandbox/sandboxObject";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(`${AGENT_PATH_PREFIX}/`)) return serveAgent(request, env);
    if (pathname.startsWith(GIT_PATH_PREFIX)) return serveGit(request, env);
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
    newWebSocketRpcSession(server, new RailheadApiImpl(env));
    return new Response(null, { status: 101, webSocket: client });
  },
} satisfies ExportedHandler<Env>;
