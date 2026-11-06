import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { IPC } from '../shared/api'

const dirty = new WeakMap<WebContents, boolean>()

export function registerCloseGuardIpc(): void {
  ipcMain.on(IPC.setDirty, (event, value: unknown) => {
    dirty.set(event.sender, value === true)
  })
}

/** Asks before closing a window whose open request has unsaved edits. */
export function guardClose(win: BrowserWindow): void {
  win.on('close', (event) => {
    if (!dirty.get(win.webContents)) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Unsaved changes',
      message: 'You have unsaved changes in the open request.',
      detail: 'Closing now will discard them.',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (choice !== 0) event.preventDefault()
  })
}
