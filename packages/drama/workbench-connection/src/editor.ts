/** Validation of the Workshop draft editor's HTTP requests and responses. @module */
import { HarnessError } from '@deepseek-ai/dsh-error'
import { isRecord } from './http.ts'
import type { ScriptDraft, ScriptDraftCandidate, ScriptDraftEpisode, ScriptDraftEpisodeRequest, ScriptDraftList, ScriptDraftListRequest, ScriptDraftSummary } from './editor-types.ts'

function invalid(): HarnessError {
  return new HarnessError('剧本工坊返回了无法识别的草稿数据。', 'WORKSHOP_EDITOR_INVALID_RESULT')
}

function item(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid()
  return value
}

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw invalid()
  return value
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw invalid()
  return value
}

function array<T>(value: unknown, max: number, decode: (element: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw invalid()
  return value.map(decode)
}

function revision(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalid()
  return value
}

function draft(value: unknown): ScriptDraftSummary {
  const row = item(value)
  return {
    id: integer(row.id, 1),
    title: text(row.title, 1_000),
    status: text(row.status, 100),
    episodeCount: integer(row.episodeCount),
    updatedAt: row.updatedAt === null ? null : text(row.updatedAt, 64),
  }
}

/** Decode an authorized page of draft cards.
 * @param value - HTTP reply.
 * @returns Draft cards and the next offset, if present.
 */
export function editorDraftList(value: unknown): ScriptDraftList {
  const row = item(value)
  return { items: array(row.items, 100, draft), nextOffset: row.nextOffset === null ? null : integer(row.nextOffset, 1) }
}

/** Decode an open draft and its editing context.
 * @param value - HTTP reply.
 * @returns Draft, episodes and the publication revision.
 */
export function editorDraft(value: unknown): ScriptDraft {
  const row = item(value)
  const context = item(row.context)
  if (typeof row.canFinalize !== 'boolean') throw invalid()
  return {
    ...draft(row),
    revision: revision(row.revision),
    canFinalize: row.canFinalize,
    episodes: array(row.episodes, 1_000, (element) => {
      const episode = item(element)
      return { episode: integer(episode.episode, 1), title: text(episode.title, 1_000) }
    }),
    context: {
      outline: context.outline === null ? null : JSON.stringify(item(context.outline)),
      storyBible: context.storyBible === null ? null : JSON.stringify(item(context.storyBible)),
    },
  }
}

/** Decode a pending episode revision.
 * @param value - HTTP reply.
 * @returns A proposal with its original revision.
 */
export function editorCandidate(value: unknown): ScriptDraftCandidate {
  const row = item(value)
  return {
    id: text(row.id, 64), baseRevision: revision(row.baseRevision),
    content: text(row.content, 120_000), summary: text(row.summary, 2_000), createdAt: text(row.createdAt, 64),
  }
}

/** Decode an episode and check that it belongs to the requested draft and ordinal.
 * @param value - HTTP reply.
 * @param request - Draft and episode requested.
 * @returns The saved episode and pending review.
 */
export function editorEpisode(value: unknown, request: ScriptDraftEpisodeRequest): ScriptDraftEpisode {
  const row = item(value)
  if (row.draftId !== request.draftId || row.episode !== request.episode) throw invalid()
  return {
    draftId: request.draftId, episode: request.episode, title: text(row.title, 1_000),
    revision: revision(row.revision), version: integer(row.version), content: text(row.content, 120_000),
    candidate: row.candidate === null ? null : editorCandidate(row.candidate),
  }
}

function requestError(): HarnessError {
  return new HarnessError('草稿编号、集数或分页参数无效。', 'WORKSHOP_EDITOR_INVALID_REQUEST')
}

/** Create a fixed Workshop editor draft path.
 * @param id - Numeric Workshop draft identifier.
 * @returns The draft path below the authenticated API.
 */
export function editorDraftPath(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) throw requestError()
  return '/script-editor/drafts/' + String(id)
}

/** Create a fixed Workshop editor episode path.
 * @param request - Draft and episode IDs.
 * @returns The episode path below the authenticated API.
 */
export function editorEpisodePath(request: ScriptDraftEpisodeRequest): string {
  if (!Number.isSafeInteger(request.episode) || request.episode < 1) throw requestError()
  return editorDraftPath(request.draftId) + '/episodes/' + String(request.episode)
}

/** Create a bounded draft search query and URL.
 * @param request - Draft search and pagination.
 * @returns The draft collection path and sanitized query.
 */
export function editorListPath(request: ScriptDraftListRequest): string {
  if (!Number.isSafeInteger(request.offset) || request.offset < 0 ||
    !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100 ||
    (request.query !== undefined && request.query.length > 100)) throw requestError()
  const query = new URLSearchParams({ offset: String(request.offset), limit: String(request.limit) })
  if (request.query !== undefined && request.query.trim()) query.set('query', request.query.trim())
  return '/script-editor/drafts?' + query.toString()
}
