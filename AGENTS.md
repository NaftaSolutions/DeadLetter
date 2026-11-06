# Project Constitution: DeadLetter - Local-First Open Source API Client

## Philosophy & Core Rules
- **Zero Cloud / Zero Telemetry:** No remote sync, no forced logins. All data lives on the local filesystem as human-readable files.
- **Privacy & Consent First:** Any MCP or external agent integration MUST be strictly opt-in and toggleable.
- **Performance:** Keep the UI responsive. Offload heavy computation (large JSON parsing/diffs) to Rust/WASM, and network execution/MCP daemons to the native Rust layer via napi-rs.

## Architecture
- **Desktop Shell:** Electron (via electron-vite).
- **UI:** React + Tailwind CSS + Lucide Icons + Monaco Editor.
- **Engine (Rust):**
  - Node-API (`napi-rs`) for native networking, local file watching, and embedded MCP server.
  - Rust WASM (`wasm-pack`) for fast client-side payload parsing/formatting.
- **Data Model:** Git-friendly flat files (collections stored locally as `.json` or `.http`).

## Development Rules for the Agent
- Do not introduce bloat libraries when native or lightweight alternatives exist.
- Keep Electron IPC type-safe using standard `contextBridge` and TypeScript definitions.
- Write modular, testable code. Avoid 500-line monolithic files.

## Commits
Commit per major tasks - do not bloat commit history nor make pointless commits (without asking)