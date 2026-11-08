// Pure helpers for registering the DeadLetter MCP server with other tools. No Electron, no I/O,
// so the config edits can be unit tested. Formats were checked against each tool's docs:
//  - Claude Code: `claude mcp add --transport http --scope user <name> <url> --header "Name: value"`
//  - Cursor: ~/.cursor/mcp.json -> { mcpServers: { name: { url, headers } } }
//  - VS Code: <user profile>/mcp.json -> { servers: { name: { type: "http", url, headers } } }

import { join } from 'node:path'

export const SERVER_NAME = 'deadletter'

export type JsonClientId = 'cursor' | 'vscode'
export type ClientId = 'claude-code' | JsonClientId

export interface Endpoint {
  url: string
  token: string
}

export type Edit = { ok: true; text: string } | { ok: false; reason: string }

/** Where each JSON-configured tool keeps its user-level MCP file. */
export function configPath(id: JsonClientId, platform: NodeJS.Platform, home: string, appData: string | undefined): string {
  if (id === 'cursor') return join(home, '.cursor', 'mcp.json')
  if (platform === 'win32') return join(appData ?? join(home, 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
  return join(process.env['XDG_CONFIG_HOME'] || join(home, '.config'), 'Code', 'User', 'mcp.json')
}

/** `claude mcp` arguments. User scope, because the app has no meaningful project directory. */
export function claudeAddArgs(ep: Endpoint): string[] {
  return ['mcp', 'add', '--transport', 'http', '--scope', 'user', SERVER_NAME, ep.url, '--header', `Authorization: Bearer ${ep.token}`]
}
export const claudeRemoveArgs = ['mcp', 'remove', '--scope', 'user', SERVER_NAME]
export const claudeGetArgs = ['mcp', 'get', SERVER_NAME]

const KEY: Record<JsonClientId, 'mcpServers' | 'servers'> = { cursor: 'mcpServers', vscode: 'servers' }

function entryFor(id: JsonClientId, ep: Endpoint): Record<string, unknown> {
  const headers = { Authorization: `Bearer ${ep.token}` }
  return id === 'vscode' ? { type: 'http', url: ep.url, headers } : { url: ep.url, headers }
}

type Parsed = { ok: true; root: Record<string, unknown> } | { ok: false; reason: string }

/** Strict JSON only: rewriting a file with comments would silently delete them, so those are refused. */
function parse(text: string | null): Parsed {
  if (text === null || text.trim() === '') return { ok: true, root: {} }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'The file is not plain JSON (comments or trailing commas?). Add the server by hand instead.' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'The file does not contain a JSON object.' }
  }
  return { ok: true, root: value as Record<string, unknown> }
}

function servers(root: Record<string, unknown>, key: string): Record<string, unknown> | string {
  const current = root[key]
  if (current === undefined) return {}
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return `"${key}" in the file is not an object.`
  return current as Record<string, unknown>
}

const render = (root: Record<string, unknown>): string => JSON.stringify(root, null, 2) + '\n'

/** Adds or replaces the DeadLetter entry, leaving every other server and setting untouched. */
export function addServer(text: string | null, id: JsonClientId, ep: Endpoint): Edit {
  const parsed = parse(text)
  if (!parsed.ok) return parsed
  const key = KEY[id]
  const existing = servers(parsed.root, key)
  if (typeof existing === 'string') return { ok: false, reason: existing }
  return { ok: true, text: render({ ...parsed.root, [key]: { ...existing, [SERVER_NAME]: entryFor(id, ep) } }) }
}

export function removeServer(text: string | null, id: JsonClientId): Edit {
  const parsed = parse(text)
  if (!parsed.ok) return parsed
  const key = KEY[id]
  const existing = servers(parsed.root, key)
  if (typeof existing === 'string') return { ok: false, reason: existing }
  const { [SERVER_NAME]: _gone, ...rest } = existing
  return { ok: true, text: render({ ...parsed.root, [key]: rest }) }
}

export function hasServer(text: string | null, id: JsonClientId): boolean {
  const parsed = parse(text)
  if (!parsed.ok) return false
  const existing = servers(parsed.root, KEY[id])
  return typeof existing !== 'string' && SERVER_NAME in existing
}
