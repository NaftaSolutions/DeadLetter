import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DeadLetterApi } from '../shared/api'

const api: DeadLetterApi = {
  ping: () => ipcRenderer.invoke(IPC.ping),
  executeRequest: (req) => ipcRenderer.invoke(IPC.executeRequest, req)
}

contextBridge.exposeInMainWorld('deadletter', api)