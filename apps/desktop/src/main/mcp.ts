import { app, BrowserWindow, ipcMain } from 'electron'
import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mcpAnswerApproval, mcpStart, mcpStop, mcpUpdate, type McpEvent } from '@deadletter/engine'
import { IPC, type McpActivity, type McpApproval, type McpStatus } from '../shared/api'
import { getSettings, onSettingsChanged, workspaceRoot } from './settings'

const DEFAULT_PORT = 39217
const MAX_ACTIVITY = 200

/** Everything about the MCP server that survives a restart. Lives in user-data, never in the workspace. */
interface Prefs {
  enabled: boolean
  port: number
  approval: McpApproval
  token: string
}

const prefsFile = (): string => join(app.getPath('userData'), 'mcp.json')
const newToken = (): string => randomBytes(32).toString('base64url')

function sanitize(raw: unknown): Prefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const port = typeof r.port === 'number' && Number.isInteger(r.port) && r.port >= 1024 && r.port <= 65535 ? r.port : DEFAULT_PORT
  const approval = r.approval === 'always' || r.approval === 'readonly' ? r.approval : 'ask'
  const token = typeof r.token === 'string' && r.token.length >= 32 ? r.token : newToken()
  return { enabled: r.enabled === true, port, approval, token }
}

let prefs: Prefs | null = null

function getPrefs(): Prefs {
  if (prefs) return prefs
  try {
    prefs = sanitize(JSON.parse(readFileSync(prefsFile(), 'utf8')))
  } catch {
    prefs = sanitize({})
  }
  return prefs
}

function savePrefs(next: Prefs): void {
  prefs = next
  const tmp = `${prefsFile()}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, prefsFile())
}

let running = false
let runningPort = 0
let lastError: string | null = null
const activity: McpActivity[] = []

const broadcast = (channel: string, payload: unknown): void => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function onEvent(e: McpEvent): void {
  if (e.kind === 'call') {
    const entry: McpActivity = {
      at: e.at,
      tool: e.tool ?? '?',
      detail: e.detail ?? '',
      outcome: e.outcome === 'ok' ? 'ok' : 'error',
      ms: Math.round(e.ms ?? 0)
    }
    activity.push(entry)
    if (activity.length > MAX_ACTIVITY) activity.shift()
    broadcast(IPC.mcpActivity, entry)
  } else if (e.kind === 'approval' && e.id !== undefined) {
    // An agent is waiting on a person: make sure the window is noticed.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isMinimized()) win.restore()
      win.flashFrame(true)
    }
    broadcast(IPC.mcpApproval, { id: e.id, tool: e.tool ?? '', detail: e.detail ?? '' })
  } else if (e.kind === 'approval-expired' && e.id !== undefined) {
    broadcast(IPC.mcpApprovalExpired, e.id)
  }
}

function options(p: Prefs, root: string): Parameters<typeof mcpStart>[0] {
  return { port: p.port, token: p.token, root, environment: getSettings().activeEnvironment ?? undefined, approval: p.approval }
}

/** Brings the running server in line with the prefs and the current workspace. */
function sync(): void {
  const p = getPrefs()
  const root = workspaceRoot()
  if (!p.enabled || !root) {
    if (running) {
      mcpStop()
      running = false
    }
    lastError = p.enabled ? 'Choose a workspace folder first.' : null
    return
  }
  try {
    if (running && runningPort === p.port) {
      mcpUpdate(options(p, root))
    } else {
      runningPort = mcpStart(options(p, root), onEvent)
      running = true
    }
    lastError = null
  } catch (e) {
    running = false
    lastError = e instanceof Error ? e.message : String(e)
  }
}

/** Token changes need a restart; `mcpStart` replaces the running server. */
function restart(): void {
  if (running) {
    mcpStop()
    running = false
  }
  sync()
}

function status(): McpStatus {
  const p = getPrefs()
  return {
    enabled: p.enabled,
    running,
    port: p.port,
    approval: p.approval,
    url: `http://127.0.0.1:${p.port}/mcp`,
    token: p.token,
    error: lastError,
    activity: [...activity]
  }
}

export function stopMcp(): void {
  if (running) mcpStop()
  running = false
}

export function registerMcpIpc(): void {
  // Starts only if the user turned it on in an earlier session; a fresh install never listens.
  if (getPrefs().enabled) sync()
  onSettingsChanged(() => {
    if (getPrefs().enabled) sync()
  })

  ipcMain.handle(IPC.mcpStatus, () => status())
  ipcMain.handle(IPC.mcpSetEnabled, (_e, enabled: boolean) => {
    savePrefs({ ...getPrefs(), enabled: enabled === true })
    sync()
    return status()
  })
  ipcMain.handle(IPC.mcpConfigure, (_e, patch: { port?: number; approval?: McpApproval }) => {
    if (patch.port !== undefined && !(Number.isInteger(patch.port) && patch.port >= 1024 && patch.port <= 65535)) {
      throw new Error('Port must be a whole number between 1024 and 65535.')
    }
    savePrefs(sanitize({ ...getPrefs(), ...patch }))
    sync()
    return status()
  })
  ipcMain.handle(IPC.mcpRegenerateToken, () => {
    savePrefs({ ...getPrefs(), token: newToken() })
    restart()
    return status()
  })
  ipcMain.handle(IPC.mcpAnswerApproval, (_e, id: number, allow: boolean, remember: boolean) =>
    mcpAnswerApproval(id, allow === true, remember === true)
  )
}
