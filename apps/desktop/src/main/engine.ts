import { ipcMain } from 'electron'
import { executeRequest, formatJson, ping, readEnvironment } from '@deadletter/engine'
import { IPC, type RequestPayload } from '../shared/api'
import { getSettings, workspaceRoot } from './settings'

/** Enabled variables of the active environment, or none when it is unset or gone. */
function activeVariables(): { name: string; value: string }[] {
  const root = workspaceRoot()
  const name = getSettings().activeEnvironment
  if (!root || !name) return []
  try {
    return readEnvironment(root, name)
      .variables.filter((v) => v.enabled && v.name.trim())
      .map(({ name, value }) => ({ name: name.trim(), value }))
  } catch {
    return []
  }
}

export function registerEngineIpc(): void {
  ipcMain.handle(IPC.ping, () => ping())
  ipcMain.handle(IPC.formatJson, (_event, text: string) => formatJson(text))
  ipcMain.handle(IPC.executeRequest, (_event, req: RequestPayload) => executeRequest(req, activeVariables()))
}