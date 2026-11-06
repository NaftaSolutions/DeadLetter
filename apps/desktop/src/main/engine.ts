import { ipcMain } from 'electron'
import { executeRequest, ping } from '@deadletter/engine'
import { IPC } from '../shared/api'

export function registerEngineIpc(): void {
  ipcMain.handle(IPC.ping, () => ping())
  ipcMain.handle(IPC.executeRequest, (_event, req) => executeRequest(req))
}