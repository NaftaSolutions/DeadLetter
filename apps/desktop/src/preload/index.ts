import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DeadLetterApi } from '../shared/api'

const api: DeadLetterApi = {
  ping: () => ipcRenderer.invoke(IPC.ping),
  executeRequest: (req) => ipcRenderer.invoke(IPC.executeRequest, req),
  formatJson: (text) => ipcRenderer.invoke(IPC.formatJson, text),
  setDirty: (dirty) => ipcRenderer.send(IPC.setDirty, dirty),
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    chooseWorkspace: () => ipcRenderer.invoke(IPC.settingsChooseWorkspace)
  },
  environments: {
    list: () => ipcRenderer.invoke(IPC.environmentList),
    read: (name) => ipcRenderer.invoke(IPC.environmentRead, name),
    write: (environment) => ipcRenderer.invoke(IPC.environmentWrite, environment),
    delete: (name) => ipcRenderer.invoke(IPC.environmentDelete, name)
  },
  collection: {
    list: () => ipcRenderer.invoke(IPC.collectionList),
    read: (path) => ipcRenderer.invoke(IPC.collectionRead, path),
    write: (path, request) => ipcRenderer.invoke(IPC.collectionWrite, path, request),
    createRequest: (dir, name) => ipcRenderer.invoke(IPC.collectionCreateRequest, dir, name),
    createFolder: (dir, name) => ipcRenderer.invoke(IPC.collectionCreateFolder, dir, name),
    rename: (path, newName) => ipcRenderer.invoke(IPC.collectionRename, path, newName),
    remove: (path) => ipcRenderer.invoke(IPC.collectionRemove, path),
    onChanged: (listener) => {
      const handler = (): void => listener()
      ipcRenderer.on(IPC.collectionChanged, handler)
      return () => ipcRenderer.removeListener(IPC.collectionChanged, handler)
    }
  }
}

contextBridge.exposeInMainWorld('deadletter', api)
