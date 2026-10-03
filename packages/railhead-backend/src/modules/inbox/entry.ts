// Inbox: durable items, delivery facts and acknowledgements, and the ready gate's read.

import type { InboxPort } from "../../contracts/inbox";
import type { ModuleFactory } from "../../repo/composeRepo";
import { createInbox } from "./inbox";

/** Builds the inbox module of one repository. */
export const inbox: ModuleFactory<InboxPort> = (context) => createInbox(context);
