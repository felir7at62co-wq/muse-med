/** Task status attached to the exact execution Session's sidebar row. */
import type { HostObservable, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { AssignmentStatus, CoordinationTask } from '@deepseek-ai/dsh-session-coordinator/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NS } from './locales.ts'
import css from './TaskRowStatus.module.css'

/** The current routing Session, cleared when its owner access ends. */
export interface TaskRowInjected {
  readonly hooks: { readonly coordinatorMain: HostObservable<SessionId | null> }
}

type Props = Pick<PropsRuntime<'sidebar.session.row.persistent'>, 'sessionId'> & PropsHooks<TaskRowInjected['hooks']>
  & PropsLocale<typeof NS> & { readonly useResource: (address: string) => ResourceSnapshot<CoordinationTask[]> }

const priority: Record<AssignmentStatus, number> = {
  failed: 0, blocked: 0, 'needs-input': 0, interrupted: 0, 'needs-report': 0,
  dispatching: 1, reconciling: 1, accepted: 1, running: 1, finishing: 1, stopping: 1,
  stopped: 2, completed: 2,
}

function BoundStatus({ mainId, sessionId, useResource, t }: Props & { readonly mainId: SessionId }) {
  const resource = useResource(`dsh-resource://muse-tasks/${encodeURIComponent(mainId)}`)
  if (resource.status !== 'live' || resource.value === undefined) return null
  const matches = resource.value.flatMap((task) => {
    const attempt = task.attempts.at(-1)
    return attempt?.sessionId === sessionId ? [{ task, attempt }] : []
  }).sort((a, b) => priority[a.attempt.status] - priority[b.attempt.status] || b.task.createdAt - a.task.createdAt)
  const first = matches[0]
  if (first === undefined) return null
  const text = matches.map(({ task, attempt }) => `${task.title}: ${t(attempt.status)}`).join('; ')
  const working = ['dispatching', 'reconciling', 'accepted', 'running', 'finishing', 'stopping'].includes(first.attempt.status)
  return <span className={css.badge} data-task-status={first.attempt.status} data-working={working || undefined}>
    <span className={css.spider} aria-hidden="true" />
    <span className={css.labels} aria-hidden="true">
      <span className={css.title}>{first.task.title}</span>
      <span className={css.status}>{t(first.attempt.status)}{matches.length > 1 ? ` +${matches.length - 1}` : ''}</span>
    </span>
    <span className={css.screenReader}>{t('tasks')}: {text}</span>
  </span>
}

/**
 * Show only coordinator statuses bound to this exact row and current owner.
 * @param props - Row identity, shared resource hook and current owner source.
 * @returns a compact status or no additional UI.
 */
export function TaskRowStatus(props: Props) {
  const mainId = props.useCoordinatorMain(value => value)
  return mainId === null ? null : <BoundStatus {...props} mainId={mainId} />
}
