/** Authenticated access to the ShotFlow project and workflow gateway. */
import { EventEmitter, on } from 'node:events'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { readSelection, storeSelection } from './project-selection.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SelectedProject } from './types.ts'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { balance, catalog, createdProject, episodeList, episodeShots, library, options, preferences, projectAssets, projectConfig, projectPath, projects, shotMedia, workflowResult } from './browser.ts'
import type { StudioBalance, StudioCatalog, StudioConfig, StudioEpisode, StudioImage, StudioLibrary, StudioLibraryQuery, StudioNewProject, StudioOptions, StudioPreferences, StudioProject, StudioProjectAssets, StudioSetting, StudioShot, StudioShotMedia, StudioVideoRequest } from './types.ts'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-muse-account'
import { WorkbenchSessions } from '@deepseek-ai/dsh-workbench-connection'
import type { WorkbenchDefinition, WorkbenchSession } from '@deepseek-ai/dsh-workbench-connection'
import type {} from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { boundedBytes, isRecord, JINGLIU, JingliuHttpError, studioOrigin } from './http.ts'
import type { JingliuRequest } from './http.ts'
import { JingliuMedia, mediaPath, projectMediaFolder } from './media.ts'
import type { LocalMedia, UploadedMedia } from './media.ts'

export { JingliuHttpError, boundedBytes, mediaPath, projectMediaFolder }
export type { LocalMedia, UploadedMedia }

// Without local files, a video and a thumbnail are held in Host memory; the bounds keep one request finite.
const VIDEO_MAX_BYTES = 64 * 1024 * 1024
const IMAGE_MAX_BYTES = 8 * 1024 * 1024
const VIDEO_CHUNK_BYTES = 768 * 1024
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime']
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
  /**
   * Keep studio media as files on this computer: thumbnails in a Host cache folder, videos and tool downloads in
   * `<workspace>/jingliu/<project>`. Only the desktop Host enables it; otherwise media is read into memory, within
   * fixed bounds, and never written to disk.
   */
  localMedia?: boolean
  /** Exact `host[:port]` values of presigned object-storage links the Host may download from or upload to. */
  mediaHosts?: string[]
  /** Simultaneous media downloads. */
  mediaDownloads?: number
  /** Bytes of viewed media one folder keeps before its least recently used files are removed; tool and draft files never count. */
  mediaCacheBytes?: number
  /** Largest download accepted when the studio does not state a file's size. */
  mediaMaxBytes?: number
  /** Maximum duration of one media download or upload, in milliseconds. */
  mediaTimeoutMs?: number
}

/** One verified user of a specific Jingliu deployment. */
export interface JingliuSession {
  readonly identity: string
  /**
   * Read a file returned by the studio and verify its owner upon completion. The file comes from object storage when the
   * studio resolves it there, otherwise through the Host; a redirect is followed only to a configured storage host.
   */
  media?(path: string, signal: AbortSignal, consume: (response: Response) => Promise<void>): Promise<void>
  /**
   * Make studio files available in a local media folder, downloading each one at most once. Present only on a Host with
   * `localMedia`.
   * @param paths - Stored addresses.
   * @param folder - Absolute media folder, normally `projectMediaFolder(workspace, project)`.
   * @param signal - Cancellation.
   * @returns The kept local file of each normalized address.
   */
  download?(paths: readonly string[], folder: string, signal: AbortSignal): Promise<Map<string, LocalMedia>>
  /**
   * Link or copy a downloaded file to a second path without another download.
   * @param file - File returned by `download`.
   * @param target - New path; it must not exist.
   */
  place?(file: LocalMedia, target: string): Promise<void>
  /**
   * Upload one local image, audio or video file straight to the studio's object storage.
   * @param file - Absolute path.
   * @param projectId - Production the file belongs to, when known.
   * @param signal - Cancellation.
   * @returns The uploaded file's permanent address and size.
   */
  upload?(file: string, projectId: string | undefined, signal: AbortSignal): Promise<UploadedMedia>
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
    localMedia: z.boolean().default(false),
    mediaHosts: z.array(z.string().pattern(/^[a-z0-9.-]+(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/u)).default([]),
    mediaDownloads: z.natural().min(1).max(32).default(4),
    mediaCacheBytes: z.natural().default(2 * 1024 * 1024 * 1024),
    mediaMaxBytes: z.natural().min(1).default(2 * 1024 * 1024 * 1024),
    mediaTimeoutMs: z.natural().min(1000).default(30 * 60 * 1000),
  })

  private readonly origin: string | undefined
  private readonly changes = new EventEmitter().setMaxListeners(0)
  private readonly sessions: WorkbenchSessions
  private readonly timeoutMs: number
  private readonly studios = new WeakMap<WorkbenchSession, JingliuSession>()
  private readonly media: JingliuMedia
  /** Whether this Host keeps studio media as local files; see `Config.localMedia`. */
  readonly localMedia: boolean

  /** @param ctx - Muse host context.
   * @param config - Jingliu deployment and transport configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'jingliuConnection')
    this.origin = config.studioOrigin ? studioOrigin(config.studioOrigin) : undefined
    const preview = config.localPreviewToken === true
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.localMedia = config.localMedia === true
    this.media = new JingliuMedia({
      hosts: config.mediaHosts ?? [], downloads: config.mediaDownloads ?? 4, cacheBytes: config.mediaCacheBytes ?? 2 * 1024 ** 3,
      maxBytes: config.mediaMaxBytes ?? 2 * 1024 ** 3, timeoutMs: config.mediaTimeoutMs ?? 30 * 60_000,
    })
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
        const response = await this.media.open(session, path, signal)
        try { await consume(response) }
        finally { if (!response.bodyUsed) await response.body?.cancel() }
        await session.check()
      },
      ...(this.localMedia && {
        download: (paths: readonly string[], folder: string, signal: AbortSignal) =>
          this.media.files(session, paths, folder, { keep: true, evict: false, signal }),
        place: (file: LocalMedia, target: string) => this.media.place(file, target),
      }),
      upload: (file: string, projectId: string | undefined, signal: AbortSignal) => this.media.upload(session, file, { projectId, signal }),
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
    // Most used first: what productions reuse most is what a user looks for.
    const params = new URLSearchParams({ limit: '24', offset: String(query.offset), q: query.query, sort: 'uses' })
    if (query.kind !== 'all') params.set('kind', query.kind)
    return library(await (await this.connection()).request('/library?' + params.toString(), { signal }))
  }

  /**
   * Load a thumbnail without exposing the studio credential. With `localMedia` the image is downloaded once into this
   * account's cache folder in the Host home, `jingliu/media/<account>`, and returned as that file; otherwise it is returned
   * inline, up to 8 MiB.
   * @param path - Native thumbnail path in the current library.
   * @param signal - Panel cancellation.
   * @returns A preview image for this account.
   */
  @Remote
  async thumbnail(path: string, signal: AbortSignal): Promise<StudioImage> {
    const studio = await this.sessions.connection()
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
    const invalid = () => new HarnessError('镜流素材没有可显示的缩略图。', 'JINGLIU_INVALID_MEDIA')
    if (this.localMedia) {
      const folder = join(resolveDshHome(), 'jingliu', 'media', studio.identity.slice(0, 32))
      const [file] = (await this.media.files(studio, [path], folder, { keep: false, evict: true, signal: lifetime })).values()
      if (!file || !IMAGE_TYPES.includes(file.contentType)) throw invalid()
      return { kind: 'file', path: file.file }
    }
    let image = ''
    await this.studio(studio).media?.(path, lifetime, async (response) => {
      const type = response.headers.get('content-type')?.split(';')[0]
      if (!type || !IMAGE_TYPES.includes(type)) throw invalid()
      image = 'data:' + type + ';base64,' + (await boundedBytes(response, IMAGE_MAX_BYTES)).toString('base64')
    })
    return { kind: 'inline', url: image }
  }

  /**
   * Read the choices the studio offers for a new production.
   * @param signal - Panel cancellation.
   * @returns Modes with their art styles, frame ratios, resolutions and models.
   */
  @Remote
  async catalog(signal: AbortSignal): Promise<StudioCatalog> {
    const session = await this.connection()
    const [modes, image, video] = await Promise.all([session.request('/production-modes', { signal }),
      session.request('/providers/image', { signal }), session.request('/providers/video', { signal })])
    return catalog(modes, image, video)
  }

  /**
   * Create a production as the signed-in studio user.
   * @param input - Its name and settings, each one the catalog offers or '' for the studio default.
   * @param signal - Form lifetime.
   * @returns The created production's id and title.
   */
  @Remote
  async createProject(input: StudioNewProject, signal: AbortSignal): Promise<SelectedProject> {
    const title = input.title.trim()
    if (title === '' || title.length > 255) throw new HarnessError('请填写项目名称。', 'JINGLIU_INVALID_ARGUMENTS')
    const offered = await this.catalog(signal)
    const mode = offered.modes.find(m => m.key === input.mode)
    const allowed = (value: string, list: string[]) => value === '' || list.includes(value)
    if (mode === undefined || !allowed(input.artStyle, mode.styles.map(s => s.key)) || !allowed(input.aspect, offered.aspects)
      || !allowed(input.resolution, offered.resolutions) || !allowed(input.videoModel, offered.videoModels.map(m => m.id))
      || !allowed(input.imageModel, offered.imageModels.map(m => m.id))
      || !allowed(input.generationMode, offered.generationModes.map(m => m.id))) {
      throw new HarnessError('请选择镜流当前提供的设置。', 'JINGLIU_INVALID_ARGUMENTS')
    }
    const settings = Object.fromEntries(([['video_model', input.videoModel], ['image_model', input.imageModel],
      ['generation_mode', input.generationMode], ['resolution', input.resolution]] as const).filter(([, value]) => value !== ''))
    return createdProject(await (await this.connection()).request('/projects', { method: 'POST', signal, body: {
      title, production_mode: mode.key, ...input.artStyle ? { art_style: input.artStyle } : {},
      ...input.aspect ? { base_aspect: input.aspect } : {}, ...Object.keys(settings).length > 0 ? { custom_settings: settings } : {},
    } }))
  }

  /**
   * Rename a production; later generations use the new name in their prompts.
   * @param projectId - The production.
   * @param title - Its new name.
   * @param signal - Form lifetime.
   * @returns The stored id and title.
   */
  @Remote
  async renameProject(projectId: string, title: string, signal: AbortSignal): Promise<SelectedProject> {
    const name = title.trim()
    if (name === '' || name.length > 255) throw new HarnessError('请填写项目名称。', 'JINGLIU_INVALID_ARGUMENTS')
    const result = await (await this.connection()).request(projectPath(projectId), { method: 'PATCH', signal, body: { title: name } })
    if (!isRecord(result) || result.title !== name) throw new HarnessError('请刷新并核对项目名称。', 'JINGLIU_INVALID_RESULT')
    return { id: projectId, title: name }
  }

  /**
   * Delete one shot of a production; the studio keeps no copy to restore.
   * @param projectId - The production the workbench shows.
   * @param shotId - The shot to delete.
   * @param signal - Card lifetime.
   * @returns Nothing once the studio confirms.
   */
  @Remote
  async deleteShot(projectId: string, shotId: string, signal: AbortSignal): Promise<void> {
    projectPath(projectId)
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(shotId)) throw new HarnessError('镜头编号无效。', 'JINGLIU_INVALID_ARGUMENTS')
    await (await this.connection()).request('/shots/' + shotId, { method: 'DELETE', signal })
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
   * Download a studio video once into the production's media folder of a conversation's workspace, for playback from
   * that file. Kept tool and draft files stay; other viewed files beyond `mediaCacheBytes` are removed, oldest first.
   * @param request - Conversation, production and stored video address.
   * @param signal - Playback cancellation.
   * @returns The absolute local file, or null when this Host keeps no local media or the conversation has no workspace.
   */
  @Remote
  async localVideo(request: StudioVideoRequest, signal: AbortSignal): Promise<string | null> {
    if (!this.localMedia) return null
    const controller = this.ctx.get('sessionController')
    if (!controller) throw new HarnessError('当前会话不可用。', 'JINGLIU_SESSION_REQUIRED')
    const resolved = await controller.resolveAgent(request.sessionId)
    if ('error' in resolved) throw resolved.error
    const workspace = resolved.agent.session.header.cwd
    if (!workspace) return null
    const studio = await this.sessions.connection()
    const folder = projectMediaFolder(workspace, request.projectId)
    const [file] = (await this.media.files(studio, [request.path], folder, { keep: false, evict: true, signal })).values()
    if (!file || !VIDEO_TYPES.includes(file.contentType)) throw new HarnessError('镜流素材不是可播放的视频。', 'JINGLIU_INVALID_MEDIA')
    return file.file
  }

  /**
   * Stream a studio video for playback without exposing the studio credential, for a Host without local media.
   * @param path - Media path of a video in the current studio.
   * @param signal - Playback cancellation.
   * @returns The content type first, then base64 chunks of the file, up to 64 MiB.
   */
  @Remote({ mode: 'stream' })
  async *video(path: string, signal: AbortSignal): AsyncIterable<string> {
    const session = await this.connection()
    let type = ''
    let bytes: Buffer | undefined
    await session.media?.(path, AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs * 4)]), async (response) => {
      type = response.headers.get('content-type')?.split(';')[0] ?? ''
      if (!VIDEO_TYPES.includes(type)) throw new HarnessError('镜流素材不是可播放的视频。', 'JINGLIU_INVALID_MEDIA')
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

}

export default JingliuConnection
