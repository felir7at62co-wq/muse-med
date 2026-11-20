/** Script Workshop connection for the signed-in Muse account, and the session core shared with Jingliu. @module */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { workbenchOrigin } from './http.ts'
import { WorkbenchSessions } from './sessions.ts'
import type { WorkbenchDefinition, WorkbenchSession } from './sessions.ts'

export { boundedBytes, isRecord, requestJson, workbenchOrigin, WorkbenchHttpError } from './http.ts'
export type { TransportRequest, WorkbenchLabel, WorkbenchRequest } from './http.ts'
export { WorkbenchSessions } from './sessions.ts'
export type { WorkbenchDefinition, WorkbenchDeployment, WorkbenchSession } from './sessions.ts'

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

/** Opens Script Workshop sessions as the signed-in Muse user; native tokens never reach model input or output. */
export class WorkshopConnection extends Service {
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
}

export default WorkshopConnection
