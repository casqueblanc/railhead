# Railhead frontend

This package is the board: a single-page application that runs entirely client-side and talks to the backend over one Cap'n Web WebSocket session. It uses React, TanStack Router, Tailwind and Kumo. Follow the repository-wide guidance in `../../AGENTS.md` and load the `railhead-frontend-conventions` skill before creating, moving or reviewing code here. The structure below is adapted from Cloudflare OS's `packages/workshop-frontend/AGENTS.md` at `1045d2e`.

## Architecture

Organize code by product ownership first and implementation type second.

```text
src/
  routes/       TanStack route declarations and route-level wiring
  pages/        Substantial route-level screens that compose one or more features
  features/     Product features and their owned UI, hooks, and logic
  components/   UI and application primitives shared across unrelated features
  hooks/        Hooks shared across unrelated features
  rpc/          The backend session: how it is opened, observed and disposed
  utils/        Feature-independent utilities
```

Create a directory when its first file needs it; `features/`, `components/`, `hooks/` and `utils/` do not exist yet.

- A feature directory owns product behavior: its components, hooks, tests and utilities. Start it flat. Do not add `components/`, `hooks/`, `helpers/` or `tests/` subdirectories merely to classify files; introduce a subdirectory named after its responsibility when a coherent subsystem has several files.
- Files under `src/routes/` define routes and stay focused on route concerns: parameters, search validation, loaders, navigation and composing the route's page. A small page may remain in its route file. A substantial one moves to `src/pages/<page>/`, named with a `Page.tsx` suffix, which also keeps its support code out of the router's file scanning.
- `src/components/` and `src/hooks/` are shared application infrastructure, not default destinations. Code begins under the feature or page that owns it and moves only as high as its ownership requires. Reuse alone does not make code generic.
- Use PascalCase filenames for components and camelCase filenames for hooks and other modules. Colocate `*.test.ts(x)` with its subject. Prefer direct imports; do not add a barrel file to shorten paths.
- Do not edit `src/routeTree.gen.ts`; the router plugin generates it.

## Kumo and styling

Import controls from `@cloudflare/kumo` and icons from `@phosphor-icons/react`. Use Kumo's semantic classes such as `bg-kumo-base`, `text-kumo-subtle` and `border-kumo-line`, and Tailwind for layout, spacing, sizing, positioning and responsive behavior. Do not add colour literals, arbitrary Tailwind colours, new token families or wrappers that only restyle Kumo.

Application-level theming is one decision made in the `@theme` block of `src/styles.css`. Do not introduce or change it as part of ordinary feature work.

Every view that depends on the backend has its loading, empty, blocked, stale, failed and recovered states where they apply, each with an accessible name and a next step.

## RPC

The session is opened in `src/rpc/`. The client always connects to its own origin; in development the Vite server proxies `/api` to the backend. Dispose a stub in the cleanup of the Effect that obtained it, never keep a stub directly in `useState`, and guard state updates so a replaced session cannot overwrite the current one.

## Commands

From the repository root:

```bash
pnpm --filter @railhead/frontend test:run
vp run -F @railhead/frontend build
pnpm dev-server   # the built board and the API on http://localhost:8787
pnpm dev-client   # Vite with hot reload on http://localhost:3000
```

Run `pnpm check` from the repository root before handing off.
