// Inbox: durable items and acknowledgements. While missing, the ready gate is never clear. Until its task installs the module, every call refuses with `unavailable` and has no effect.

import type { InboxPort } from "../../contracts/inbox";
import { unavailableInbox } from "../../contracts/unavailable";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the inbox module of one repository. */
export const inbox: ModuleFactory<InboxPort> = () => unavailableInbox;
