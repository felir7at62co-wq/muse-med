/** Script Workshop connection for the signed-in Muse account, and the session core shared with Jingliu. @module */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { workbenchOrigin } from './http.ts'
import { WorkbenchSessions } from './sessions.ts'
import type { WorkbenchDefinition, WorkbenchSession } from './sessions.ts'
import { scriptDetail, scriptList, scriptOf } from './scripts.ts'
import type { ScriptDetail, ScriptList, ScriptListRequest, ScriptPickRequest, ScriptProductionRequest, ScriptReadRequest, ScriptSummary } from './types.ts'

export { boundedBytes, isRecord, requestJson, workbenchOrigin, WorkbenchHttpError } from './http.ts'
export type { TransportRequest, WorkbenchLabel, WorkbenchRequest } from './http.ts'
export { WorkbenchSessions } from './sessions.ts'
export type { WorkbenchDefinition, WorkbenchDeployment, WorkbenchSession } from './sessions.ts'
export { scriptDetail, scriptList, scriptOf, scriptSummary } from './scripts.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workshopConnection: WorkshopConnection
  }
}

/** Script Workshop as a Muse workbench: its `/v1` API, the `jubengongfang` gateway mount and its JWT sign-in response. */
export const SCRIPT_WORKSHOP: WorkbenchDefinition = {
  audience: 'script-workshop', name: '剧本工坊', code: 'WORKSHOP', mount: 'jubengongfang', api: '/v1',
  credential: 'access_token', profileUser: profile => profile,
  changed: '剧本工坊连接已变更。请核对原账号下已提交的任务。',
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
 * Opens Script Workshop sessions as the signed-in Muse user and serves the Client's 剧本 tab from the finalized-script
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
}

export default WorkshopConnection
