import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  createFolder,
  createRequest,
  deleteEntry,
  listCollection,
  readRequest,
  renameEntry,
  unwatchCollection,
  watchCollection,
  writeRequest
} from '@deadletter/engine'
import { IPC, type RequestFile, type Settings } from '../shared/api'
import { getSettings, updateSettings, workspaceRoot } from './settings'

function root(): string {
  const r = workspaceRoot()
  if (!r) throw new Error('No workspace folder selected')
  return r
}

function startWatching(): void {
  unwatchCollection()
  const r = workspaceRoot()
  if (!r) return
  try {
    watchCollection(r, () => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.collectionChanged)
    })
  } catch (e) {
    console.error('Could not watch workspace:', e)
  }
}

async function chooseWorkspace(event: Electron.IpcMainInvokeEvent): Promise<Settings> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const options: Electron.OpenDialogOptions = {
    title: 'Choose workspace folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: getSettings().workspacePath ?? undefined
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return getSettings()
  const settings = updateSettings({ workspacePath: result.filePaths[0], activeEnvironment: null })
  startWatching()
  return settings
}

export function registerCollectionIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => getSettings())
  ipcMain.handle(IPC.settingsUpdate, (_e, patch: Partial<Settings>) => {
    // The workspace can only be changed through the native folder picker.
    const { preferredFormat, activeEnvironment } = patch
    return updateSettings({
      ...(preferredFormat ? { preferredFormat } : {}),
      ...(activeEnvironment !== undefined ? { activeEnvironment } : {})
    })
  })
  ipcMain.handle(IPC.settingsChooseWorkspace, (e) => chooseWorkspace(e))

  ipcMain.handle(IPC.collectionList, () => {
    const r = workspaceRoot()
    return r ? listCollection(r) : []
  })
  ipcMain.handle(IPC.collectionRead, (_e, path: string) => readRequest(root(), path))
  ipcMain.handle(IPC.collectionWrite, (_e, path: string, req: RequestFile) => writeRequest(root(), path, req))
  ipcMain.handle(IPC.collectionCreateRequest, (_e, dir: string, name: string) =>
    createRequest(root(), dir, name, getSettings().preferredFormat)
  )
  ipcMain.handle(IPC.collectionCreateFolder, (_e, dir: string, name: string) => createFolder(root(), dir, name))
  ipcMain.handle(IPC.collectionRename, (_e, path: string, name: string) => renameEntry(root(), path, name))
  ipcMain.handle(IPC.collectionRemove, (_e, path: string) => deleteEntry(root(), path))

  startWatching()
}
