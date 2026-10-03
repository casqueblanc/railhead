import { Banner, Button } from "@cloudflare/kumo";
import {
  FastForwardIcon,
  FilmStripIcon,
  FlaskIcon,
  PauseIcon,
  PlayIcon,
  RewindIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { BoardFeed } from "../claims/boardFeed";
import { ClaimLanes } from "../claims/ClaimLanes";
import type { DecisionActions } from "../decisions/decisionActions";
import { DecisionsPanel } from "../decisions/DecisionsPanel";
import { TrainOutcomes } from "../train/TrainOutcomes";
import type { CaptureSource } from "./captureFile";
import { firstFrame, frameAt, lastFrame, type Replay, type ReplayFrame } from "./replayLog";

/** Time between events while playing, in milliseconds. */
export const PLAYBACK_STEP_MS = 400;

/** A replay never records anything: the questions queue shows every answer as blocked. */
const NO_ANSWERS: DecisionActions = { kind: "unavailable", reason: "offline" };

/** The frames of a replay are complete folds, so a section never offers to reconnect. */
const noRetry = () => {};

interface ReplayBoardProps {
  replay: Replay;
  /** Closes this replay so another file can be opened. */
  onClose: () => void;
}

/**
 * One opened replay: its label, the playback controls and the board sections at the current
 * frame. It opens at the final board, which is the board the live log reached at the capture's head.
 */
export const ReplayBoard = ({ replay, onClose }: ReplayBoardProps) => {
  const [frame, setFrame] = useState<ReplayFrame>(() => lastFrame(replay));
  const [playRequested, setPlaying] = useState(false);
  const { head, events } = replay.capture;
  const atEnd = frame.position === head;
  // Playback stops by itself at the final board.
  const playing = playRequested && !atEnd;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setFrame((current) => frameAt(replay, current, current.position + 1));
    }, PLAYBACK_STEP_MS);
    return () => clearInterval(timer);
  }, [playing, replay]);

  const moveTo = (position: number) => {
    setPlaying(false);
    setFrame((current) => frameAt(replay, current, position));
  };
  const play = () => {
    if (atEnd) setFrame(firstFrame(replay));
    setPlaying(true);
  };

  const current = events[frame.position - 1];
  const feed: BoardFeed = {
    kind: "board",
    board: frame.board,
    connection: "live",
    recovered: false,
  };

  return (
    <div className="grid gap-6">
      <SourceLabel source={replay.capture.source} head={head} onClose={onClose} />
      <section aria-label="Playback" className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            icon={<SkipBackIcon aria-hidden="true" />}
            disabled={frame.position === 0}
            onClick={() => moveTo(0)}
          >
            Start
          </Button>
          <Button
            size="sm"
            icon={<RewindIcon aria-hidden="true" />}
            disabled={frame.position === 0}
            onClick={() => moveTo(frame.position - 1)}
          >
            Back one event
          </Button>
          {playing ? (
            <Button
              size="sm"
              variant="primary"
              icon={<PauseIcon aria-hidden="true" />}
              onClick={() => setPlaying(false)}
            >
              Pause
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              icon={<PlayIcon aria-hidden="true" />}
              onClick={play}
            >
              {atEnd ? "Play from start" : "Play"}
            </Button>
          )}
          <Button
            size="sm"
            icon={<FastForwardIcon aria-hidden="true" />}
            disabled={atEnd}
            onClick={() => moveTo(frame.position + 1)}
          >
            Forward one event
          </Button>
          <Button
            size="sm"
            icon={<SkipForwardIcon aria-hidden="true" />}
            disabled={atEnd}
            onClick={() => moveTo(head)}
          >
            Final board
          </Button>
        </div>
        <label className="grid gap-1">
          <span className="text-sm text-kumo-subtle">
            Event <span className="tabular-nums">{frame.position}</span> of{" "}
            <span className="tabular-nums">{head}</span>
            {current === undefined ? "" : ` · ${current.type} · ${formatTime(current.at)}`}
          </span>
          <input
            type="range"
            min={0}
            max={head}
            step={1}
            value={frame.position}
            aria-label="Replay position"
            aria-valuetext={`Event ${frame.position} of ${head}`}
            onChange={(event) => moveTo(Number(event.currentTarget.value))}
            className="w-full"
          />
        </label>
      </section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <div className="grid min-w-0 gap-6">
          <section aria-label="Questions">
            <DecisionsPanel state={frame.board} actions={NO_ANSWERS} />
          </section>
          <ClaimLanes feed={feed} onRetry={noRetry} />
        </div>
        <div className="grid min-w-0 gap-6">
          <TrainOutcomes feed={feed} onRetry={noRetry} />
        </div>
      </div>
    </div>
  );
};

interface SourceLabelProps {
  source: CaptureSource;
  head: number;
  onClose: () => void;
}

/**
 * Says, before anything else on the page, that this is a replay and where its file says the log
 * came from. A capture carries no signature, so anyone can edit a file to read `captured`: the
 * label repeats the file's claim and never calls it verified.
 */
const SourceLabel = ({ source, head, onClose }: SourceLabelProps) => {
  const close = (
    <Button size="sm" onClick={onClose}>
      Open another file
    </Button>
  );
  switch (source.kind) {
    case "captured":
      return (
        <Banner
          icon={<FilmStripIcon weight="fill" aria-hidden="true" />}
          title="Replay of a file that claims to be a captured log. This board is not live."
          description={`The file says it was captured from ${source.origin}, repository ${source.org}/${source.name}, at ${formatTime(source.capturedAt)}, with head at event ${head}. The board cannot verify where a file came from, so confirm how you got it before treating it as a real run. Answering and owner actions are off, and nothing is sent to the backend.`}
          action={close}
        />
      );
    case "synthetic":
      return (
        <Banner
          variant="alert"
          icon={<FlaskIcon weight="fill" aria-hidden="true" />}
          title="Synthetic replay. Not a captured run."
          description={`${source.description}. Built from hand-written development fixtures: no agent did this work. ${head} events.`}
          action={close}
        />
      );
    default:
      return unreachable(source);
  }
};

/** An event time, in UTC so every viewer of a replay reads the same clock. */
const formatTime = (at: number): string =>
  `${new Date(at).toISOString().slice(0, 19).replace("T", " ")} UTC`;

const unreachable = (value: never): never => {
  throw new Error(`unhandled replay source: ${JSON.stringify(value)}`);
};
