import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  closeStream,
  executeRequest,
  formatJson,
  openStream,
  ping,
  readEnvironment,
  runAssertions,
  sendStreamMessage
} from '@deadletter/engine'
import { IPC, type RequestPayload, type ResponsePayload, type StreamEvent, type StreamKind } from '../shared/api'
import { relative, isAbsolute } from 'node:path'
import { getSettings, workspaceRoot } from './settings'

/** `./sub/file` (forward slashes) for a file inside the workspace, so requests stay portable; otherwise the absolute path. */
function workspaceRelative(path: string): string {
  const root = workspaceRoot()
  if (!root) return path
  const rel = relative(root, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return path
  return `./${rel.replaceAll('\\', '/')}`
}

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
  ipcMain.handle(IPC.executeRequest, (_event, req: RequestPayload) => executeRequest(req, activeVariables(), workspaceRoot()))
  ipcMain.handle(IPC.streamOpen, (_event, id: number, kind: StreamKind, req: RequestPayload) =>
    openStream(id, kind, req, activeVariables(), (e: StreamEvent) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.streamEvent, e)
    })
  )
  ipcMain.handle(IPC.streamSend, (_event, id: number, text: string) => sendStreamMessage(id, text))
  ipcMain.handle(IPC.streamClose, (_event, id: number) => closeStream(id))
  ipcMain.handle(IPC.runAssertions, (_event, assertions: string[], response: ResponsePayload) =>
    runAssertions(assertions, response, activeVariables())
  )
  ipcMain.handle(IPC.pickFile, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { properties: ['openFile' as const] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const path = picked.canceled ? null : (picked.filePaths[0] ?? null)
    return path === null ? null : workspaceRelative(path)
  })
}
