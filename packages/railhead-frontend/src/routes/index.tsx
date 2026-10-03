import { createFileRoute } from "@tanstack/react-router";
import { useLiveBoardPorts } from "../features/board/liveConnection";
import { DEFAULT_BOARD_REPO } from "../rpc/apiSession";
import { HomePage } from "../pages/home/HomePage";

const BoardRoute = () => <HomePage ports={useLiveBoardPorts(DEFAULT_BOARD_REPO)} />;

export const Route = createFileRoute("/")({ component: BoardRoute });
