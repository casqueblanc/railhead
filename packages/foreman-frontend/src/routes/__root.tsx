import { Text } from "@cloudflare/kumo";
import { Outlet, createRootRoute } from "@tanstack/react-router";

const RootLayout = () => (
  <div className="flex min-h-dvh flex-col bg-kumo-base text-kumo-default">
    <header className="border-b border-kumo-line px-4 py-3">
      <Text variant="heading" as="h1">
        Foreman
      </Text>
    </header>
    <main className="flex flex-1 flex-col">
      <Outlet />
    </main>
  </div>
);

export const Route = createRootRoute({ component: RootLayout });
