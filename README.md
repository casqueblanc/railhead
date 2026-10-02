# Railhead

Railhead is a Git platform for many concurrent coding agents, built on Cloudflare Workers, Durable Objects and Artifacts. It is an entry for Cloudflare's "Build the Next GitHub" challenge.

The design is in [issue #1](https://github.com/casqueblanc/railhead/issues/1), including two reviews and the revised direction that follow the original brief.

## Status

The repository is a walking skeleton. It has the toolchain, a Worker that serves one RPC method (`ping`) over a Cap'n Web WebSocket session, and a board page that reports whether the backend answers. Claims, evidence, the merge train, decisions and the Artifacts integration are not built, and no deployment is set up.

## Run it

You need Node.js 24.21.0 (`.node-version`; Volta picks it up from `package.json`) and pnpm, which installs the pinned version named in `packageManager`.

```sh
pnpm install
pnpm dev-server
```

`pnpm dev-server` builds the board and serves it with the API on http://localhost:8787. For hot reload while working on the board, also run `pnpm dev-client` and open http://localhost:3000; it proxies `/api` to the dev server.

## Check it

```sh
pnpm check
```

This runs the engineering guidance checks, formatting and linting, the type checks and the board build, and every test. Backend tests run inside workerd.

| Command                                         | Purpose                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm lint`                                     | Format and lint, type checks, and the generated-config check                                                 |
| `pnpm lint:fix`                                 | Apply format and lint fixes                                                                                  |
| `pnpm build`                                    | Type-check every package and bundle the board                                                                |
| `pnpm test`                                     | Run every test                                                                                               |
| `pnpm configs:generate` / `pnpm types:generate` | Regenerate `wrangler.jsonc` and `worker-configuration.d.ts` after changing a Worker's `cloudflare.config.ts` |

## Layout

| Path                         | Contents                                                            |
| ---------------------------- | ------------------------------------------------------------------- |
| `packages/railhead-shared`   | The RPC interface shared by the board and the Worker                |
| `packages/railhead-backend`  | The Worker: the API and the built board's static assets             |
| `packages/railhead-frontend` | The board: React, TanStack Router, Tailwind and Kumo                |
| `scripts/`                   | Build tooling: Worker config generation and shared task definitions |
| `engineering/`               | Engineering guidance and skills for people and coding agents        |

The structure, tooling and UI conventions follow [Cloudflare OS](https://github.com/cloudflare/cloudflare-os/tree/1045d2e1ceac7be29e1a6f056c936fb31aa00851). [AGENTS.md](AGENTS.md) holds the rules for working in this repository and lists the deliberate differences.

## License

[Apache-2.0](LICENSE). [NOTICE](NOTICE) lists the adapted material.
