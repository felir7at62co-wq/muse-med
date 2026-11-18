/** Muse's read-only selected-episode requests and the handoff to its local editor. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { cutImportLimits, cutImportRoute, type CutEpisode, type CutProject, type CutSelection } from '../cut-import-protocol.ts'

/** Lists the current account’s episodes and transfers an explicit selection into the editor. */
export interface CutImportActions {
  projects(signal: AbortSignal): Promise<CutProject[]>
  episodes(project: string, signal: AbortSignal): Promise<CutEpisode[]>
  send(frame: Window, origin: string, project: string, episode: number, signal: AbortSignal,
    progress: (completed: number, total: number) => void): Promise<void>
}

const channelKind = 'muse.jingliu.cut.v1'

async function read(route: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(cutImportRoute + route, { credentials: 'same-origin', redirect: 'error', signal })
  if (!response.ok) throw Error(response.status === 401 ? 'sign-in' : 'import')
  return response
}

async function receive(port: MessagePort, id: string, signal: AbortSignal, timeout: number): Promise<string> {
  const active = AbortSignal.any([signal, AbortSignal.timeout(timeout)])
  active.throwIfAborted()
  return new Promise((resolve, reject) => {
    const close = () => { port.removeEventListener('message', message); active.removeEventListener('abort', abort) }
    const abort = () => { close(); reject(active.reason) }
    const message = (e: MessageEvent) => {
      if (e.data?.id !== id) return
      close()
      if (e.data.state === 'error') reject(Error('import'))
      else resolve(String(e.data.state))
    }
    active.addEventListener('abort', abort, { once: true })
    port.addEventListener('message', message)
    port.start()
  })
}

/** Create actions for the authenticated Muse page.
 * @returns Selection queries and explicit, window-bound, single-episode import.
 */
export function cutImportActions(): CutImportActions {
  return {
    projects: async signal => (await read('/projects', signal)).json(),
    episodes: async (project, signal) => (await read('/projects/' + encodeURIComponent(project) + '/episodes', signal)).json(),
    send: async (frame, editorUrl, project, episode, signal, progress) => {
      const editor = new URL(editorUrl)
      if (!['127.0.0.1', '[::1]'].includes(editor.hostname) || !['http:', 'https:'].includes(editor.protocol)
        || editor.username || editor.password) throw Error('editor')
      const path = '/projects/' + encodeURIComponent(project) + '/episodes/' + episode
      const selected: CutSelection = await (await read(path, signal)).json()
      if (selected.shots.length === 0 || selected.shots.length > cutImportLimits.shots) throw Error('import')
      const id = randomUUID()
      const { port1, port2 } = new MessageChannel()
      try {
        frame.postMessage({ kind: channelKind, id }, editor.origin, [port2])
        if (await receive(port1, id, signal, 5000) !== 'ready') throw Error('editor')
        let bytes = 0
        const clips = []
        for (const [index, shot] of selected.shots.entries()) {
          progress(index, selected.shots.length)
          const response = await read('/media/' + encodeURIComponent(selected.ticket) + '/' + index, signal)
          const file = await response.blob()
          bytes += file.size
          if (!file.size || file.size > cutImportLimits.clipBytes || bytes > cutImportLimits.episodeBytes) throw Error('size')
          clips.push({ ...shot, file })
        }
        signal.throwIfAborted()
        progress(clips.length, clips.length)
        port1.postMessage({ id, name: selected.name, aspect: selected.aspect, clips })
        if (await receive(port1, id, signal, 20 * 60_000) !== 'imported') throw Error('import')
      } finally { port1.postMessage({ id, state: 'cancel' }); port1.close() }
    },
  }
}
