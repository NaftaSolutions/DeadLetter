import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { IPC, type McpClientId, type McpClientInfo, type McpInstallResult } from '../shared/api'
import { connection } from './mcp'
import {
  addServer,
  claudeAddArgs,
  claudeGetArgs,
  claudeRemoveArgs,
  configPath,
  hasServer,
  removeServer,
  SERVER_NAME,
  type Edit,
  type Endpoint,
  type JsonClientId
} from './mcpClients'

const NAMES: Record<McpClientId, string> = { 'claude-code': 'Claude Code', cursor: 'Cursor', vscode: 'VS Code' }
const IDS = Object.keys(NAMES) as McpClientId[]

const home = (): string => homedir()
const path = (id: JsonClientId): string => configPath(id, process.platform, home(), process.env['APPDATA'])

/** Runs the `claude` CLI without a shell, so nothing in the arguments can be interpreted by one. */
function claude(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('claude', args, { cwd: home(), timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}${stderr}`.trim() || (error ? error.message : '') })
    })
  })
}

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Atomic, owner-only: the file holds the token. */
function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.deadletter.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

async function describe(id: McpClientId, ep: Endpoint): Promise<McpClientInfo> {
  if (id === 'claude-code') {
    const found = await claude(['--version'])
    const installed = found.ok && (await claude(claudeGetArgs)).ok
    return {
      id,
      name: NAMES[id],
      detected: found.ok,
      installed,
      preview: `claude mcp add --transport http --scope user ${SERVER_NAME} ${ep.url} --header "Authorization: Bearer …"`
    }
  }
  const file = path(id)
  // The tool counts as present when its own folder exists; we never create someone else's config directory.
  const detected = existsSync(id === 'cursor' ? dirname(file) : dirname(dirname(file)) /* …/Code */)
  return { id, name: NAMES[id], detected, installed: hasServer(read(file), id), preview: `Adds "${SERVER_NAME}" to ${file}` }
}

async function install(id: McpClientId, ep: Endpoint): Promise<McpInstallResult> {
  if (id === 'claude-code') {
    await claude(claudeRemoveArgs) // `add` fails when the name exists; this makes install double as update
    const added = await claude(claudeAddArgs(ep))
    return added.ok
      ? { id, ok: true, message: 'Added to Claude Code (user scope). Run /mcp in a session to check it.' }
      : { id, ok: false, message: `Claude Code could not add it: ${added.output}` }
  }
  return editFile(id, (text) => addServer(text, id, ep), 'Added.')
}

async function uninstall(id: McpClientId): Promise<McpInstallResult> {
  if (id === 'claude-code') {
    const removed = await claude(claudeRemoveArgs)
    return removed.ok ? { id, ok: true, message: 'Removed from Claude Code.' } : { id, ok: false, message: removed.output }
  }
  return editFile(id, (text) => removeServer(text, id), 'Removed.')
}

function editFile(id: JsonClientId, edit: (text: string | null) => Edit, done: string): McpInstallResult {
  const file = path(id)
  const result = edit(read(file))
  if (!result.ok) return { id, ok: false, message: `${file}: ${result.reason}` }
  try {
    write(file, result.text)
  } catch (e) {
    return { id, ok: false, message: `Could not write ${file}: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { id, ok: true, message: `${done} (${file})` }
}

function endpoint(): Endpoint {
  const c = connection()
  if (!c.enabled || !c.running) throw new Error('Enable the MCP server first.')
  return { url: c.url, token: c.token }
}

function known(id: unknown): McpClientId {
  if (!IDS.includes(id as McpClientId)) throw new Error('Unknown client.')
  return id as McpClientId
}

export function registerMcpInstallIpc(): void {
  ipcMain.handle(IPC.mcpClients, () => {
    const c = connection()
    return Promise.all(IDS.map((id) => describe(id, { url: c.url, token: c.token })))
  })
  ipcMain.handle(IPC.mcpInstallClient, (_e, id: unknown) => install(known(id), endpoint()))
  ipcMain.handle(IPC.mcpUninstallClient, (_e, id: unknown) => uninstall(known(id)))
}
