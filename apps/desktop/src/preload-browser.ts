/** Lease-scoped browser operations and one main-process event subscription per window. */
import { ipcRenderer } from 'electron'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

/** @returns browser operations that expose neither IPC nor Electron objects. */
export function createDesktopBrowserBridge(): DesktopBrowserBridge {
  const listeners = new Map<DesktopBrowserLeaseId, Set<(url: string) => void>>()
  ipcRenderer.on(DESKTOP_IPC.browserOpenRequested, (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null || !('lease' in request) || !('url' in request)
      || typeof request.lease !== 'string' || typeof request.url !== 'string') return
    const callbacks = listeners.get(request.lease as DesktopBrowserLeaseId)
    if (callbacks === undefined) return
    for (const callback of [...callbacks]) {
      try { callback(request.url) }
      catch (error) { console.error('Desktop browser link handler failed', error) }
    }
  })
  return {
    acquire: (workspace, sessionId, initialUrl) => ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace, sessionId, initialUrl) as ReturnType<DesktopBrowserBridge['acquire']>,
    release: lease => ipcRenderer.invoke(DESKTOP_IPC.browserRelease, lease) as Promise<void>,
    activeSession: (sessionId) => { void ipcRenderer.invoke(DESKTOP_IPC.browserActiveSession, sessionId) },
    onDownloadPageRequested(listener) {
      const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => {
        if (typeof value === 'object' && value !== null && 'sessionId' in value && 'url' in value
          && typeof value.sessionId === 'string' && typeof value.url === 'string') listener({ sessionId: value.sessionId, url: value.url })
      }
      ipcRenderer.on(DESKTOP_IPC.browserDownloadPage, receive)
      return () => { ipcRenderer.removeListener(DESKTOP_IPC.browserDownloadPage, receive) }
    },
    onOpenRequested(lease, listener) {
      let callbacks = listeners.get(lease)
      if (callbacks === undefined) { callbacks = new Set(); listeners.set(lease, callbacks) }
      callbacks.add(listener)
      return () => {
        callbacks.delete(listener)
        if (callbacks.size === 0 && listeners.get(lease) === callbacks) listeners.delete(lease)
      }
    },
  }
}
