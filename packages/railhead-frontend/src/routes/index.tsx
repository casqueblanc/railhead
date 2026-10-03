import { createFileRoute } from "@tanstack/react-router";
import { useLiveBoardPorts } from "../features/board/liveConnection";
import { HomePage } from "../pages/home/HomePage";

const BoardRoute = () => <HomePage ports={useLiveBoardPorts()} />;

export const Route = createFileRoute("/")({ component: BoardRoute });
