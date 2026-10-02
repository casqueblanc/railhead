import { fileURLToPath } from "node:url";
import { validatePolicy } from "./policy.mjs";

const snapshot = await validatePolicy(fileURLToPath(new URL("../../", import.meta.url)));
process.stdout.write(`Local engineering wiring verified (${snapshot.skills.length} skills).\n`);
