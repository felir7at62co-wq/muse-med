/** Editor selection shared with the Muse Session that owns the sidebar tab. */
import { editorAgentViewRoute, editorProjectId, type EditorOwner } from '../editor-agent-protocol.ts'

/** A selected project published by the configured editing frame. */
export interface EditorProject {
  id: string
  name: string
  owner: EditorOwner | null
}
/** Listen to project selection only from the editing frame. The frame cannot submit Muse prompts.
 * @param frame - Editor iframe owned by the current session.
 * @param origin - Configured local editor origin.
 * @param select - Replace the presented project, or clear it on navigation.
 * @returns Listener cleanup.
 */
export function observeEditor(frame: HTMLIFrameElement, origin: string, select: (project: EditorProject | null) => void): () => void {
  const request = () => {
    select(null)
    if (frame.contentDocument?.URL !== 'about:blank') frame.contentWindow?.postMessage({ type: 'muse:editor-project' }, origin)
  }
  const receive = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.type !== 'openchatcut:project') return
    const project = event.data.project
    if (project === null) select(null)
    else if (project && typeof project.id === 'string' && editorProjectId.test(project.id) && typeof project.name === 'string') {
      const lease = project.owner
      const owner: EditorOwner | null = lease && typeof lease.id === 'string' && editorProjectId.test(lease.id) &&
        Number.isSafeInteger(lease.epoch) && lease.epoch >= 0 ? { id: lease.id, epoch: lease.epoch } : null
      select({ id: project.id, name: project.name, owner })
    }
  }
  window.addEventListener('message', receive)
  frame.addEventListener('load', request)
  request()
  return () => { frame.removeEventListener('load', request); window.removeEventListener('message', receive) }
}

/** Keep this project available to its main chat until its tab closes or its editor changes.
 * @param session - Session owning the editor.
 * @param project - Selected OpenChatCut project ID.
 * @param name - Display name for choosing between open projects.
 * @param owner - Editor instance holding this project.
 * @param signal - Cancel on project change, tab close, or account replacement.
 */
export async function holdEditorProject(
  session: string,
  project: string,
  name: string,
  owner: EditorOwner,
  signal: AbortSignal,
): Promise<void> {
  const url = new URL(editorAgentViewRoute, location.href)
  url.search = new URLSearchParams({ session, project, name: name.slice(0, 256), owner: owner.id, epoch: String(owner.epoch) }).toString()
  const response = await fetch(url, { signal, headers: { 'x-muse-editor-view': '1' }, cache: 'no-store' })
  if (!response.ok || !response.body) throw new Error('Editor connection unavailable')
  await response.body.pipeTo(new WritableStream<Uint8Array>(), { signal })
  signal.throwIfAborted()
  throw new Error('Editor connection closed')
}
