import { statSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import {
  createRequest,
  exportPostman,
  listEnvironments,
  parseCurl,
  parseImport,
  requestToCurl,
  writeEnvironment,
  writeImport,
  writeRequest
} from '@deadletter/engine'
import { IPC, type ImportOutcome, type RequestFile } from '../shared/api'
import { activeVariables } from './engine'
import { getSettings, workspaceRoot } from './settings'

const MAX_IMPORT_BYTES = 25 * 1024 * 1024

function root(): string {
  const r = workspaceRoot()
  if (!r) throw new Error('No workspace folder selected')
  return r
}

/** Compares like the engine's file names do, so two names never share one environment file. */
const fileKey = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '')

function uniqueEnvironmentName(wanted: string, existing: string[]): string {
  const taken = new Set(existing.map(fileKey))
  const base = wanted.trim() || 'Imported'
  let name = base
  for (let n = 2; taken.has(fileKey(name)); n++) name = `${base} ${n}`
  return name
}

async function importFile(event: Electron.IpcMainInvokeEvent): Promise<ImportOutcome | null> {
  const r = root()
  const win = BrowserWindow.fromWebContents(event.sender)
  const options: Electron.OpenDialogOptions = {
    title: 'Import collection',
    properties: ['openFile'],
    filters: [
      { name: 'Collections and specs', extensions: ['json', 'yaml', 'yml', 'har', 'http', 'rest'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const file = picked.filePaths[0]
  if (picked.canceled || !file) return null

  if (statSync(file).size > MAX_IMPORT_BYTES) throw new Error('That file is too large to import (limit 25 MB)')
  const parsed = parseImport(readFileSync(file, 'utf8'))
  const summary = writeImport(r, '', parsed, getSettings().preferredFormat)

  // Collection variables become one environment, the source's own environments are kept as they are.
  const environments: string[] = []
  const toSave = [
    ...(parsed.variables.length > 0 ? [{ name: parsed.name, variables: parsed.variables }] : []),
    ...parsed.environments
  ]
  for (const env of toSave) {
    const name = uniqueEnvironmentName(env.name, [...listEnvironments(r), ...environments])
    writeEnvironment(r, { name, variables: env.variables })
    environments.push(name)
  }
  return {
    source: parsed.source,
    name: parsed.name,
    folder: summary.folder,
    written: summary.written,
    environments,
    warnings: parsed.warnings
  }
}

async function exportCollection(event: Electron.IpcMainInvokeEvent): Promise<string | null> {
  const r = root()
  const win = BrowserWindow.fromWebContents(event.sender)
  const options: Electron.SaveDialogOptions = {
    title: 'Export as Postman collection',
    defaultPath: join(app.getPath('documents'), `${basename(r)}.postman_collection.json`),
    filters: [{ name: 'Postman collection', extensions: ['json'] }]
  }
  const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return null
  writeFileSync(picked.filePath, exportPostman(r))
  return picked.filePath
}

export function registerInteropIpc(): void {
  ipcMain.handle(IPC.interopImportFile, (e) => importFile(e))
  ipcMain.handle(IPC.interopImportCurl, (_e, command: string) => {
    const r = root()
    const req = parseCurl(command)
    const path = createRequest(r, '', req.name || 'request', getSettings().preferredFormat)
    writeRequest(r, path, req)
    return path
  })
  ipcMain.handle(IPC.interopCopyCurl, (_e, request: RequestFile) => {
    const text = requestToCurl(request, activeVariables())
    clipboard.writeText(text)
    return text
  })
  ipcMain.handle(IPC.interopExportPostman, (e) => exportCollection(e))
}
