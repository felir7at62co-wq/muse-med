/** Main Session task cards; business reads arrive through the shared resource hook. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CoordinationTask, CoordinationTaskId } from '@deepseek-ai/dsh-session-coordinator/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NS } from './locales.ts'
import css from './TaskCards.module.css'

/** Actions supplied by the plugin, retaining the exact task revision. */
export interface TaskActions {
  readonly openSession: (id: SessionId) => void
  readonly stop: (owner: SessionId, taskId: CoordinationTaskId, revision: number) => Promise<void>
  readonly openFile: (path: string) => Promise<void>
}

/** Slot-owned identity, standard hooks, actions and translated copy. */
export type TaskCardsProps = PropsRuntime<'conversation.content.overlay'> & PropsLocale<typeof NS> & TaskActions

type TaskViewProps = Pick<TaskCardsProps, 'sessionId' | 'activeView' | 'useSessions' | 't' | 'openSession' | 'stop' | 'openFile'> & {
  readonly useResource: (address: string) => ResourceSnapshot<CoordinationTask[]>
}

function TaskCard({ task, useSessions, openSession, stop, openFile, t }: Pick<TaskCardsProps, 'useSessions' | 'openSession' | 'stop' | 'openFile' | 't'> & { task: CoordinationTask }) {
  const attempt = task.attempts.at(-1)
  // Only a worker in the Host Session list opens: a waiting task, or one that stopped or failed before starting, has none.
  const listed = useSessions(state => attempt !== undefined && state.ids.includes(attempt.sessionId))
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const closeOutside = (event: PointerEvent): void => {
      const details = detailsRef.current
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false
    }
    const closeEscape = (event: KeyboardEvent): void => {
      const details = detailsRef.current
      if (event.key === 'Escape' && details?.open) { details.open = false; details.querySelector('summary')?.focus() }
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [])
  if (attempt === undefined) return null
  const canStop = ['dispatching', 'reconciling', 'accepted', 'running', 'finishing', 'needs-report', 'interrupted'].includes(attempt.status)
  const stopTask = async (): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    try { await stop(task.owner, task.id, attempt.revision) }
    finally { pendingRef.current = false; setPending(false) }
  }
  const working = ['dispatching', 'reconciling', 'accepted', 'running', 'finishing', 'stopping'].includes(attempt.status)
  return <details ref={detailsRef} className={css.card} data-coordination-task={task.id} data-working={working || undefined}>
    <summary className={css.heading}>
      <span className={css.spider} aria-hidden="true" />
      <span className={css.headingText}>
        <span className={css.title}>{task.title}</span><span className={css.status}>{t(attempt.status)}</span>
      </span>
      <span className={css.chevron} aria-hidden="true">⌄</span>
    </summary>
    <div className={css.panel}><p className={css.fullTitle}>{task.title}</p>
      <div className={css.actions}>
        {listed && <button type="button" onClick={() => { openSession(attempt.sessionId) }}>{t('open')}</button>}
        {canStop && <button type="button" disabled={pending} onClick={() => { void stopTask() }}>{t('stop')}</button>}
      </div>
      {attempt.report !== null && <p>{attempt.report.summary}</p>}
      {attempt.issue !== null && <div className={css.issue}><p>{t('attention')}</p><details><summary>{t('details')}</summary><p>{attempt.issue}</p></details></div>}
      {attempt.report !== null && attempt.report.files.length > 0 && <div className={css.files} aria-label={t('files')}>
        {attempt.report.files.map(file => <button type="button" key={file.path} onClick={() => { void openFile(file.path) }}>
          {file.description ?? file.path.split(/[\\/]/u).at(-1)}
        </button>)}
      </div>}
      {attempt.status === 'completed' && <small>{t('receipt')}</small>}
    </div>
  </details>
}

function MainTasks(props: TaskViewProps) {
  const resource = props.useResource(`dsh-resource://muse-tasks/${encodeURIComponent(props.sessionId)}`)
  const tasks = resource.value ?? []
  if (tasks.length === 0 && resource.status !== 'failed') return null
  return <div className={css.tasks} data-muse-coordination-cards>
    {resource.status === 'failed' && <p role="alert">{props.t('failedRead')}</p>}
    <div className={css.list}>{tasks.map(task => <TaskCard key={task.id} task={task} {...props} />)}</div>
  </div>
}

/**
 * Render task status only for the routing preset, preserving ordinary conversations.
 * @param props - Existing conversation overlay bindings and injected actions.
 * @returns resource-backed cards or no additional UI.
 */
export function TaskCards(props: TaskViewProps) {
  const preset = props.useSessions(state => state.byId[props.sessionId]?.projectionValues?.agentPreset)
  return props.activeView === 'chat' && preset === 'main-session' ? <MainTasks {...props} /> : null
}
