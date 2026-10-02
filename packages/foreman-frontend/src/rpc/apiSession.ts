import { newWebSocketRpcSession } from "capnweb";
import { API_PATH, type PublicApi } from "@foreman/shared/api";

/** The part of a backend RPC session the connection state depends on. */
export interface ApiSession extends Disposable {
  /** Resolves once the backend has answered over this session. */
  ping(): PromiseLike<unknown>;
  /** Registers a callback for the session failing, now or later. */
  onRpcBroken(callback: (error: unknown) => void): void;
}

/** WebSocket URL of the backend's RPC session on the origin that served `location`. */
export const apiUrl = (location: Pick<Location, "protocol" | "host">): string =>
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${API_PATH}`;

/** Opens an RPC session with the backend. The caller owns the returned stub and must dispose it. */
export const openApiSession = (): ApiSession =>
  newWebSocketRpcSession<PublicApi>(apiUrl(window.location));
