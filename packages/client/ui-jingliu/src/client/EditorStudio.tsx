/** The original local OpenChatCut editor hosted in a Muse sidebar pane. */
import { useRef, type ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { CutImport } from './CutImport.tsx'
import type { cutImportActions } from './cut-import-actions.ts'
import type {} from './locales.ts'
import css from './EditorStudio.module.css'

type EditorProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'jingliuStudio'> &
  InjectFace<{
    editorUrl: string
    canImport: boolean
    actions: ReturnType<typeof cutImportActions>
    hooks: { loginGeneration: HostObservable<number> }
  }>

/**
 * Keep the upstream editing project mounted while Muse switches panes.
 * @param props - Local editor address and optional Jingliu import actions.
 * @returns Editing surface with the import action above it.
 */
export function EditorStudio({ editorUrl, canImport, actions, useLoginGeneration, t }: EditorProps): ReactNode {
  const generation = useLoginGeneration(value => value)
  const frame = useRef<HTMLIFrameElement>(null)
  return <div className={css.panel}>
    {canImport && <CutImport key={generation} frameRef={frame} editorUrl={editorUrl} actions={actions} t={t} />}
    <div className={css.viewport}>
      <iframe ref={frame} className={css.frame} title={t('editorTitle')} src={editorUrl} referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"
        allow="autoplay; fullscreen" />
    </div>
  </div>
}
