/** Validation of the Workshop draft editor's HTTP requests and responses. @module */
import { HarnessError } from '@deepseek-ai/dsh-error'
import { isRecord } from './http.ts'
import type {
  ScriptDraft, ScriptDraftCandidate, ScriptDraftEpisode, ScriptDraftEpisodeRequest, ScriptDraftExport,
  ScriptDraftExportRequest, ScriptDraftHistory, ScriptDraftHistoryEntry, ScriptDraftHistoryEntryRequest,
  ScriptDraftHistoryItem, ScriptDraftHistoryRequest, ScriptDraftHistoryRestore, ScriptDraftList,
  ScriptDraftListRequest, ScriptDraftStoryboard, ScriptDraftSummary,
} from './editor-types.ts'

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

/** Decode the structured screenplay for one requested episode.
 * @param value - Workshop result.
 * @param request - Exact draft and episode being read or saved.
 * @returns The current structured screenplay with its revision.
 */
export function editorStoryboard(value: unknown, request: ScriptDraftEpisodeRequest): ScriptDraftStoryboard {
  const row = item(value)
  if (row.draftId !== request.draftId || row.episode !== request.episode ||
    typeof row.exists !== 'boolean' || typeof row.stale !== 'boolean') throw invalid()
  return {
    draftId: request.draftId, episode: request.episode, title: text(row.title, 1_000),
    shotsJson: text(row.shotsJson, 4_000_000), version: integer(row.version), revision: revision(row.revision),
    exists: row.exists, stale: row.stale,
  }
}

function historyItem(value: unknown): ScriptDraftHistoryItem {
  const row = item(value)
  return {
    id: integer(row.id, 1),
    version: integer(row.version),
    createdAt: row.createdAt === null ? null : text(row.createdAt, 64),
    createdBy: row.createdBy === null ? null : text(row.createdBy, 1_000),
  }
}

/** Decode metadata for one episode layer's historical versions.
 * @param value - Workshop result.
 * @returns The available versions.
 */
export function editorHistory(value: unknown): ScriptDraftHistory {
  return { items: array(item(value).items, 1_000, historyItem) }
}

/** Decode the historical version selected by the editor.
 * @param value - Workshop result.
 * @param historyId - Expected historical version ID.
 * @returns The content and metadata of that version.
 */
export function editorHistoryEntry(value: unknown, historyId: number): ScriptDraftHistoryEntry {
  const row = item(value)
  const info = historyItem(row)
  if (info.id !== historyId) throw invalid()
  return { ...info, content: text(row.content, 4_000_000) }
}

/** Decode one restored episode layer.
 * @param value - Workshop result.
 * @param request - The expected draft, episode, and layer.
 * @returns Exactly the requested restored layer.
 */
export function editorRestore(value: unknown, request: ScriptDraftHistoryRequest): ScriptDraftHistoryRestore {
  const row = item(value)
  if (request.layer === 'chapter') {
    if (row.storyboard !== null) throw invalid()
    return { episode: editorEpisode(row.episode, request), storyboard: null }
  }
  if (row.episode !== null) throw invalid()
  return { episode: null, storyboard: editorStoryboard(row.storyboard, request) }
}

/** Build a history path for an episode and, when requested, one historical version.
 * @param request - The target episode and optional history ID.
 * @returns The route before its query parameters.
 */
export function editorHistoryPath(request: ScriptDraftHistoryRequest | ScriptDraftHistoryEntryRequest): string {
  const base = editorEpisodePath(request) + '/history'
  if (!('historyId' in request)) return base
  if (!Number.isSafeInteger(request.historyId) || request.historyId < 1) throw requestError()
  return base + '/' + String(request.historyId)
}

/** Build the authenticated export route for the target draft and format.
 * @param request - Content and encoding to export.
 * @returns The export route including its query parameters.
 */
export function editorExportPath(request: ScriptDraftExportRequest): string {
  const query = new URLSearchParams({ kind: request.kind, format: request.format })
  if (request.episode !== undefined) {
    if (!Number.isSafeInteger(request.episode) || request.episode < 1) throw requestError()
    query.set('episode', String(request.episode))
  }
  return editorDraftPath(request.draftId) + '/export?' + query.toString()
}

/** Decode a downloadable draft export.
 * @param value - Workshop result.
 * @returns The file name, type, and encoded bytes.
 */
export function editorExport(value: unknown): ScriptDraftExport {
  const row = item(value)
  const filename = text(row.filename, 1_000)
  const mime = text(row.mime, 200)
  const base64 = text(row.base64, 14_000_000)
  if (filename === '' || /[\\/\p{Cc}]/u.test(filename) || !/^[\w.+-]+\/[\w.+-]+(?:;\s*charset=utf-8)?$/iu.test(mime) ||
    base64 === '' || base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(base64) || /=/.test(base64.slice(0, -2))) throw invalid()
  return { filename, mime, base64 }
}
