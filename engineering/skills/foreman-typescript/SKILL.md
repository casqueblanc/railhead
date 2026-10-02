---
name: foreman-typescript
description: Implement, debug, or review Node and TypeScript code in Foreman with pnpm, strict types, boundary validation, and behavior tests. Use for JavaScript package tooling and TypeScript application or library changes.
license: MIT OR Apache-2.0
---

# Foreman Node and TypeScript

Inspect the workspace, `packageManager`, Node pin, scripts, TypeScript config, and
test runner. Use pnpm for installs, scripts, dependencies, and local tools. Keep
one workspace `pnpm-lock.yaml`; do not introduce npm, Yarn, or Bun lockfiles.

Root pnpm scripts are the normal entry point; Vite+ (`vp run`) orders and
caches the per-package tasks behind them. Vite+ pins the Oxlint and Oxfmt it
runs, configured in the root `vite.config.ts`; `pnpm lint:check` is the
non-mutating check and `pnpm lint:fix` applies fixes. Keep type checking, tests,
and builds in the required checks. Do not add Biome, ESLint or Prettier beside
them or silence lint defects.

Verify the latest stable package release and compatibility before adding or
upgrading a dependency. Pin tools and pnpm exactly, commit the lockfile, and use
`pnpm install --frozen-lockfile` in CI. Run declared tools with `pnpm exec`; pin
the version of a justified `pnpm dlx` tool. Preserve integrity checks. Document
any runtime, target, or compatibility constraint that prevents the newest release.

New TypeScript code should use strict checks, indexed-access checks, and exact
optional properties through its framework-compatible configuration. Treat external
data as `unknown` and validate it. Avoid `any`, unproved non-null assertions, and
double casts that conceal a real defect. Use discriminated unions for states and
errors, with explicit units and missing/stale values where needed.

Replace optional-field bags with variants, brand IDs and units that share a
primitive when mixing them is a real risk, and end union switches with a
`never` exhaustiveness check. Prefer
`satisfies` to `as`; a type guard must verify every property it claims. Derive types from the
owning schema or generated client. Strengthen a type only where the weaker one
forces an assertion, cast, or "cannot happen" throw.

Await promises or manage their completion and errors explicitly. Bound retries,
queues, and external work; define timeout, cancellation, cleanup, and partial
failure. Reconcile uncertain writes before retrying. Do not swallow errors or
create optimistic fallbacks. Keep authorization on the trusted side and secrets
out of logs.

Cover 3–4 distinct paths for changed nontrivial behavior and all applicable extra
branches. Test actual interfaces, including malformed input, boundaries, and
dependency failure. Use the existing runner and verify critical integration paths.

Run the declared lint, typecheck, test, and build commands for affected packages
and consumers. Do not invent script names or claim a build substitutes for tests.
For Worker code, read the official Cloudflare skills from root `AGENTS.md`.
List `@foreman/scripts/assert-workerd` in `setupFiles` and use real Miniflare
bindings. Public interfaces live in `@foreman/shared`; every RPC implementation
carries `@validateRpc()`, and every stub is disposed by its owner. Change a
Worker's `cloudflare.config.ts`, never its generated `wrangler.jsonc`.
