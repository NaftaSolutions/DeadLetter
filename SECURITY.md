# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting (the **Security** tab of the repository, then **Report a vulnerability**) and include steps to reproduce.

You can expect an acknowledgement within a few days. Fixes are released as soon as they are ready, and reporters are credited unless they prefer otherwise.

## What matters most here

DeadLetter stores data locally and has no hosted backend. Its optional MCP server runs on the user's machine. The main security concerns are:

- **Secrets:** environment secrets must never end up in files that get committed (`<name>.secrets.json` is kept out of git by a generated `.gitignore`).
- **Workspace boundaries:** operations on collection files must not escape the chosen workspace folder.
- **Untrusted imports:** collections, HAR files and `.http` files from other people are parsed by the engine; malformed input must fail safely.
- **Agent integrations:** the MCP server is opt-in and off by default. When enabled, it binds to `127.0.0.1`, requires a bearer token and rejects browser-origin requests. The token is stored in the app's user-data folder, outside the workspace. Sending requests requires approval by default; users can also choose read-only or always-allow mode. Calls appear in the app's activity log. Environment listings omit secret values. Response redaction replaces exact matches of secret values at least three bytes long; shorter values and encoded or transformed copies are not covered. Bypasses of authentication, approval, workspace boundaries or secret redaction are security issues.
