/** The local OpenChatCut editor beside its owning Muse conversation. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { editorAgentViewRoute } from '../editor-agent-protocol.ts'
import { CutImport } from './CutImport.tsx'
import type { cutImportActions } from './cut-import-actions.ts'
import { observeEditor, type editorConversation, type EditorProject } from './editor-conversation.ts'
import type {} from './locales.ts'
import css from './EditorStudio.module.css'

type EditorProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'jingliuStudio'> &
  InjectFace<Omit<ReturnType<typeof editorConversation>, 'hooks'> & {
    editorUrl: string
    canImport: boolean
    actions: ReturnType<typeof cutImportActions>
    hooks: ReturnType<typeof editorConversation>['hooks'] & { loginGeneration: HostObservable<number> }
  }>

function AgentRail({ project, props, active }: { project: EditorProject; props: EditorProps; active: boolean }): ReactNode {
  const { t, send, sessionId, available, useTurns, useBusy } = props
  const turns = useTurns(value => value)
  const running = useBusy(value => value)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, retry] = useState(0)
  const pending = useRef<AbortController | null>(null)
  const feed = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const choose = (prompt: string) => { setDraft(prompt); input.current?.focus() }
  const shortcuts = turns.length ? [...project.starters, ...project.shortcuts] : project.shortcuts
  const owner = project.owner?.id
  const epoch = project.owner?.epoch
  useEffect(() => {
    setStatus('connecting')
    if (!active || !owner || epoch === undefined) return
    const controller = new AbortController()
    const { signal } = controller
    setSending(false)
    const connect = async () => {
      const url = new URL(editorAgentViewRoute, location.href)
      url.searchParams.set('session', sessionId)
      url.searchParams.set('project', project.id)
      url.searchParams.set('owner', owner)
      url.searchParams.set('epoch', String(epoch))
      const response = await fetch(url, { signal, headers: { 'x-muse-editor-view': '1' }, cache: 'no-store' })
      if (!response.ok || !response.body) throw new Error('editor view unavailable')
      const reader = response.body.getReader()
      try {
        if (!(await reader.read()).done && !signal.aborted) {
          setStatus('ready')
          while (!(await reader.read()).done) { /* The Host holds this selection until disconnect. */ }
        }
      } finally { reader.releaseLock() }
      if (!signal.aborted) setStatus('error')
    }
    void connect().catch(() => { if (!signal.aborted) setStatus('error') })
    return () => { controller.abort(); pending.current?.abort(); pending.current = null }
  }, [active, sessionId, project.id, owner, epoch, attempt])
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight }, [turns, running])
  const submit = async () => {
    const text = draft.trim()
    if (pending.current || !text || !available || status !== 'ready' || !active) return
    const controller = new AbortController()
    pending.current = controller
    setFailed(false); setSending(true)
    try {
      const accepted = await send(project.id, text, controller.signal)
      if (!controller.signal.aborted) {
        if (accepted) setDraft(value => value === text || value.trim() === text ? '' : value)
        else setFailed(true)
      }
    } catch (_error) { if (!controller.signal.aborted) setFailed(true) }
    finally { if (pending.current === controller) pending.current = null; if (!controller.signal.aborted) setSending(false) }
  }
  return <aside className={css.agent} aria-label={t('editAgent')}>
    <strong>{t('editAgent')}</strong>
    <div ref={feed} className={css.messages} aria-live="polite">
      {!turns.length && project.starters.length > 0 && <div className={css.starters}>
        {project.starters.map(item => <button type="button" key={item.label} onClick={() => choose(item.prompt)}>{item.label}</button>)}
      </div>}
      {turns.slice(-6).map(turn => <div key={turn.turn}>
        {turn.prompt && <p className={css.user}>{turn.prompt.replace(/\s*\[OpenChatCut project_id=[^\]]*(?:\]|$)/u, '')}</p>}
        {turn.response && <p>{turn.response}</p>}
      </div>)}
      {!project.owner && <small>{t('editConnecting')}</small>}
      {running && <small>{t('agentWorking')}</small>}
    </div>
    {(!available || status === 'error' || failed) && <div role="alert">{t(!available ? 'sessionUnavailable' : failed ? 'editSendFailed' : 'editDisconnected')}
      {status === 'error' && <button onClick={() => retry(n => n + 1)}>{t('editReconnect')}</button>}</div>}
    <form className={css.composer} onSubmit={(event) => { event.preventDefault(); void submit() }}>
      {shortcuts.length > 0 && <select aria-label={t('editShortcuts')} value="" onChange={(event) => {
        const item = shortcuts[Number(event.target.value)]
        if (item) choose(item.prompt)
      }}>
        <option value="" disabled>{t('editShortcuts')}</option>
        {shortcuts.map((item, index) => <option key={item.label} value={index}>{item.label}</option>)}
      </select>}
      <textarea ref={input} aria-label={t('editPrompt')} placeholder={t('editPrompt')} value={draft} rows={3} onChange={event => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} />
      <button type="submit" disabled={!available || status !== 'ready' || !draft.trim() || sending}>{t('editSend')}</button>
    </form>
  </aside>
}

/** Display the original editor alongside the current Muse chat.
 * @param props - Conversation, editor and optional import actions for this tab.
 * @returns An editor with project-scoped chat and manual timeline review.
 */
export function EditorStudio(props: EditorProps): ReactNode {
  const { editorUrl, canImport, actions, useLoginGeneration, useTabInfo, t } = props
  const generation = useLoginGeneration(value => value)
  const { tab } = useTabInfo()
  const frame = useRef<HTMLIFrameElement>(null)
  const [project, select] = useState<EditorProject | null>(null)
  const url = new URL(editorUrl)
  const agent = url.searchParams.has('museAgent')
  if (agent) url.searchParams.set('museParent', location.origin)
  const origin = url.origin
  useEffect(() => {
    if (agent && frame.current) return observeEditor(frame.current, origin, select)
  }, [agent, origin, generation])
  return <div className={css.panel}>
    {canImport && <CutImport key={generation} frameRef={frame} editorUrl={editorUrl} actions={actions} t={t} />}
    <div className={css.workbench}>
      {agent && project && <AgentRail key={generation + ':' + props.sessionId + ':' + project.id} project={project} props={props} active={tab.visible} />}
      <div className={css.viewport}>
        <iframe key={generation} ref={frame} className={css.frame} title={t('editorTitle')} src={url.href} referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals" allow="autoplay; fullscreen" />
      </div>
    </div>
  </div>
}
