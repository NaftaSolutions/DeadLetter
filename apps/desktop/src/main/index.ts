import { join } from 'node:path'
import { app, BrowserWindow, Menu } from 'electron'
import { registerCollectionIpc } from './collection'
import { registerEngineIpc } from './engine'
import { registerEnvironmentIpc } from './environments'
import { registerInteropIpc } from './interop'
import { registerMcpIpc, stopMcp } from './mcp'
import { registerMcpInstallIpc } from './mcpInstall'
import { guardClose, registerCloseGuardIpc } from './closeGuard'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: '#0a0a0b',
    show: false,
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  guardClose(win)
  win.once('ready-to-show', () => win.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Packaged builds get no Electron default menu (Reload, DevTools, ...). macOS keeps a
// minimal one, since its app/edit roles provide Quit and the copy/paste shortcuts.
function setupMenu(): void {
  if (!app.isPackaged) return
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]))
  } else {
    Menu.setApplicationMenu(null)
  }
}

app.whenReady().then(() => {
  setupMenu()
  registerEngineIpc()
  registerCollectionIpc()
  registerEnvironmentIpc()
  registerInteropIpc()
  registerCloseGuardIpc()
  registerMcpIpc()
  registerMcpInstallIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', stopMcp)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})