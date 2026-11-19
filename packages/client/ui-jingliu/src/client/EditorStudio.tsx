/** The local OpenChatCut editing surface for the current Muse conversation. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { CutImport } from './CutImport.tsx'
import type { CutImportActions } from './cut-import-actions.ts'
import { observeEditor, holdEditorProject, type EditorProject } from './editor-view.ts'
import type {} from './locales.ts'
import css from './EditorStudio.module.css'

type EditorProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'jingliuStudio'> & InjectFace<{
  editorUrl: string
  canImport: boolean
  actions: CutImportActions
  hooks: { loginGeneration: HostObservable<number> }
}>

function EditorView({ editorUrl, canImport, actions, sessionId, t, useTabInfo }: EditorProps): ReactNode {
  const { tab } = useTabInfo()
  const frame = useRef<HTMLIFrameElement>(null)
  const [project, select] = useState<EditorProject | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, retry] = useState(0)
  const url = new URL(editorUrl)
  url.searchParams.set('museParent', location.origin)
  const origin = url.origin
  const controls = url.searchParams.has('museAgent')
  const id = project?.id
  const name = project?.name
  const owner = project?.owner?.id
  const epoch = project?.owner?.epoch

  useEffect(() => {
    if (controls && frame.current) return observeEditor(frame.current, origin, select)
  }, [controls, origin])

  useEffect(() => {
    setFailed(false)
    if (!controls || !id || !owner || epoch === undefined) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, tab.signal])
    void holdEditorProject(sessionId, id, name ?? id, { id: owner, epoch }, signal).catch(() => {
      if (!signal.aborted) setFailed(true)
    })
    return () => controller.abort()
  }, [controls, sessionId, tab.signal, id, name, owner, epoch, attempt])

  return <div className={css.panel}>
    {canImport && <CutImport frameRef={frame} editorUrl={editorUrl} actions={actions} t={t} />}
    {failed && <div className={css.notice} role="alert">
      {t('editDisconnected')} <button type="button" onClick={() => retry(value => value + 1)}>{t('editReconnect')}</button>
    </div>}
    <div className={css.viewport}>
      <iframe ref={frame} className={css.frame} title={t('editorTitle')} src={url.href} referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals" allow="autoplay; fullscreen" />
    </div>
  </div>
}

/** Mount the timeline and review controls for a single account and Session.
 * @param props - Editor address, Session scope and optional episode import.
 * @returns The editor filling its sidebar tab.
 */
export function EditorStudio(props: EditorProps): ReactNode {
  const generation = props.useLoginGeneration(value => value)
  return <EditorView key={generation + ':' + props.sessionId} {...props} />
}
