/** The editor uses the same Session and Chat projection as Muse's main composer. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { editorProjectId, type EditorOwner } from '../editor-agent-protocol.ts'

/** A selected project published by the configured editing frame. */
export interface EditorProject {
  id: string
  name: string
  owner: EditorOwner | null
  starters: readonly EditorSuggestion[]
  shortcuts: readonly EditorSuggestion[]
}
interface EditorSuggestion { label: string; prompt: string }

function suggestions(value: unknown): EditorSuggestion[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 32).flatMap(item =>
    item && typeof item.label === 'string' && item.label.length <= 80 && typeof item.prompt === 'string' && item.prompt.length <= 2000
      ? [{ label: item.label, prompt: item.prompt }] : [])
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
      select({
        id: project.id, name: project.name, owner,
        starters: suggestions(project.starters), shortcuts: suggestions(project.shortcuts),
      })
    }
  }
  window.addEventListener('message', receive)
  frame.addEventListener('load', request)
  request()
  return () => { frame.removeEventListener('load', request); window.removeEventListener('message', receive) }
}

const empty: readonly { turn: number; prompt: string; response: string }[] = []
const idle = () => () => {}

/** Build the editor's view of an existing Muse conversation.
 * @param ctx - Client with the Session controller and Chat projection.
 * @param sessionId - Session owning the sidebar tab.
 * @returns Native Session submission and live transcript readers.
 */
export function editorConversation(ctx: Context, sessionId: SessionId) {
  const binding = ctx.get('sessions')?.binding(sessionId)
  const chat = binding && ctx.get('uiConversation')?.binding(binding).target('chat')
  return {
    sessionId, available: Boolean(binding),
    async send(project: string, text: string, signal: AbortSignal): Promise<boolean> {
      if (!binding || ctx.get('sessions')?.binding(sessionId) !== binding) return false
      const result = await binding.session.prompt([{ type: 'text', text: text + '\n\n[OpenChatCut project_id=' + project + ']' }], 'queue', signal)
      return result.ok
    },
    hooks: {
      turns: { getSnapshot: () => chat?.getSnapshot()?.navigation.items() ?? empty, subscribe: chat?.subscribe ?? idle },
      busy: { getSnapshot: () => binding?.session.getSnapshot().running ?? false,
        subscribe: (cb: () => void) => binding?.session.subscribe(cb) ?? (() => {}) },
    },
  }
}
