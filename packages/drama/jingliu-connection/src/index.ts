/** Authenticated access to the ShotFlow project and workflow gateway. */
import { EventEmitter, on } from 'node:events'
import { readSelection, storeSelection } from './project-selection.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SelectedProject } from './types.ts'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { balance, library, options, preferences, projectPath, projects } from './browser.ts'
import type { StudioBalance, StudioLibrary, StudioLibraryQuery, StudioOptions, StudioPreferences, StudioProject, StudioSetting } from './types.ts'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-muse-account'
import { WorkbenchSessions } from '@deepseek-ai/dsh-workbench-connection'
import type { WorkbenchDefinition, WorkbenchSession } from '@deepseek-ai/dsh-workbench-connection'
import type {} from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { boundedBytes, isRecord, JINGLIU, JingliuHttpError, mediaUrl, studioOrigin } from './http.ts'
import type { JingliuRequest } from './http.ts'

export { JingliuHttpError, boundedBytes }
export type { JingliuRequest }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Host-confirmed cloud project associated with this local conversation. @persistenceAttribution */
    'jingliu-project': { kind: 'jingliu-project'; form: 'notice'; summary: string }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    jingliuConnection: JingliuConnection
  }
}

/** Limits and server address for this installation. */
export interface Config {
  /** HTTPS studio origin or HTTP loopback origin used for the ShotFlow API. */
  studioOrigin?: string
  /** Maximum time in milliseconds for one JSON request, including its response body. */
  timeoutMs?: number
  /** Read the isolated test session from the Host environment on a loopback deployment. */
  localPreviewToken?: boolean
}

/** One verified user of a specific Jingliu deployment. */
export interface JingliuSession {
  readonly identity: string
  /** Read a file returned by the studio and verify its owner upon completion. */
  media?(path: string, signal: AbortSignal, consume: (response: Response) => Promise<void>): Promise<void>
  /** Request a service route as the same user.
   * @param path - Route relative to the deployment's V2 API.
   * @param options - Method, payload and optional cancellation signal.
   * @returns The parsed service response.
   */
  request(path: string, options?: JingliuRequest): Promise<unknown>
}

/** Jingliu as a Muse workbench: the ShotFlow V2 API, the `jingliu` gateway mount and its studio session token. */
const STUDIO: WorkbenchDefinition = {
  ...JINGLIU, audience: 'jingliu', mount: 'jingliu', api: '/fwp/v2', credential: 'token', profileUser: profile => profile.user,
  changed: '镜流工具连接已变更。请核对原账号下已提交的操作，并重新选择项目。',
}

/** Resolves user grants at execution time, keeping tokens outside model input and output. */
export class JingliuConnection extends TypertRemoteService {
  static inject = ['commands']
  static Config = z.object({
    studioOrigin: z.string(),
    timeoutMs: z.number().min(1).max(120000).step(1).default(30000),
    localPreviewToken: z.boolean().default(false),
  })

  private readonly origin: string | undefined
  private readonly changes = new EventEmitter().setMaxListeners(0)
  private readonly sessions: WorkbenchSessions
  private readonly timeoutMs: number
  private readonly studios = new WeakMap<WorkbenchSession, JingliuSession>()

  /** @param ctx - Muse host context.
   * @param config - Jingliu deployment and transport configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'jingliuConnection')
    this.origin = config.studioOrigin ? studioOrigin(config.studioOrigin) : undefined
    const preview = config.localPreviewToken === true
    this.timeoutMs = config.timeoutMs ?? 30_000
    if (preview && (!this.origin || !['127.0.0.1', '[::1]'].includes(new URL(this.origin).hostname))) {
      throw new HarnessError('本机预览凭据只能用于回环服务。', 'JINGLIU_PREVIEW_ORIGIN_INVALID')
    }
    this.sessions = new WorkbenchSessions(ctx, STUDIO, {
      origin: this.origin, timeoutMs: this.timeoutMs,
      ...(preview && { previewToken: () => process.env.MUSE_JINGLIU_SESSION_TOKEN }),
    }, () => this.changes.emit('account'))
    if (!this.origin || preview) return
    const command = (name: string, description: string, run: (signal: AbortSignal) => Promise<string>) => {
      ctx.effect(() => ctx.commands.register({
        name, description, definitionId: CommandDefinitionId('@deepseek-ai/dsh-jingliu-connection/' + name), recordInput: false,
        handler: async ({ rawInput, signal }) => {
          if (rawInput.trim()) return { kind: 'error', text: '该命令无需输入参数。' }
          signal.throwIfAborted()
          return { kind: 'success', text: await run(signal) }
        },
      }), name)
    }
    command('jingliu-login', '检查当前 Muse 账号的镜流连接', async (signal) => {
      await this.connection()
      signal.throwIfAborted()
      return '已使用当前 Muse 账号连接镜流。'
    })
    command('jingliu-logout', '结束当前镜流工具连接', async (signal) => {
      await this.sessions.disconnect(signal)
      return '本次镜流工具连接已结束。下次调用会使用当前 Muse 账号。'
    })
  }

  private studio(session: WorkbenchSession): JingliuSession {
    let studio = this.studios.get(session)
    if (studio) return studio
    studio = {
      identity: session.identity,
      media: async (path: string, signal: AbortSignal, consume: (response: Response) => Promise<void>) => {
        await session.check()
        const response = await session.fetch(mediaUrl(session.origin, path), { method: 'GET', signal })
        if (!response.ok) {
          await response.body?.cancel()
          throw new JingliuHttpError(response.status, 'JINGLIU_MEDIA_UNAVAILABLE', '镜流素材暂时无法读取。')
        }
        try { await consume(response) }
        finally { if (!response.bodyUsed) await response.body?.cancel() }
        await session.check()
      },
      request: (path: string, options?: JingliuRequest) => session.request(path, options),
    }
    this.studios.set(session, studio)
    return studio
  }

  /** Resolve the active account on the selected deployment.
   * @returns A transport bound to this Muse login and Jingliu user.
   */
  async connection(): Promise<JingliuSession> {
    return this.studio(await this.sessions.connection())
  }

  /**
   * Find the project associated with this conversation and owner.
   * @param sessionId - Actual Muse conversation.
   * @param identity - Verified studio user.
   * @returns Its matching cloud selection.
   */
  async selected(sessionId: string, identity: string): Promise<SelectedProject | null> {
    const saved = await readSelection(sessionId)
    return saved?.owner === identity ? { id: saved.id, title: saved.title } : null
  }

  /**
   * Capture the signed-in production for an execution assignment.
   * @param sessionId - Routing conversation.
   * @returns Its confirmed project and current studio owner for a worker assignment.
   */
  async assignmentProject(sessionId: SessionId): Promise<(SelectedProject & { owner: string }) | null> {
    const saved = await readSelection(sessionId)
    if (!saved) return null
    return saved.owner === (await this.connection()).identity ? saved : null
  }

  /**
   * Bind the worker to the production captured by its Router.
   * @param worker - Worker receiving a recorded assignment.
   * @param project - Project selected when the user delegated the work.
   */
  async inheritProject(worker: SessionId, project: SelectedProject & { owner: string }): Promise<void> {
    const saved = await readSelection(worker)
    if ((await this.connection()).identity !== project.owner || (saved && (saved.id !== project.id || saved.owner !== project.owner))) {
      throw new HarnessError('执行会话的镜流账号或项目已改变，请选择同项目的会话。', 'JINGLIU_INVALID_PROJECT')
    }
    if (!saved) {
      await storeSelection(worker, project.owner, { id: project.id, title: project.title })
      this.changes.emit(worker)
    }
  }

  /**
   * Confirm a production for a local conversation and notify its Agent.
   * @param sessionId - Conversation shown to the user.
   * @param projectId - Project explicitly confirmed.
   * @param signal - User action lifetime.
   * @returns The native project title and ID.
   */
  @Remote
  async selectProject(sessionId: SessionId, projectId: string, signal: AbortSignal): Promise<SelectedProject> {
    const session = await this.connection()
    const result = await session.request(projectPath(projectId), { signal })
    if (!isRecord(result) || result.id !== projectId || typeof result.title !== 'string') throw new HarnessError('镜流项目不可用。', 'JINGLIU_INVALID_PROJECT')
    const controller = this.ctx.get('sessionController')
    if (!controller) throw new HarnessError('当前会话不可用。', 'JINGLIU_SESSION_REQUIRED')
    const resolved = await controller.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    signal.throwIfAborted()
    const project = { id: projectId, title: result.title }
    if ((await this.connection()) !== session) throw this.sessions.changed()
    await storeSelection(sessionId, session.identity, project)
    if ((await this.connection()) !== session) throw this.sessions.changed()
    this.changes.emit(sessionId)
    resolved.agent.inject(createUserMessage({ source: { kind: 'jingliu-project', form: 'notice', summary: '已关联镜流制片项目' },
      content: [{ type: 'text', text: JSON.stringify({ jingliu_project: project, instruction: '用户确认了这个云制片项目。后续制片工作和审校使用此项目 ID，本机会话的文件夹独立。' }) }] }))
    return project
  }

  /**
   * Follow the production shown beside one conversation.
   * @param sessionId - Right sidebar's Session.
   * @param signal - Subscription lifetime.
   * @returns This Session's initial and updated project selection.
   */
  @Remote({ mode: 'stream' })
  async *watchProject(sessionId: SessionId, signal: AbortSignal): AsyncIterable<SelectedProject | null> {
    const closed = AbortSignal.any([signal, this.sessions.signal])
    const updates = new EventEmitter()
    const changed = () => updates.emit('change')
    this.changes.on(sessionId, changed).on('account', changed)
    const frames = on(updates, 'change', { signal: closed })
    try {
      do {
        const saved = await readSelection(sessionId)
        if (!saved) yield null
        else {
          const current = await this.connection()
          yield saved.owner === current.identity ? { id: saved.id, title: saved.title } : null
        }
      } while (!(await frames.next()).done)
    } catch (error) { if (!closed.aborted) throw error }
    finally { this.changes.off(sessionId, changed).off('account', changed); await frames.return?.() }
  }

  /**
   * List productions the current studio account can access.
   * @param signal - Panel cancellation.
   * @returns Projects visible to the signed-in studio user.
   */
  @Remote
  async listProjects(signal: AbortSignal): Promise<StudioProject[]> {
    return projects(await (await this.connection()).request('/projects', { signal }))
  }

  /**
   * Read the shared media catalog as the current studio user.
   * @param query - Filter and page offset for the shared library.
   * @param signal - Panel cancellation.
   * @returns A native catalog page.
   */
  @Remote
  async sharedAssets(query: StudioLibraryQuery, signal: AbortSignal): Promise<StudioLibrary> {
    if (!Number.isSafeInteger(query.offset) || query.offset < 0 || query.query.length > 200) throw new HarnessError('素材筛选无效。', 'JINGLIU_INVALID_ARGUMENTS')
    const params = new URLSearchParams({ limit: '24', offset: String(query.offset), q: query.query })
    if (query.kind !== 'all') params.set('kind', query.kind)
    return library(await (await this.connection()).request('/library?' + params.toString(), { signal }))
  }

  /**
   * Load a bounded thumbnail without exposing the studio credential.
   * @param path - Native thumbnail path in the current library.
   * @param signal - Panel cancellation.
   * @returns A preview image for this account.
   */
  @Remote
  async thumbnail(path: string, signal: AbortSignal): Promise<string> {
    const session = await this.connection()
    let image = ''
    await session.media?.(path, AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]), async (response) => {
      const type = response.headers.get('content-type')?.split(';')[0]
      if (!type || !['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(type)) throw new HarnessError('镜流素材没有可显示的缩略图。', 'JINGLIU_INVALID_MEDIA')
      image = 'data:' + type + ';base64,' + (await boundedBytes(response, 8 * 1024 * 1024)).toString('base64')
    })
    return image
  }

  /**
   * Read the current account allowance and usage.
   * @param signal - Panel cancellation.
   * @returns The current Jingliu account allowance.
   */
  @Remote
  async balance(signal: AbortSignal): Promise<StudioBalance> {
    return balance(await (await this.connection()).request('/budget/me', { signal }))
  }

  /**
   * Read the native settings of one production.
   * @param projectId - Selected cloud project.
   * @param signal - Panel cancellation.
   * @returns Preferences saved by both clients.
   */
  @Remote
  async preferences(projectId: string, signal: AbortSignal): Promise<StudioPreferences> {
    return preferences(await (await this.connection()).request(projectPath(projectId) + '/prefs', { signal }), projectId)
  }

  /**
   * List available production settings and their stored values.
   * @param projectId - Selected project.
   * @param signal - Panel lifetime.
   * @returns Native model and resolution settings.
   */
  @Remote
  async projectOptions(projectId: string, signal: AbortSignal): Promise<StudioOptions> {
    const session = await this.connection()
    const base = projectPath(projectId)
    const [image, video] = await Promise.all([session.request(base + '/image-model', { signal }), session.request(base + '/resolution', { signal })])
    return options(projectId, image, video)
  }

  /**
   * Change one setting and verify the stored value.
   * @param projectId - Selected project.
   * @param key - Single field to update.
   * @param value - Model or resolution; empty uses the project default.
   * @param signal - Panel lifetime.
   * @returns Settings read back from the same project.
   */
  @Remote
  async saveOption(projectId: string, key: StudioSetting, value: string, signal: AbortSignal): Promise<StudioOptions> {
    const session = await this.connection()
    const base = projectPath(projectId)
    const current = await this.projectOptions(projectId, signal)
    const ids = key === 'resolution' ? current.resolutions : current.models.map(m => m.id)
    if (!['resolution','character','location','prop'].includes(key) || (value !== '' && !ids.includes(value))) throw new HarnessError('请选择当前项目提供的设置。', 'JINGLIU_INVALID_ARGUMENTS')
    if (key === 'resolution') await session.request(base + '/resolution', { method: 'PUT', body: { resolution: value }, signal })
    else await session.request(base + '/image-model', { method: 'PUT', body: { models: { [key]: value } }, signal })
    const fresh = await this.projectOptions(projectId, signal)
    if ((await this.connection()) !== session || fresh[key] !== value) throw new HarnessError('请刷新并核对项目设置。', 'JINGLIU_INVALID_RESULT')
    return fresh
  }

  /**
   * Update how references appear in this production.
   * @param value - Preference explicitly changed by the user.
   * @param signal - Panel cancellation.
   * @returns A verified read from the same project and account.
   */
  @Remote
  async savePreferences(value: StudioPreferences, signal: AbortSignal): Promise<StudioPreferences> {
    const session = await this.connection()
    const path = projectPath(value.projectId) + '/prefs'
    await session.request(path, { method: 'PUT', body: { prefs: { prompt_chips_hidden: value.hidePromptChips } }, signal })
    return preferences(await session.request(path, { signal }), value.projectId)
  }

}

export default JingliuConnection
