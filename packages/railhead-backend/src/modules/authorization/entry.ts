// Authorization: durable merge intents. While missing, no merge is authorized. Until its task installs the module, every call refuses with `unavailable` and has no effect.
//
// The implementation is `createAuthorization` in `train/authorize.ts`. It reads the train, claims,
// inbox and decisions modules through synchronous in-transaction readers those ports do not publish yet
// (#107); this entry installs it once they do.

import type { AuthorizationPort } from "../../contracts/train";
import { unavailableAuthorization } from "../../contracts/unavailable";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the authorization module of one repository. */
export const authorization: ModuleFactory<AuthorizationPort> = () => unavailableAuthorization;
