/** Script Workshop connection for the signed-in Muse account, and the session core shared with Jingliu. @module */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { principalOf, Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import {
  editorCandidate, editorDraft, editorDraftList, editorDraftPath, editorEpisode, editorEpisodePath,
  editorExport, editorExportPath, editorHistory, editorHistoryEntry, editorHistoryPath, editorListPath, editorRestore, editorStoryboard,
} from './editor.ts'
import { workbenchOrigin } from './http.ts'
import type { WorkbenchRequest } from './http.ts'
import { WorkbenchSessions } from './sessions.ts'
import type { WorkbenchSession } from './sessions.ts'
import { scriptDetail, scriptList, scriptOf } from './scripts.ts'
import { SCRIPT_WORKSHOP } from './workshop.ts'
import type { ScriptDetail, ScriptList, ScriptListRequest, ScriptPickRequest, ScriptProductionRequest, ScriptReadRequest, ScriptSummary } from './types.ts'
import type {
  ScriptDraft, ScriptDraftCandidate, ScriptDraftCandidateRequest, ScriptDraftCreateRequest, ScriptDraftEpisode, ScriptDraftEpisodeRequest,
  ScriptDraftExport, ScriptDraftExportRequest, ScriptDraftFinalizeRequest, ScriptDraftHistory, ScriptDraftHistoryEntry,
  ScriptDraftHistoryEntryRequest, ScriptDraftHistoryRequest, ScriptDraftHistoryRestore, ScriptDraftHistoryRestoreRequest,
  ScriptDraftList, ScriptDraftListRequest, ScriptDraftRequest, ScriptDraftSaveRequest, ScriptDraftStageRequest,
  ScriptDraftStoryboard, ScriptDraftStoryboardSaveRequest,
} from './editor-types.ts'

export { WorkbenchHttpError } from './http.ts'
export type { TransportRequest, WorkbenchLabel, WorkbenchRequest } from './http.ts'
export type { WorkbenchDefinition, WorkbenchDeployment, WorkbenchSession } from './sessions.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workshopConnection: WorkshopConnection
  }
}

/** Server address and limits for this installation, after `WorkshopConnection.Config` applied its defaults. */
export interface Config {
  /**
   * HTTPS or loopback Workshop origin, or `<Muse gateway>/jubengongfang` for the deployment served by the gateway.
   * An absent origin leaves the connection unconfigured.
   */
  workshopOrigin?: string
  /** Maximum time in milliseconds for one JSON request, including its response body. */
  timeoutMs: number
}

/**
 * Opens Script Workshop sessions as the signed-in Muse user and serves the Client's draft editor and finalized-script
 * library; native tokens never reach model input or output.
 */
export class WorkshopConnection extends TypertRemoteService {
  static Config = z.object({
    workshopOrigin: z.string(),
    timeoutMs: z.number().min(1).max(120000).step(1).default(30000),
  })

  private readonly sessions: WorkbenchSessions

  /** @param ctx - Muse Host context.
   * @param config - Workshop deployment and transport configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'workshopConnection')
    const origin = config.workshopOrigin ? workbenchOrigin(config.workshopOrigin, SCRIPT_WORKSHOP.mount, SCRIPT_WORKSHOP) : undefined
    this.sessions = new WorkbenchSessions(ctx, SCRIPT_WORKSHOP, { origin, timeoutMs: config.timeoutMs })
  }

  /** Resolve the active Muse account on the configured Workshop.
   * @returns A session bound to this Muse login and Workshop user.
   */
  async connection(): Promise<WorkbenchSession> {
    return await this.sessions.connection()
  }

  /**
   * One page of the finalized-script library, which every signed-in member can read.
   * @param request - Stage filter, title search, own scripts only, and page.
   * @returns The page, counts per stage for the same search, and whether this member may pick.
   */
  @Remote('scripts')
  async scripts(request: ScriptListRequest): Promise<ScriptList> {
    const query = new URLSearchParams({ page: String(request.page), limit: String(request.limit) })
    if (request.status !== undefined) query.set('status', request.status)
    if (request.q !== undefined && request.q.trim() !== '') query.set('q', request.q.trim())
    if (request.mine === true) query.set('mine', 'true')
    return scriptList(await (await this.connection()).request('/script-library?' + query.toString()))
  }

  /**
   * One script with its versions and the text of one version.
   * @param request - Script and optional version; the latest when omitted.
   * @returns The script, its versions and that version's episodes.
   */
  @Remote('script')
  async script(request: ScriptReadRequest): Promise<ScriptDetail> {
    const query = request.version === undefined ? '' : '?version=' + String(request.version)
    return scriptDetail(await (await this.connection()).request('/script-library/' + String(request.id) + query))
  }

  /**
   * Pick one version for production; the Workshop refuses members without the pick permission.
   * @param request - Script and version.
   * @returns The script's card after the pick.
   */
  @Remote('pickScript')
  async pickScript(request: ScriptPickRequest): Promise<ScriptSummary> {
    return scriptOf(await (await this.connection()).request('/script-library/' + String(request.id) + '/pick', {
      method: 'POST', body: { version: request.version } }))
  }

  /**
   * Record the Jingliu project a picked script became.
   * @param request - Script and the project's ID and title.
   * @returns The script's card, now in production.
   */
  @Remote('scriptProduction')
  async scriptProduction(request: ScriptProductionRequest): Promise<ScriptSummary> {
    return scriptOf(await (await this.connection()).request('/script-library/' + String(request.id) + '/production', {
      method: 'POST', body: { project_id: request.projectId, project_title: request.projectTitle } }))
  }

  private async editorRequest(path: string, options?: WorkbenchRequest): Promise<unknown> {
    if (principalOf(this.ctx.invocation) !== undefined) {
      throw new HarnessError('只有当前 Muse 账号的所有者可以编辑剧本草稿。', 'WORKSHOP_EDITOR_OWNER_REQUIRED')
    }
    return await (await this.connection()).request(path, options)
  }

  /** List accessible draft cards for the signed-in editor.
   * @param request - Search and page.
   * @returns Drafts and the next offset.
   */
  @Remote
  async scriptDrafts(request: ScriptDraftListRequest): Promise<ScriptDraftList> {
    return editorDraftList(await this.editorRequest(editorListPath(request)))
  }

  /** Create a blank draft or import an existing file into this editor's draft library.
   * @param request - Title, episodes or file, and an optional retry identifier.
   * @returns The new draft and its initial episodes.
   */
  @Remote
  async createScriptDraft(request: ScriptDraftCreateRequest): Promise<ScriptDraft> {
    return editorDraft(await this.editorRequest('/script-editor/drafts', { method: 'POST', body: request }))
  }

  /** Read a draft's editable episodes and context.
   * @param request - Draft to open.
   * @returns Episode directory, context, and publication revision.
   */
  @Remote
  async scriptDraft(request: ScriptDraftRequest): Promise<ScriptDraft> {
    return editorDraft(await this.editorRequest(editorDraftPath(request.draftId)))
  }

  /** Read the saved text of one episode and the editor's pending candidate.
   * @param request - Draft and episode to open.
   * @returns The saved text, revision and candidate if present.
   */
  @Remote
  async scriptDraftEpisode(request: ScriptDraftEpisodeRequest): Promise<ScriptDraftEpisode> {
    return editorEpisode(await this.editorRequest(editorEpisodePath(request)), request)
  }

  /** Stage one chat-generated candidate for human review.
   * @param request - Exact base revision, proposed episode text and summary.
   * @param signal - Cancellation of the tool call.
   * @returns The pending candidate.
   */
  async stageScriptDraftCandidate(request: ScriptDraftStageRequest, signal?: AbortSignal): Promise<ScriptDraftCandidate> {
    const { baseRevision, content, summary } = request
    return editorCandidate(await this.editorRequest(editorEpisodePath(request) + '/candidates', {
      method: 'POST', body: { baseRevision, content, summary }, ...(signal === undefined ? {} : { signal }),
    }))
  }

  /** Apply the exact candidate reviewed in the editor.
   * @param request - Episode and candidate ID.
   * @returns The newly saved episode.
   */
  @Remote
  async applyScriptDraftCandidate(request: ScriptDraftCandidateRequest): Promise<ScriptDraftEpisode> {
    return editorEpisode(await this.editorRequest(editorEpisodePath(request) + '/apply', {
      method: 'POST', body: { candidateId: request.candidateId },
    }), request)
  }

  /** Discard the exact pending candidate without editing the saved episode.
   * @param request - Episode and candidate ID.
   * @returns The saved episode.
   */
  @Remote
  async discardScriptDraftCandidate(request: ScriptDraftCandidateRequest): Promise<ScriptDraftEpisode> {
    return editorEpisode(await this.editorRequest(editorEpisodePath(request) + '/discard', {
      method: 'POST', body: { candidateId: request.candidateId },
    }), request)
  }

  /** Save a manual edit to one episode.
   * @param request - Episode, displayed revision, and updated text.
   * @returns The saved episode.
   */
  @Remote
  async saveScriptDraftEpisode(request: ScriptDraftSaveRequest): Promise<ScriptDraftEpisode> {
    return editorEpisode(await this.editorRequest(editorEpisodePath(request), {
      method: 'PATCH', body: { baseRevision: request.baseRevision, content: request.content },
    }), request)
  }

  /** Read the structured screenplay stored separately from an episode's source text.
   * @param request - Draft and episode to open.
   * @returns The structured screenplay, its revision, and whether it needs review after a source edit.
   */
  @Remote
  async scriptDraftStoryboard(request: ScriptDraftEpisodeRequest): Promise<ScriptDraftStoryboard> {
    return editorStoryboard(await this.editorRequest(editorEpisodePath(request) + '/storyboard'), request)
  }

  /** Save the structured screenplay displayed by the editor.
   * @param request - Episode, displayed revision, and updated screenplay.
   * @returns The saved structured screenplay.
   */
  @Remote
  async saveScriptDraftStoryboard(request: ScriptDraftStoryboardSaveRequest): Promise<ScriptDraftStoryboard> {
    return editorStoryboard(await this.editorRequest(editorEpisodePath(request) + '/storyboard', {
      method: 'PATCH', body: { baseRevision: request.baseRevision, shotsJson: request.shotsJson },
    }), request)
  }

  /** List the saved versions of one episode and layer.
   * @param request - Episode and layer to inspect.
   * @returns Version metadata.
   */
  @Remote
  async scriptDraftHistory(request: ScriptDraftHistoryRequest): Promise<ScriptDraftHistory> {
    const query = new URLSearchParams({ layer: request.layer })
    return editorHistory(await this.editorRequest(editorHistoryPath(request) + '?' + query.toString()))
  }

  /** Read the exact historical version selected by the editor.
   * @param request - Episode, layer, and history entry.
   * @returns The selected historical content.
   */
  @Remote
  async scriptDraftHistoryEntry(request: ScriptDraftHistoryEntryRequest): Promise<ScriptDraftHistoryEntry> {
    const query = new URLSearchParams({ layer: request.layer })
    return editorHistoryEntry(await this.editorRequest(editorHistoryPath(request) + '?' + query.toString()), request.historyId)
  }

  /** Restore a historical version as a new revision.
   * @param request - Historical entry and the current revision reviewed by the editor.
   * @returns The restored episode layer.
   */
  @Remote
  async restoreScriptDraftHistory(request: ScriptDraftHistoryRestoreRequest): Promise<ScriptDraftHistoryRestore> {
    return editorRestore(await this.editorRequest(editorHistoryPath(request) + '/restore', {
      method: 'POST', body: { layer: request.layer, baseRevision: request.baseRevision },
    }), request)
  }

  /** Download an authorized export of the saved draft or selected episode.
   * @param request - Content scope and format.
   * @returns Download metadata and file bytes encoded for the Client.
   */
  @Remote
  async exportScriptDraft(request: ScriptDraftExportRequest): Promise<ScriptDraftExport> {
    return editorExport(await this.editorRequest(editorExportPath(request)))
  }

  /** Publish a reviewed draft revision to the finalized library.
   * @param request - Draft, revision, and publication metadata reviewed by the user.
   * @returns The finalized library card.
   */
  @Remote
  async finalizeScriptDraft(request: ScriptDraftFinalizeRequest): Promise<ScriptSummary> {
    const { draftId, ...body } = request
    return scriptOf(await this.editorRequest(editorDraftPath(draftId) + '/finalize', { method: 'POST', body }))
  }
}

export default WorkshopConnection
