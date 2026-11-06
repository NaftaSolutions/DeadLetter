import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { registerCollectionIpc } from './collection'
import { registerEngineIpc } from './engine'
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

app.whenReady().then(() => {
  registerEngineIpc()
  registerCollectionIpc()
  registerCloseGuardIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})