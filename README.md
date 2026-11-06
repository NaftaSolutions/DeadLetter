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
