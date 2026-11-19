/** Authenticated access to the ShotFlow project and workflow gateway. */
import { EventEmitter, on } from 'node:events'
import { readSelection, storeSelection } from './project-selection.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SelectedProject } from './types.ts'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { balance, episodeList, episodeShots, library, options, preferences, projectAssets, projectConfig, projectPath, projects, shotMedia, workflowResult } from './browser.ts'
import type { StudioBalance, StudioConfig, StudioEpisode, StudioLibrary, StudioLibraryQuery, StudioOptions, StudioPreferences, StudioProject, StudioProjectAssets, StudioSetting, StudioShot, StudioShotMedia } from './types.ts'
import z from '@deepseek-ai/schemastery'
import type { MuseAccountService } from '@deepseek-ai/dsh-muse-account'
import type {} from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { boundedBytes, isRecord, JingliuHttpError, mediaUrl, requestJson, studioOrigin } from './http.ts'
import type { JingliuRequest } from './http.ts'

export { JingliuHttpError, boundedBytes }

// A shot video is a few seconds long; the bound keeps one playback request finite.
const VIDEO_MAX_BYTES = 64 * 1024 * 1024
const VIDEO_CHUNK_BYTES = 768 * 1024
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

interface ActiveConnection {
  readonly owner: string
  readonly session: Promise<JingliuSession>
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
  private readonly lifetime = new AbortController()
  private readonly changes = new EventEmitter().setMaxListeners(0)
  private readonly preview: boolean
  private readonly timeout: number
  private active: ActiveConnection | undefined

  /** @param ctx - Muse host context.
   * @param config - Jingliu deployment and transport configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'jingliuConnection')
    this.origin = config.studioOrigin ? studioOrigin(config.studioOrigin) : undefined
    this.preview = config.localPreviewToken === true
    this.timeout = config.timeoutMs ?? 30_000
    if (this.preview && (!this.origin || !['127.0.0.1', '[::1]'].includes(new URL(this.origin).hostname))) {
      throw new HarnessError('本机预览凭据只能用于回环服务。', 'JINGLIU_PREVIEW_ORIGIN_INVALID')
    }
    if (!this.origin) return
    if (!this.preview) {
      ctx.on('muse-account/session-changed', () => { this.active = undefined; this.changes.emit('account') })
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
      command('jingliu-logout', '结束当前镜流工具连接', signal => this.disconnect(signal))
    }
    ctx.effect(() => () => { this.active = undefined; this.lifetime.abort() }, 'jingliu account lifetime')
  }

  private async muse<T>(operation: (account: MuseAccountService) => Promise<T>): Promise<T> {
    const account = this.ctx.get('museAccount')
    if (!account) throw new HarnessError('请先在 Muse 的账号设置中登录。', 'JINGLIU_SIGN_IN_REQUIRED')
    try {
      return await operation(account)
    } catch (error) {
      if (isRecord(error) && error.code === 'invalid-credentials') {
        throw new HarnessError('请在 Muse 的账号设置中重新登录。', 'JINGLIU_SIGN_IN_REQUIRED', { cause: error })
      }
      throw new HarnessError('无法验证 Muse 登录状态，请检查账号服务后重试。', 'JINGLIU_MUSE_AUTH_UNAVAILABLE', { cause: error })
    }
  }

  private async owner(): Promise<string> {
    if (!this.preview) return this.muse(account => account.workbenchIdentity())
    const token = process.env.MUSE_JINGLIU_SESSION_TOKEN
    if (token) return token
    throw new HarnessError('镜流本地预览尚未配置测试会话。', 'JINGLIU_SIGN_IN_REQUIRED')
  }

  private async call(path: string, options: JingliuRequest, headers?: Record<string, string>, mountedOwner?: string): Promise<unknown> {
    const signal = options.signal === undefined ? this.lifetime.signal : AbortSignal.any([options.signal, this.lifetime.signal])
    if (!this.origin) throw new HarnessError('尚未配置镜流站点。', 'JINGLIU_UNCONFIGURED')
    const transport = mountedOwner === undefined ? undefined : (url: URL, init: RequestInit) =>
      this.muse(account => account.requestMountedJingliu(mountedOwner, url, init))
    return await requestJson(this.origin, path, this.timeout, {
      ...options, signal, ...(headers && { headers }), ...(transport && { transport }),
    })
  }

  private async exchange(path: '/auth/muse/challenge' | '/auth/muse/exchange', body?: { requestId: string; code: string }): Promise<unknown> {
    try {
      return await this.call(path, { method: 'POST', body })
    } catch (error) {
      if (!(error instanceof JingliuHttpError)) throw error
      const message = error.status === 403
        ? '镜流未授权当前 Muse 账号，请管理员核对账号绑定和角色。'
        : '镜流未能完成 Muse 登录（HTTP ' + String(error.status) + '）。'
      throw new JingliuHttpError(error.status, 'JINGLIU_MUSE_EXCHANGE_FAILED', message)
    }
  }

  private async assertOwner(owner: string): Promise<void> {
    if (owner !== await this.owner()) throw this.changed()
  }

  private changed(): HarnessError {
    return new HarnessError('镜流工具连接已变更。请核对原账号下已提交的操作，并重新选择项目。', 'JINGLIU_ACCOUNT_CHANGED')
  }

  private async authorize(owner: string): Promise<{ token: string; userId: number }> {
    let token = owner
    let profile: unknown
    if (this.origin?.endsWith('/jingliu')) {
      profile = await this.call('/auth/me', {}, undefined, owner)
    } else if (this.preview) {
      profile = await this.call('/auth/me', {}, { authorization: 'Bearer ' + token })
    } else {
      const challenge = await this.exchange('/auth/muse/challenge')
      if (!isRecord(challenge) || typeof challenge.requestId !== 'string' || !challenge.requestId ||
        typeof challenge.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(challenge.challenge)) {
        throw new HarnessError('镜流未返回有效的 Muse 登录请求。', 'JINGLIU_INVALID_CHALLENGE')
      }
      const proof = challenge.challenge
      const grant = await this.muse(account => account.workbenchGrant('jingliu', proof))
      if (grant.accountId !== owner) throw this.changed()
      await this.assertOwner(owner)
      profile = await this.exchange('/auth/muse/exchange', { requestId: challenge.requestId, code: grant.code })
      if (!isRecord(profile) || typeof profile.token !== 'string' || !profile.token) {
        throw new HarnessError('镜流未返回有效的工具连接。', 'JINGLIU_INVALID_ACCOUNT')
      }
      token = profile.token
    }
    if (!isRecord(profile) || !isRecord(profile.user) || typeof profile.user.id !== 'number' || !Number.isSafeInteger(profile.user.id)) {
      throw new HarnessError('镜流未返回有效的登录用户。', 'JINGLIU_INVALID_ACCOUNT')
    }
    await this.assertOwner(owner)
    return { token, userId: profile.user.id }
  }

  /** Resolve the active account on the selected deployment.
   * @returns A transport bound to this Muse login and Jingliu user.
   */
  async connection(): Promise<JingliuSession> {
    const origin = this.origin
    if (!origin) throw new HarnessError('请在 Muse 安装配置中选择镜流站点。', 'JINGLIU_UNCONFIGURED')
    this.lifetime.signal.throwIfAborted()
    const owner = await this.owner()
    if (this.active?.owner === owner) return this.active.session
    const session: Promise<JingliuSession> = this.authorize(owner).then(({ token, userId }) => {
      if (this.active?.session !== session) throw this.changed()
      const mounted = origin.endsWith('/jingliu')
      const headers = mounted ? undefined : { authorization: 'Bearer ' + token }
      const check = async () => {
        await this.assertOwner(owner)
        if (this.active?.session !== session) throw this.changed()
      }
      return {
        identity: createHash('sha256').update(origin + '/' + String(userId)).digest('hex'),
        media: async (path: string, signal: AbortSignal, consume: (response: Response) => Promise<void>) => {
          await check()
          const url = mediaUrl(origin, path)
          const init: RequestInit = { method: 'GET', redirect: 'error', ...(headers && { headers }), signal: AbortSignal.any([signal, this.lifetime.signal]) }
          const response = mounted ? await this.muse(account => account.requestMountedJingliu(owner, url, init)) : await fetch(url, init)
          if (!response.ok) {
            await response.body?.cancel()
            throw new JingliuHttpError(response.status, 'JINGLIU_MEDIA_UNAVAILABLE', '镜流素材暂时无法读取。')
          }
          try { await consume(response) }
          finally { if (!response.bodyUsed) await response.body?.cancel() }
          await check()
        },
        request: async (path: string, options: JingliuRequest = {}) => {
          await check()
          let response: unknown
          try {
            response = await this.call(path, options, headers, mounted ? owner : undefined)
          } catch (error) {
            await check()
            if (error instanceof JingliuHttpError && error.status === 401 && this.active?.session === session) this.active = undefined
            throw error
          }
          await check()
          return response
        },
      }
    })
    const active = { owner, session }
    this.active = active
    try {
      return await session
    } catch (error) {
      if (this.active === active) this.active = undefined
      throw error
    }
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
    if ((await this.connection()) !== session) throw this.changed()
    await storeSelection(sessionId, session.identity, project)
    if ((await this.connection()) !== session) throw this.changed()
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
    const closed = AbortSignal.any([signal, this.lifetime.signal])
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
    await session.media?.(path, AbortSignal.any([signal, AbortSignal.timeout(this.timeout)]), async (response) => {
      const type = response.headers.get('content-type')?.split(';')[0]
      if (!type || !['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(type)) throw new HarnessError('镜流素材没有可显示的缩略图。', 'JINGLIU_INVALID_MEDIA')
      image = 'data:' + type + ';base64,' + (await boundedBytes(response, 8 * 1024 * 1024)).toString('base64')
    })
    return image
  }

  /**
   * Read a project's configuration for the workbench.
   * @param projectId - Selected cloud project.
   * @param signal - Panel cancellation.
   * @returns Title, frame ratio, styles and models of the production.
   */
  @Remote
  async projectConfig(projectId: string, signal: AbortSignal): Promise<StudioConfig> {
    return projectConfig(await this.workflow('get_project', projectId, {}, signal))
  }

  /**
   * List a production's episodes.
   * @param projectId - Selected cloud project.
   * @param signal - Panel cancellation.
   * @returns Episodes in studio order.
   */
  @Remote
  async episodeList(projectId: string, signal: AbortSignal): Promise<StudioEpisode[]> {
    return episodeList(await this.workflow('list_episodes', projectId, {}, signal))
  }

  /**
   * Read every shot of one episode with its full prompt.
   * @param projectId - Selected cloud project.
   * @param episode - Episode number.
   * @param signal - Panel cancellation.
   * @returns The episode's shots in order.
   */
  @Remote
  async episodeShots(projectId: string, episode: number, signal: AbortSignal): Promise<StudioShot[]> {
    if (!Number.isSafeInteger(episode) || episode < 1) throw new HarnessError('集号无效。', 'JINGLIU_INVALID_EPISODE')
    const list = await this.workflow('list_shots', projectId, { episode, limit: 1000 }, signal)
    const rows: unknown[] = []
    let from: number | null = null
    // read_shots pages by text size; an episode rarely needs more than a few pages.
    for (let page = 0; page < 40; page += 1) {
      const result = await this.workflow('read_shots', projectId, { episode, max_shots: 60, ...(from === null ? {} : { from_order: from }) }, signal)
      if (Array.isArray(result.shots)) rows.push(...result.shots)
      if (typeof result.next_from_order !== 'number') break
      from = result.next_from_order
    }
    return episodeShots(list, rows)
  }

  /**
   * Read one shot's video, first frame and version chain.
   * @param projectId - Selected cloud project.
   * @param shotId - Shot of that project.
   * @param signal - Panel cancellation.
   * @returns The shot's media.
   */
  @Remote
  async shotMedia(projectId: string, shotId: string, signal: AbortSignal): Promise<StudioShotMedia> {
    if (!/^[\w-]{1,128}$/u.test(shotId)) throw new HarnessError('镜头编号无效。', 'JINGLIU_INVALID_SHOT')
    const [shot, versions] = await Promise.all([
      this.workflow('get_shot', projectId, { shot_id: shotId }, signal),
      this.workflow('list_versions', projectId, { shot_id: shotId }, signal),
    ])
    return shotMedia(shot, versions)
  }

  /**
   * Read a production's assets and audio clips.
   * @param projectId - Selected cloud project.
   * @param signal - Panel cancellation.
   * @returns The workbench asset page's data.
   */
  @Remote
  async projectAssets(projectId: string, signal: AbortSignal): Promise<StudioProjectAssets> {
    const [assets, audio] = await Promise.all([
      this.workflow('list_assets', projectId, {}, signal),
      this.workflow('list_audio_clips', projectId, {}, signal),
    ])
    return projectAssets(assets, audio)
  }

  /**
   * Stream a studio video for playback without exposing the studio credential.
   * @param path - Media path of a video in the current studio.
   * @param signal - Playback cancellation.
   * @returns The content type first, then base64 chunks of the file.
   */
  @Remote({ mode: 'stream' })
  async *video(path: string, signal: AbortSignal): AsyncIterable<string> {
    const session = await this.connection()
    let type = ''
    let bytes: Buffer | undefined
    await session.media?.(path, AbortSignal.any([signal, AbortSignal.timeout(this.timeout * 4)]), async (response) => {
      type = response.headers.get('content-type')?.split(';')[0] ?? ''
      if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(type)) throw new HarnessError('镜流素材不是可播放的视频。', 'JINGLIU_INVALID_MEDIA')
      bytes = await boundedBytes(response, VIDEO_MAX_BYTES)
    })
    if (!bytes) throw new HarnessError('镜流没有返回这段视频。', 'JINGLIU_INVALID_MEDIA')
    yield type
    for (let start = 0; start < bytes.length; start += VIDEO_CHUNK_BYTES) yield bytes.subarray(start, start + VIDEO_CHUNK_BYTES).toString('base64')
  }

  // One desktop workflow of the studio, run as the signed-in user on one project.
  private async workflow(
    name: string, projectId: string, args: Record<string, string | number | boolean>, signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    projectPath(projectId)
    const session = await this.connection()
    return workflowResult(await session.request('/desktop-agent/tool', { method: 'POST', signal, body: { name, project_id: projectId, args: { project_id: projectId, ...args } } }))
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

  private async disconnect(signal: AbortSignal): Promise<string> {
    const active = this.active
    if (this.origin?.endsWith('/jingliu')) this.active = undefined
    else if (active && active.owner === await this.owner()) {
      try {
        await (await active.session).request('/auth/logout', { method: 'POST', signal })
      } catch (error) {
        if (!(error instanceof JingliuHttpError && error.status === 401)) throw error
      } finally {
        if (this.active === active) this.active = undefined
      }
    }
    return '本次镜流工具连接已结束。下次调用会使用当前 Muse 账号。'
  }
}

export default JingliuConnection
