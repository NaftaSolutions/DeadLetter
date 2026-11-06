import { ipcMain } from 'electron'
import { ping } from '@deadletter/engine'
import { IPC } from '../shared/api'

export function registerEngineIpc(): void {
  ipcMain.handle(IPC.ping, () => ping())
}