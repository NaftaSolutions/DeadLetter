# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting (the **Security** tab of the repository, then **Report a vulnerability**) and include steps to reproduce.

You can expect an acknowledgement within a few days. Fixes are released as soon as they are ready, and reporters are credited unless they prefer otherwise.

## What matters most here

DeadLetter runs locally and has no server component, so the interesting risks are:

- **Secrets:** environment secrets must never end up in files that get committed (`<name>.secrets.json` is kept out of git by a generated `.gitignore`).
- **Workspace boundaries:** operations on collection files must not escape the chosen workspace folder.
- **Untrusted imports:** collections, HAR files and `.http` files from other people are parsed by the engine; malformed input must fail safely.
- **Agent integrations:** the planned MCP server will be opt-in, off by default, and will only expose what the user enables.
