// Authorization: durable merge intents. Until the module is installed every call refuses with
// `unavailable`, so no merge is authorized.
//
// The implementation is `createAuthorization` in `train/authorize.ts`. The in-transaction readers
// it needs are the ones `mainWriter/entry.ts` already builds from the ports.

import type { AuthorizationPort } from "../../contracts/train";
import { unavailableAuthorization } from "../../contracts/unavailable";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the authorization module of one repository. */
export const authorization: ModuleFactory<AuthorizationPort> = () => unavailableAuthorization;
