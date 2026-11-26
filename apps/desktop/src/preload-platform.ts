/** Marks the main document with its host platform and Muse product identity. */

import { ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'

/**
 * Set platform and product styling markers on the shared document root.
 * The application preload may start before the document root exists.
 */
export function markDocumentPlatform(): void {
  const mark = (): void => {
    document.documentElement.dataset.platform = process.platform
    document.documentElement.dataset.dshProduct = 'muse'
  }
  // lib.dom types documentElement non-null, but a preload runs before the
  // document root exists.
  const root = document.documentElement as HTMLElement | null
  if (root === null) window.addEventListener('DOMContentLoaded', mark)
  else mark()
}

/**
 * Mirrors the window's macOS and Windows fullscreen state onto `<html data-fullscreen>` so
 * CSS drops the clearance for hidden native window controls. The main
 * process sends the state on every transition and after each load.
 */
export function syncWindowFullscreen(): void {
  // The main process sends this IPC only on macOS and Windows; other platforms need no listener.
  if (process.platform !== 'darwin' && process.platform !== 'win32') return
  ipcRenderer.on(DESKTOP_IPC.windowFullscreen, (_event, fullscreen: boolean) => {
    const root = document.documentElement as HTMLElement | null
    if (root === null) return
    if (fullscreen) root.dataset.fullscreen = 'true'
    else delete root.dataset.fullscreen
  })
}
