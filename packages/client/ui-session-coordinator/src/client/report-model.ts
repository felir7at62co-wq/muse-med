/** Validate persisted report metadata and bind live updates to its exact assignment. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallPhaseProps, ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { AssignmentStatus, CoordinationReport, CoordinationTask, CoordinationTaskId, ReportTask, WorkerReport } from '@deepseek-ai/dsh-session-coordinator/types'

const statuses: readonly AssignmentStatus[] = ['dispatching', 'reconciling', 'accepted', 'running', 'finishing', 'needs-report', 'interrupted', 'stopping', 'stopped', 'completed', 'blocked', 'needs-input', 'failed']

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim() !== '' }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }

function report(value: unknown): WorkerReport | null | undefined {
  if (value === null) return null
  if (!record(value) || typeof value.outcome !== 'string' || !['completed', 'blocked', 'needs-input', 'failed'].includes(value.outcome)
    || typeof value.summary !== 'string' || !Array.isArray(value.files)
    || typeof value.throughSeq !== 'number' || !Number.isSafeInteger(value.throughSeq) || value.throughSeq < 0) return undefined
  const files: WorkerReport['files'][number][] = []
  const seen = new Set<string>()
  for (const file of value.files) {
    if (!record(file) || !nonempty(file.path) || (file.description !== undefined && typeof file.description !== 'string')) return undefined
    if (seen.has(file.path)) continue
    seen.add(file.path)
    files.push({ path: file.path, ...(file.description === undefined ? {} : { description: file.description }) })
  }
  return { outcome: value.outcome as WorkerReport['outcome'], summary: value.summary, files, throughSeq: value.throughSeq }
}

function task(value: unknown): ReportTask | null {
  if (!record(value) || !nonempty(value.id) || !nonempty(value.title) || !positive(value.revision)
    || !nonempty(value.sessionId) || !nonempty(value.cwd) || typeof value.status !== 'string'
    || !statuses.includes(value.status as AssignmentStatus)
    || (value.issue !== null && typeof value.issue !== 'string')) return null
  const receipt = report(value.report)
  if (receipt === undefined) return null
  return { id: brandString<CoordinationTaskId>(value.id), title: value.title, revision: value.revision,
    sessionId: SessionId(value.sessionId), cwd: value.cwd, status: value.status as AssignmentStatus,
    report: receipt, issue: value.issue }
}

/**
 * Admit only a successful root report belonging to the displayed conversation.
 * @param props - Raw Tool view values from live or replayed Session events.
 * @returns Validated immutable receipt, or null for raw result presentation.
 */
export function reportCardModel(props: Pick<ToolCallViewProps, 'toolName' | 'sessionId'> & ToolCallPhaseProps): CoordinationReport | null {
  if (props.phase !== 'result' || props.toolName !== 'coordinator_show_report' || props.block.isError
    || props.block.parentCallId !== undefined || props.block.call?.name !== 'coordinator_show_report') return null
  return recordedReport(props.block.meta, props.sessionId)
}

/**
 * Validate the versioned receipt carried by a successful report result.
 * @param meta - Durable tool-result metadata.
 * @param owner - Displayed conversation, when the caller can verify its identity.
 * @returns Reconstructed receipt, or null for unsupported or malformed metadata.
 */
export function recordedReport(meta: unknown, owner?: SessionId): CoordinationReport | null {
  if (!record(meta) || !record(meta.museCoordinationReport)) return null
  const value = meta.museCoordinationReport
  if (value.version !== 1 || !nonempty(value.owner) || (owner !== undefined && value.owner !== owner) || !Array.isArray(value.tasks)
    || typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < value.tasks.length
    || typeof value.truncated !== 'boolean' || value.truncated !== (value.total > value.tasks.length)) return null
  const tasks: ReportTask[] = []
  const seen = new Set<string>()
  for (const raw of value.tasks) {
    const parsed = task(raw)
    if (parsed === null || seen.has(parsed.id)) return null
    seen.add(parsed.id)
    tasks.push(parsed)
  }
  return { version: 1, owner: SessionId(value.owner), tasks, total: value.total, truncated: value.truncated }
}

/** Exact assignment plus whether its state is a live observation or recorded receipt. */
export interface ReportDisplay {
  readonly task: ReportTask
  readonly live: boolean
}

/**
 * Follow the recorded revision only while it is still the task's current assignment.
 * @param receipt - Persisted report whose identity never changes with later revisions.
 * @param owner - Main conversation that owns the receipt and observed tasks.
 * @param resource - Existing owner-only task stream; failed streams retain their recorded receipt.
 * @returns Display state for the same assignment, never another revision's result or files.
 */
export function reportDisplay(receipt: ReportTask, owner: SessionId, resource: ResourceSnapshot<CoordinationTask[]>): ReportDisplay {
  const current = resource.status === 'live'
    ? resource.value?.find(value => value.id === receipt.id && value.owner === owner) : undefined
  const attempt = current?.attempts.at(-1)
  if (attempt === undefined || attempt.revision !== receipt.revision
    || attempt.sessionId !== receipt.sessionId || attempt.cwd !== receipt.cwd) {
    return { task: receipt, live: false }
  }
  return { live: true, task: { ...receipt, status: attempt.status, report: attempt.report, issue: attempt.issue } }
}
