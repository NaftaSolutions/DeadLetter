import { BrowserWindow, ipcMain } from 'electron'
import {
  closeStream,
  executeRequest,
  formatJson,
  openStream,
  ping,
  readEnvironment,
  sendStreamMessage
} from '@deadletter/engine'
import { IPC, type RequestPayload, type StreamEvent, type StreamKind } from '../shared/api'
import { getSettings, workspaceRoot } from './settings'

/** Enabled variables of the active environment, or none when it is unset or gone. */
export function activeVariables(): { name: string; value: string }[] {
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
  ipcMain.handle(IPC.streamOpen, (_event, id: number, kind: StreamKind, req: RequestPayload) =>
    openStream(id, kind, req, activeVariables(), (e: StreamEvent) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.streamEvent, e)
    })
  )
  ipcMain.handle(IPC.streamSend, (_event, id: number, text: string) => sendStreamMessage(id, text))
  ipcMain.handle(IPC.streamClose, (_event, id: number) => closeStream(id))
}
