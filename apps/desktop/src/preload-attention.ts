/** Live main-process cues play only in the owned application document, without exposing a page API. */
import { ipcRenderer } from 'electron'
import { createAttentionAudioPlayer } from './attention-audio.ts'
import { DESKTOP_IPC } from './ipc.ts'

/** Install one document-owned audio subscription; page replacement cancels playback without replay. */
export function installAttentionAudio(): void {
  const player = createAttentionAudioPlayer()
  let disposed = false
  const report = (error: unknown): void => { console.warn('desktop attention audio:', error) }
  const receive = (_event: Electron.IpcRendererEvent, kind: unknown): void => {
    if (disposed || (kind !== 'complete' && kind !== 'question')) return
    void player.play(kind).catch(report)
  }
  ipcRenderer.on(DESKTOP_IPC.attentionSound, receive)
  window.addEventListener('pagehide', () => {
    disposed = true
    ipcRenderer.off(DESKTOP_IPC.attentionSound, receive)
    void player.dispose().catch(report)
  }, { once: true })
}
