# DeadLetter
## Development

Prerequisites: Node 20+, pnpm, Rust (stable) + MSVC build tools on Windows.

```sh
pnpm install
pnpm dev          # builds crates/engine (.node), then launches Electron with HMR
pnpm build        # production build of engine + desktop
pnpm typecheck
```

Layout: `apps/desktop` (Electron main/preload/renderer) and `crates/engine` (napi-rs native bindings).

## Collections

Requests live as plain files in a workspace folder you pick (Settings, or the sidebar). Two formats are supported side by side, and Settings chooses which one new requests use:

- `.http` (default), one request per file: `### name`, request line, headers, blank line, body. Disabled headers are written as `# Name: value` comments.
- `.json`: `{ "name", "method", "url", "headers": [{ "name", "value", "enabled" }], "body" }`.

## Environments

Pick an environment in the header, then use `{{variable}}` in a request's URL, headers or body. Environments live in `.deadletter/environments/<name>.json` inside the workspace, so they travel with git. Variables marked secret keep their values in `<name>.secrets.json` next to it; a generated `.gitignore` there keeps that file out of commits. Sending a request that uses an undefined variable fails with a message naming it.

## Response viewer

Bodies open in a read-only Monaco editor (syntax highlighting, folding, Ctrl+F search) with Pretty/Raw, Wrap and Copy. JSON is pretty-printed by the Rust engine on a worker thread, keeping key order and big numbers intact. The Cookies tab lists every `Set-Cookie` header; Headers shows them all, duplicates included. Monaco loads on first use and runs fully offline.

## Tests

```sh
pnpm test        # Rust unit tests (file formats, storage, path safety)
pnpm test:e2e    # builds, then drives the real Electron app with Playwright (apps/desktop/e2e)
```

The e2e suite uses temp workspaces and a local HTTP server, needs no browser download, and writes screenshots to `apps/desktop/test-results/` (git-ignored).
