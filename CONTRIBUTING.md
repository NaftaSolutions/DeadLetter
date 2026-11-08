# Contributing to DeadLetter

Thanks for helping. Please open an issue before starting anything large so we can agree on the approach.

## Principles

These are not negotiable, because they are what the project is for:

- **Zero cloud, zero telemetry.** No remote sync, no forced logins, no analytics. Data stays on the local filesystem as human-readable files.
- **Consent first.** Any MCP or external agent integration must be opt-in and toggleable.
- **Stay light.** Keep the UI responsive; heavy work (large JSON, network, file watching) belongs in the Rust engine. Prefer native or small solutions over new dependencies.

## Setup

Prerequisites: Node 20+, pnpm, stable Rust (plus MSVC build tools on Windows).

```sh
pnpm install
pnpm dev            # builds the engine, then launches Electron with HMR
pnpm typecheck
pnpm test           # Rust unit tests and renderer logic tests
pnpm test:e2e       # drives the real app with Playwright
```

## Code guidelines

- Keep Electron IPC type-safe: new channels go through `apps/desktop/src/shared/api.ts`, the preload `contextBridge`, and typed handlers in `src/main`.
- Write modular, testable code and avoid very large files. Pure logic belongs in plain modules with unit tests; UI behaviour gets an e2e test.
- Rust code ships with unit tests next to it (`cargo test -p engine`).
- Anything an importer or format cannot represent is reported to the user, never silently dropped.

## Pull requests

- One focused change per PR, with tests.
- Run `pnpm typecheck`, `pnpm test` and `pnpm test:e2e` first; there is no hosted CI yet, so please paste the results in the PR.
- Commit messages: a short lowercase summary of the change.

By contributing you agree that your work is released under the project's [MIT license](LICENSE).
