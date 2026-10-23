/** Read-only consumer of user-confirmed project-bible music feedback. */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Immutable user feedback written through drama_project's preview/revision workflow. */
export interface MusicFeedback {
  feedback_id: string
  track_id?: string
  source_sha256?: string
  decision: 'accept' | 'reject'
  context_tags: string[]
  reason: string
  recorded_at: string
  episode?: number
  user_quote?: string
}

/** Narrow, read-only view of the authoritative project configuration. */
export interface ProjectMusicFeedback {
  config_path: string
  status: 'missing_config' | 'no_feedback' | 'ready'
  records: MusicFeedback[]
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty text`)
  return value
}

/** Normalize only comparison keys; never rewrite persisted user feedback. */
function hash(value: string): string {
  return value.replace(/^sha256:/i, '').toLowerCase()
}

/** Bound display copies only; matching always uses complete persisted records. */
function excerpt(value: string, length = 256): string {
  const characters = Array.from(value)
  return characters.length <= length ? value : `${characters.slice(0, length).join('')}…`
}

function displayFeedback(row: MusicFeedback, applicable: boolean): Record<string, JsonValue> {
  const visible = { ...row, feedback_id: excerpt(row.feedback_id, 128),
    reason: excerpt(row.reason), recorded_at: excerpt(row.recorded_at, 64),
    context_tags: row.context_tags.slice(0, 8).map(tag => excerpt(tag, 64)),
    ...(row.track_id === undefined ? {} : { track_id: excerpt(row.track_id, 128) }),
    ...(row.user_quote === undefined ? {} : { user_quote: excerpt(row.user_quote) }) }
  return { ...visible, applicable, display_truncated: JSON.stringify(visible) !== JSON.stringify(row) }
}

/** Validate explicit scene tags; no text embedding or automatic semantic equivalence is claimed.
 * @param value - Optional current-scene tags from the tool call or persisted user feedback.
 * @returns Normalized comparison tags, empty only when the caller omitted them.
 */
export function parseContextTags(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('context_tags must contain nonempty scene tags')
  }
  return [...new Set(value.map(tag => text(tag, 'context tag').trim().toLocaleLowerCase('en-US')))]
}

function feedback(value: unknown): MusicFeedback {
  const row = object(value, 'bgm_feedback entry')
  const feedbackId = text(row.feedback_id, 'feedback_id')
  if (row.decision !== 'accept' && row.decision !== 'reject') throw new Error('bgm_feedback decision must be accept or reject')
  const tags = parseContextTags(row.context_tags)
  if (tags.length === 0) throw new Error('bgm_feedback requires context_tags; a scene rejection is not a global blacklist')
  const trackId = row.track_id === undefined ? undefined : text(row.track_id, 'track_id')
  const sourceHash = row.source_sha256 === undefined ? undefined : text(row.source_sha256, 'source_sha256')
  if (sourceHash !== undefined && !/^(?:sha256:)?[a-f0-9]{64}$/i.test(sourceHash)) throw new Error('bgm_feedback source_sha256 must be SHA-256')
  if (trackId === undefined && sourceHash === undefined) throw new Error('bgm_feedback requires track_id or source_sha256')
  const recordedAt = text(row.recorded_at, 'recorded_at')
  const date = recordedAt.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(recordedAt)
    || !Number.isFinite(Date.parse(recordedAt)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('bgm_feedback recorded_at must be an ISO timestamp with timezone')
  }
  if (row.episode !== undefined && (!Number.isSafeInteger(row.episode) || Number(row.episode) <= 0)) {
    throw new Error('bgm_feedback episode must be a positive safe integer')
  }
  return { feedback_id: feedbackId, decision: row.decision, context_tags: tags,
    reason: text(row.reason, 'reason'), recorded_at: recordedAt,
    ...(trackId === undefined ? {} : { track_id: trackId }),
    ...(sourceHash === undefined ? {} : { source_sha256: sourceHash }),
    ...(row.episode === undefined ? {} : { episode: Number(row.episode) }),
    ...(row.user_quote === undefined ? {} : { user_quote: text(row.user_quote, 'user_quote') }) }
}

/**
 * Read fresh feedback for every match, so reopening or continuing a Session sees updates.
 * Missing legacy configuration is ordinary; malformed feedback is reported, not silently ignored.
 * @param project - Explicit project directory, relative to the tool process when not absolute.
 * @param signal - Cancellation of the read operation.
 * @returns Validated feedback and its authoritative source path.
 */
export async function readProjectMusicFeedback(project: string, signal: AbortSignal): Promise<ProjectMusicFeedback> {
  if (!project.trim()) throw new Error('project must be a nonempty project directory')
  signal.throwIfAborted()
  const root = await realpath(resolve(project))
  const path = join(root, 'project_config.json')
  let info
  try { info = await lstat(path) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { config_path: path, status: 'missing_config', records: [] }
    }
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('project_config.json must be a regular non-linked file')
  if (info.size > 8 * 1024 * 1024) throw new Error('project_config.json exceeds the 8 MiB feedback reader limit')
  const config = object(JSON.parse((await readFile(path, { encoding: 'utf8', signal })).replace(/^\ufeff/u, '')), 'project_config.json')
  const bible = config.project_bible === undefined ? {} : object(config.project_bible, 'project_bible')
  if (bible.bgm_feedback === undefined) return { config_path: path, status: 'no_feedback', records: [] }
  if (!Array.isArray(bible.bgm_feedback)) throw new Error('project_bible.bgm_feedback must be an array')
  const records = bible.bgm_feedback.map(feedback)
  if (new Set(records.map(row => row.feedback_id)).size !== records.length) throw new Error('bgm_feedback feedback_id must be unique')
  signal.throwIfAborted()
  return { config_path: path, status: records.length ? 'ready' : 'no_feedback', records }
}

/**
 * Match stable track identity and explicit scene scope without turning a local rejection global.
 * The latest appended applicable user decision wins; all identity hits remain visible for review.
 * @param track - Catalogue ID and/or measured content hash, not the mutable display name.
 * @param project - Freshly read feedback.
 * @param contextTags - Current explicit scene tags. All feedback tags must be present to apply.
 * @returns Auditable history, applicable decision and its reason; a rejection is advisory ranking only.
 */
export function musicPreferenceFor(track: { track_id?: string; source_sha256?: string }, project: ProjectMusicFeedback,
  contextTags: string[]): Record<string, JsonValue> {
  const hits = project.records.filter(row => (row.track_id !== undefined && row.track_id === track.track_id)
    || (row.source_sha256 !== undefined && track.source_sha256 !== undefined && hash(row.source_sha256) === hash(track.source_sha256)))
  const applicable = hits.filter(row => row.context_tags.every(tag => contextTags.includes(tag)))
  const latest = applicable.at(-1)
  const history = hits.slice(-8).map(row => displayFeedback(row, applicable.includes(row)))
  // Include recent audit context, not repeated multi-megabyte quotes in every candidate.
  while (history.length > 1 && Buffer.byteLength(JSON.stringify(history), 'utf8') > 8192) history.shift()
  return { decision: latest?.decision ?? 'unreviewed',
    ...(latest === undefined ? {} : { feedback_id: excerpt(latest.feedback_id, 128), reason: excerpt(latest.reason),
      recorded_at: excerpt(latest.recorded_at, 64), decision_display_truncated: latest.reason !== excerpt(latest.reason)
        || latest.feedback_id !== excerpt(latest.feedback_id, 128) || latest.recorded_at !== excerpt(latest.recorded_at, 64) }),
    history_count: hits.length, history_truncated: history.length < hits.length,
    history_display_truncated: history.some(row => row.display_truncated === true), history }
}
