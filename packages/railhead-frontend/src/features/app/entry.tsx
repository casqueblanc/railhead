import type { BoardSlotProps, FeatureEntry } from "../board/boardPorts";
import { AppPanel } from "./AppPanel";
import { appLocation } from "./appRevision";

/**
 * The deployed demo app's origin, set when the board is built (`VITE_DEMO_APP_URL`). It names a
 * public app, never a credential.
 */
const location = appLocation(import.meta.env.VITE_DEMO_APP_URL, window.location.origin);

// Bound so the hook's effect sees one function for the page's lifetime.
const fetchRevision: typeof fetch = (input, init) => fetch(input, init);

const AppSlot = ({ feed }: BoardSlotProps) => (
  <AppPanel feed={feed} location={location} fetchRevision={fetchRevision} />
);

/** The board's slot for the demo app deployed from main, marked stale when main has moved on. */
export const appEntry: FeatureEntry<BoardSlotProps> = { kind: "available", Component: AppSlot };
