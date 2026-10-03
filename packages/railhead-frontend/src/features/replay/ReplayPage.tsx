import { Banner, Button, Empty, Text } from "@cloudflare/kumo";
import { FilmStripIcon, FlaskIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useRef, useState, type ChangeEvent } from "react";
import { MAX_CAPTURE_BYTES, captureErrorText, type Capture } from "./captureFile";
import { ReplayBoard } from "./ReplayBoard";
import { openReplay, replayCapture, type Replay } from "./replayLog";

/** Loads the synthetic development replays. Production builds pass `null`. */
export type LoadSynthetic = () => Promise<readonly Capture[]>;

interface ReplayPageProps {
  loadSynthetic: LoadSynthetic | null;
}

type Opened =
  | { kind: "none" }
  | { kind: "reading" }
  | { kind: "refused"; message: string }
  /** `id` names this opening, so reopening the same log starts a fresh playback. */
  | { kind: "open"; replay: Replay; id: number };

/**
 * Replays a captured event log in this browser. The file is read locally and folded with the board's
 * own fold; the page opens no backend session, so it works with the network off.
 */
export const ReplayPage = ({ loadSynthetic }: ReplayPageProps) => {
  const [opened, setOpened] = useState<Opened>({ kind: "none" });
  // Only the latest file chosen may open: a slower read of an earlier one is dropped.
  const latest = useRef(0);

  const openFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (file === undefined) return;
    const attempt = ++latest.current;
    if (file.size > MAX_CAPTURE_BYTES) {
      setOpened({ kind: "refused", message: captureErrorText({ kind: "too_large" }) });
      return;
    }
    setOpened({ kind: "reading" });
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (attempt === latest.current) {
        setOpened({ kind: "refused", message: "The file could not be read." });
      }
      return;
    }
    if (attempt !== latest.current) return;
    const result = openReplay(text);
    setOpened(
      result.ok
        ? { kind: "open", replay: result.replay, id: attempt }
        : { kind: "refused", message: result.message },
    );
  };

  const openCapture = (capture: Capture) => {
    const attempt = ++latest.current;
    const result = replayCapture(capture);
    setOpened(
      result.ok
        ? { kind: "open", replay: result.replay, id: attempt }
        : { kind: "refused", message: result.message },
    );
  };

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-4 sm:px-6">
      <Text as="h2" variant="heading">
        Replay
      </Text>
      {opened.kind === "open" ? (
        <ReplayBoard
          key={opened.id}
          replay={opened.replay}
          onClose={() => setOpened({ kind: "none" })}
        />
      ) : (
        <div className="grid gap-4">
          {opened.kind === "refused" && (
            <div role="alert">
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" aria-hidden="true" />}
                title="This file cannot be replayed"
                description={opened.message}
              />
            </div>
          )}
          <Empty
            icon={<FilmStripIcon size={48} aria-hidden="true" />}
            title="Open a captured log"
            description="Choose a capture file written by scripts/capture-replay.mjs. It is read in this browser and nothing is sent to the backend."
            contents={
              <label className="grid gap-1 text-sm">
                <span>Capture file</span>
                <input
                  type="file"
                  accept="application/json,.json"
                  disabled={opened.kind === "reading"}
                  onChange={(event) => void openFile(event)}
                />
              </label>
            }
          />
          {loadSynthetic !== null && <SyntheticReplays load={loadSynthetic} onOpen={openCapture} />}
        </div>
      )}
    </div>
  );
};

interface SyntheticReplaysProps {
  load: LoadSynthetic;
  onOpen: (capture: Capture) => void;
}

/** Development only: the hand-written fixture logs, labelled synthetic wherever they appear. */
const SyntheticReplays = ({ load, onOpen }: SyntheticReplaysProps) => {
  const [captures, setCaptures] = useState<readonly Capture[] | "failed" | null>(null);
  const show = () => {
    load().then(setCaptures, () => setCaptures("failed"));
  };
  return (
    <section aria-label="Synthetic logs" className="grid gap-2">
      <Text as="h3" variant="heading">
        Synthetic logs (development)
      </Text>
      {captures === null && (
        <div>
          <Button size="sm" icon={<FlaskIcon aria-hidden="true" />} onClick={show}>
            Show synthetic logs
          </Button>
        </div>
      )}
      {captures === "failed" && <Text>The synthetic logs did not load.</Text>}
      {Array.isArray(captures) && (
        <ul className="flex flex-wrap gap-2">
          {captures.map((capture) => (
            <li
              key={capture.source.kind === "synthetic" ? capture.source.description : capture.repo}
            >
              <Button
                size="sm"
                icon={<FlaskIcon aria-hidden="true" />}
                onClick={() => onOpen(capture)}
              >
                {capture.source.kind === "synthetic" ? capture.source.description : capture.repo}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
