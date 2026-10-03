import { createFileRoute } from "@tanstack/react-router";
import { ReplayPage, type LoadSynthetic } from "../features/replay/ReplayPage";

// The synthetic fixtures are imported only by a development build, so production never ships them.
const loadSynthetic: LoadSynthetic | null = import.meta.env.DEV
  ? async () => (await import("../features/replay/syntheticReplays")).SYNTHETIC_REPLAYS
  : null;

const ReplayRoute = () => <ReplayPage loadSynthetic={loadSynthetic} />;

/** Replays a captured event log offline. The route opens no backend session. */
export const Route = createFileRoute("/replay")({ component: ReplayRoute });
