import { ipcMain } from 'electron'
import { deleteEnvironment, listEnvironments, readEnvironment, writeEnvironment } from '@deadletter/engine'
import { IPC, type Environment } from '../shared/api'
import { getSettings, updateSettings, workspaceRoot } from './settings'

function root(): string {
  const r = workspaceRoot()
  if (!r) throw new Error('No workspace folder selected')
  return r
}

export function registerEnvironmentIpc(): void {
  ipcMain.handle(IPC.environmentList, () => {
    const r = workspaceRoot()
    return r ? listEnvironments(r) : []
  })
  ipcMain.handle(IPC.environmentRead, (_e, name: string) => readEnvironment(root(), name))
  ipcMain.handle(IPC.environmentWrite, (_e, env: Environment) => writeEnvironment(root(), env))
  ipcMain.handle(IPC.environmentDelete, (_e, name: string) => {
    deleteEnvironment(root(), name)
    if (getSettings().activeEnvironment === name) updateSettings({ activeEnvironment: null })
  })
}
