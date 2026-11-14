/** Inline task reports derived from durable Tool results and exact-revision observations. */
import { useState } from 'react'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallPhaseProps, ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { CoordinationReport, ReportTask } from '@deepseek-ai/dsh-session-coordinator/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { reportCardModel, reportDisplay } from './report-model.ts'
import type { NS } from './locales.ts'
import css from './ReportCard.module.css'

/** Worker-owned navigation actions; file previews keep the worker's directory. */
export interface ReportCardActions {
  readonly openExecution: (sessionId: SessionId) => void
  readonly openDelivery: (sessionId: SessionId, cwd: string, path: string) => void
}

type Props = Pick<ToolCallViewProps, 'toolName' | 'sessionId' | 'useResource' | 'useSessions' | 'inspect'> & ToolCallPhaseProps & PropsLocale<typeof NS> & ReportCardActions

type NodeProps = Pick<PropsRuntime<'conversation.chat.node', 'muse-coordination-report'>, 'node' | 'sessionId' | 'useResource' | 'useSessions'>
  & PropsLocale<typeof NS> & ReportCardActions

/**
 * Show a report as a visible conversation row, independent of process folding.
 * @param props - Conversation node, actual Session identity, Session list and worker navigation.
 * @returns One inline report, or nothing when the receipt belongs to another Session.
 */
export function ReportCardNode({ node, sessionId, useResource, useSessions, t, openExecution, openDelivery }: NodeProps) {
  const props: Props = { phase: 'result', block: node.data.block, toolName: 'coordinator_show_report',
    sessionId, useResource, useSessions, t, openExecution, openDelivery }
  return reportCardModel(props) === null ? null : <ReportCard {...props} />
}

/**
 * Render a report only for validated receipts, keeping malformed and pending calls inspectable.
 * @param props - Tool slot values, locale, resource and Session list hooks, and worker navigation actions.
 * @returns Inline report or raw tool disclosure; no conversation overlay is created.
 */
export function ReportCard(props: Props) {
  const model = reportCardModel(props)
  return model === null ? <RawReport {...props} /> : <VerifiedReport {...props} model={model} />
}

function RawReport({ phase, block, t, inspect }: Props) {
  const [open, setOpen] = useState(false)
  const args = phase === 'result' ? block.call?.argsRaw ?? '' : phase === 'start' ? block.argsRaw : ''
  const output = phase === 'result' ? block.content.map(value => value.type === 'text' ? value.text : JSON.stringify(value)).join('\n') : ''
  const error = phase === 'result' && block.error !== undefined ? `${block.error.name}: ${block.error.code}` : ''
  const text = [args, output || error].filter(Boolean).join('\n\n')
  return <div data-tool="coordinator_show_report" data-report-fallback>
    <DisclosureRow icon={null} title={t('reportTitle')} open={open} expandable={text !== ''}
      onToggle={() => { setOpen(value => !value) }} running={phase !== 'result'} expandOnRowClick>
      <pre className={css.raw}>{text}</pre>
      {inspect && <button type="button" className={css.action} onClick={inspect}>{t('reportInspect')}</button>}
    </DisclosureRow>
  </div>
}

function VerifiedReport({ model, useResource, useSessions, t, openExecution, openDelivery }: Props & { readonly model: CoordinationReport }) {
  const resource = useResource<'muse-tasks'>(`dsh-resource://muse-tasks/${encodeURIComponent(model.owner)}`)
  return <section className={css.report} aria-label={t('reportTitle')} data-muse-coordination-report>
    <div className={css.header}><h3>{t('reportTitle')}</h3></div>
    {model.truncated && <p className={css.notice}>{t('reportPartial', { count: model.tasks.length, total: model.total })}</p>}
    {resource.status === 'failed' && <p className={css.notice} role="status">{t('reportUnavailable')}</p>}
    {model.tasks.length === 0 && <p className={css.empty}>{t('reportEmpty')}</p>}
    <div className={css.tasks}>{model.tasks.map((receipt) => {
      const display = reportDisplay(receipt, model.owner, resource)
      return <ReportTaskCard key={receipt.id} task={display.task} live={display.live} useSessions={useSessions} t={t}
        openExecution={openExecution} openDelivery={openDelivery} />
    })}</div>
  </section>
}

function ReportTaskCard({ task, live, useSessions, t, openExecution, openDelivery }: Pick<Props, 'useSessions' | 't' | 'openExecution' | 'openDelivery'> & {
  readonly task: ReportTask
  readonly live: boolean
}) {
  // Only a worker in the Host Session list opens: a task that never started has none, whatever status its receipt records.
  const listed = useSessions(state => state.ids.includes(task.sessionId))
  return <article className={css.task} data-report-task={task.id} data-report-revision={task.revision}>
    <div className={css.taskHeading}><h4>{task.title}</h4><span className={css.status}>{t(task.status)}</span></div>
    <p className={css.meta}><span>{t('reportRevision', { revision: task.revision })}</span><span aria-hidden="true"> · </span><span>{t(live ? 'reportLive' : 'reportHistorical')}</span></p>
    {task.report !== null && <p className={css.summary}>{task.report.summary}</p>}
    {task.issue !== null && <p className={css.notice}>{task.issue}</p>}
    {listed && <div className={css.actions}>
      <button type="button" className={css.action} onClick={() => { openExecution(task.sessionId) }}>{t('open')}</button>
    </div>}
    {task.report !== null && task.report.files.length > 0 && <ul className={css.files} aria-label={t('files')}>
      {task.report.files.map(file => <li key={file.path}><button type="button" className={css.action}
        onClick={() => { openDelivery(task.sessionId, task.cwd, file.path) }}>
        {file.description ?? file.path.split(/[\\/]/u).at(-1)}</button></li>)}
    </ul>}
    {task.status === 'completed' && <p className={css.acceptance}>{t('receipt')}</p>}
  </article>
}
