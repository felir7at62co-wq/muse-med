/** Main Session task cards; business reads arrive through the shared resource hook. */
import { useRef, useState } from 'react'
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
export type TaskCardsProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<typeof NS> & TaskActions

type TaskViewProps = Pick<TaskCardsProps, 'sessionId' | 'useSessions' | 't' | 'openSession' | 'stop' | 'openFile'> & {
  readonly useResource: (address: string) => ResourceSnapshot<CoordinationTask[]>
}

function TaskCard({ task, openSession, stop, openFile, t }: Pick<TaskCardsProps, 'openSession' | 'stop' | 'openFile' | 't'> & { task: CoordinationTask }) {
  const attempt = task.attempts.at(-1)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  if (attempt === undefined) return null
  const canStop = ['dispatching', 'accepted', 'running', 'finishing', 'needs-report', 'interrupted'].includes(attempt.status)
  const stopTask = async (): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    try { await stop(task.owner, task.id, attempt.revision) }
    finally { pendingRef.current = false; setPending(false) }
  }
  return <article className={css.card} data-coordination-task={task.id}>
    <div className={css.heading}><span>{task.title}</span><span className={css.status}>{t(attempt.status)}</span></div>
    <div className={css.actions}>
      <button type="button" onClick={() => { openSession(attempt.sessionId) }}>{t('open')}</button>
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
  </article>
}

function MainTasks(props: TaskViewProps) {
  const resource = props.useResource(`dsh-resource://muse-tasks/${encodeURIComponent(props.sessionId)}`)
  const tasks = resource.value ?? []
  if (tasks.length === 0 && resource.status !== 'failed') return null
  return <details className={css.tasks} open data-muse-coordination-cards>
    <summary>{props.t('tasks')} · {tasks.length}</summary>
    {resource.status === 'failed' && <p role="alert">{props.t('failedRead')}</p>}
    <div className={css.list}>{tasks.map(task => <TaskCard key={task.id} task={task} {...props} />)}</div>
  </details>
}

/**
 * Render task status only for the routing preset, preserving ordinary conversations.
 * @param props - Existing conversation dock bindings and injected actions.
 * @returns resource-backed cards or no additional UI.
 */
export function TaskCards(props: TaskViewProps) {
  const preset = props.useSessions(state => state.byId[props.sessionId]?.projectionValues?.agentPreset)
  return preset === 'main-session' ? <MainTasks {...props} /> : null
}
