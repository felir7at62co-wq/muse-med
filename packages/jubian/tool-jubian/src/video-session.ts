/** Session video selection, human choices and generation consistency. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { resolveVideoModel, stableJson } from '@deepseek-ai/dsh-jubian-api'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-session-projection'
import { readFile } from 'node:fs/promises'
import { modelMethod } from './model-settings.ts'
import { resolveGenerateMethod } from './native.ts'
import { requireArguments } from './write.ts'
import { videoSelectionSchema, type SessionVideoSelection, type VideoModelOption, type VideoModelDefault } from './video-session-types.ts'
import './video-session-types.ts'
declare module '@deepseek-ai/cordis' { interface Context { jubianVideoSelection: JubianVideoSelection } }

type Row = Record<string, unknown>
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected video configuration object')
  return value as Row
}
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function config(board: Row): Row { return row(typeof board.modelConfig === 'string' ? JSON.parse(board.modelConfig) : board.modelConfig) }
function ceiling(modelId: string): number | null {
  return modelId === 'doubao-seedance-2-0-260128' ? 15 : modelId === 'doubao-seedance-2-5-260628' ? 30 : null
}
/**
 * Parse all account video specifications without borrowing another model's limits.
 * @param data - Live taskType=1 catalogue.
 * @returns Distinct model/platform/resolution options.
 */
export function videoOptions(data: unknown): VideoModelOption[] {
  if (!Array.isArray(data)) throw new Error('Unreadable video catalogue')
  const options: VideoModelOption[] = []
  for (const value of data) {
    const model = row(value)
    const modelId = text(model.modelId)
    const platformId = text(model.platformId)
    const standardId = Number(model.id ?? model.standardId)
    if (!modelId || !platformId || !Number.isSafeInteger(standardId) || standardId < 1) throw new Error('Invalid video catalogue identity')
    if (!Array.isArray(model.videoStandards)) throw new Error('Missing video specifications')
    const standards = model.videoStandards.map(row)
    for (const resolution of new Set(standards.map(spec => text(spec.resolution)).filter(Boolean))) {
      const matches = standards.filter(spec => spec.resolution === resolution)
      const genTypes = Array.isArray(model.genTypes)
        ? [...new Set(model.genTypes.map(value => Number(row(value).type)).filter(Number.isSafeInteger))] : []
      options.push({ key: `${standardId}:${resolution}`, modelId, modelName: text(model.modelName) || modelId, platformId,
        standardId, resolution, genTypes, ratios: [...new Set(matches.map(spec => text(spec.ratio)).filter(Boolean))],
        maxDurationSeconds: ceiling(modelId) })
    }
  }
  return options
}
/**
 * Fold the latest explicit selection, including fork-inherited or compacted log events.
 * @param session - Owning conversation.
 * @returns Last user selection, or null before a selection.
 */
export function selectedVideo(session: Session): SessionVideoSelection | null {
  // oxlint-disable-next-line typescript/no-deprecated -- Retain the existing durable-selection fold.
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type === 'jubian/video-selection') return event.data.selection
  }
  return null
}
/**
 * Render the changing runtime-context suffix, leaving the system prompt untouched.
 * @param selection - Latest explicit session choice.
 * @returns Short model-readable operational state.
 */
export function videoSelectionContext(selection: SessionVideoSelection | null): string {
  if (selection === null) return '本会话尚未选择视频生成模型。生成前使用 jubian_video_model 询问用户选择模型和分辨率；读取项目不得代替用户选择。'
  return `本会话的视频生成设置：${selection.modelName}；分辨率 ${selection.resolution}；通道 ${selection.platformId}；modelId=${selection.modelId}；standardId=${selection.standardId}。`
    + (selection.maxDurationSeconds === null ? '本模型时长上限未知，不套用 Seedance 上限。' : `单次生成时长上限 ${selection.maxDurationSeconds} 秒；上限不代表推荐包长。`)
    + '后续生成以此会话选择为准；读取剧变项目不改变此选择，也不修改项目默认值。仅同步本次要生成的视频卡并回读，保留提示词与素材。'
    + '若原视频包超过新上限，使用 jubian_video_model 的 duration_conflict 询问用户保留模型重新拆包，或选择可容纳原包的模型；同批合并询问，不截断对白。已提交任务保持原配置。'
}
/** Host owner shared by the composer, model-facing ask tool and paid executors. */
export class JubianVideoSelection extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'systemPrompt', 'sessionProjections']
  private readonly initializing = new WeakMap<Agent, Promise<SessionVideoSelection | null>>()
  private readonly contextReviewers = new Set<{ reviewer: (agent: Agent, selection: SessionVideoSelection) => string }>()
  constructor(ctx: Context, private readonly options: {
    client: JubianClient
    ledger: JubianLedger
    enabled: boolean
    defaultModel?: Pick<VideoModelOption, 'modelId' | 'platformId' | 'resolution'>
  }) {
    super(ctx, 'jubianVideoSelection')
    ctx.sessionProjections.register<'jubianVideoSelection', SessionVideoSelection | null>({
      key: 'jubianVideoSelection', stateSchema: videoSelectionSchema, init: () => null,
      apply: (state, event) => event.type === 'jubian/video-selection' ? event.data.selection : state,
      wire: { viewSchema: videoSelectionSchema, view: state => state }, stateVersion: 1,
    })
    ctx.effect(() => ctx.systemPrompt.context({ name: 'jubian:video-selection', order: 55,
      text: ({ agent }) => {
        if (agent === undefined || !options.enabled) return ''
        const current = selectedVideo(agent.session)
        if (current === null && options.defaultModel) return `本会话默认视频模型为 ${options.defaultModel.modelId}，分辨率 ${options.defaultModel.resolution}。`
          + '尚未初始化时用 jubian_video_model read 核实并保存默认选择，无需重复询问；已有选择优先，读取项目不改变此选择。'
        return videoSelectionContext(current)
      } }))
    ctx.on('agent/created', ({ agent, source }) => {
      const header = agent.session.header
      if (!options.enabled || source !== 'startup' || header.origin !== 'subagent' || header.isSeeded
        || selectedVideo(agent.session) !== null || header.parentSession === undefined) return
      const parent = ctx.sessions.get(header.parentSession)
      const inherited = parent === undefined ? null : selectedVideo(parent)
      if (inherited !== null) this.commit(agent, inherited, 0)
    })
  }
  /**
   * Initialize the configured default from the live catalogue once, preserving any human choice made during the read.
   * @param agent - Owning conversation.
   * @returns Existing or newly committed setting, or null when no default is configured.
   */
  async initialize(agent: Agent): Promise<SessionVideoSelection | null> {
    const current = selectedVideo(agent.session)
    if (current || !this.options.enabled || !this.options.defaultModel) return current
    const pending = this.initializing.get(agent)
    if (pending) return pending
    const defaults = this.options.defaultModel
    const work = (async () => {
      const matches = (await this.catalogue()).filter(option => option.modelId === defaults.modelId
        && option.platformId === defaults.platformId && option.resolution === defaults.resolution)
      const latest = selectedVideo(agent.session)
      if (latest) return latest
      const option = matches[0]
      if (matches.length !== 1 || option === undefined) {
        throw new RemoteError('jubian-video/rejected', '默认视频模型暂不可用，请在视频模型菜单中选择', {})
      }
      return this.commit(agent, option, 0)
    })()
    this.initializing.set(agent, work)
    try { return await work } finally { this.initializing.delete(agent) }
  }
  /**
   * Read whether this deployment enables conversation-owned video choices.
   * @returns Whether the composer should expose the video menu.
   */
  @Remote
  available(): boolean { return this.options.enabled }
  /**
   * Read deployment defaults without resuming an Agent or writing a selection.
   * @returns The initial model, channel and resolution, or null when not configured.
   */
  @Remote
  defaults(): VideoModelDefault | null { return this.options.defaultModel ?? null }
  /**
   * Read the live account catalogue; never writes project defaults.
   * @returns Complete model specifications.
   */
  @Remote
  async catalogue(): Promise<VideoModelOption[]> {
    return videoOptions((await this.options.client.request({ method: 'GET', path: '/model/charge/getSelectList?taskType=1' })).data)
  }
  /**
   * Read one conversation's durable choice.
   * @param agent - Authenticated conversation identity.
   * @returns Explicit choice or null.
   */
  @Remote
  current(agent: Agent): SessionVideoSelection | null { return selectedVideo(agent.session) }
  /**
   * Add synchronous advice to the same logged context as each committed selection.
   * Reviewer errors produce a retry warning and never reject the selected model.
   * @param reviewer - Pure synchronous check returning additional context, or an empty string.
   * @returns Fiber-owned disposer; removed reviewers are never called by later commits.
   */
  registerContextReviewer(reviewer: (agent: Agent, selection: SessionVideoSelection) => string): () => void {
    const entry = { reviewer }
    const dispose = this.ctx.effect(() => {
      this.contextReviewers.add(entry)
      return () => { this.contextReviewers.delete(entry) }
    }, 'jubianVideoSelection.registerContextReviewer()')
    return () => { void dispose() }
  }
  /**
   * Save an exact live option with optimistic revision checking.
   * @param agent - Authenticated conversation identity.
   * @param key - Catalogue row and resolution key.
   * @param expectedRevision - Revision displayed to the user, zero before selection.
   * @returns Committed choice; identical choices produce no event.
   */
  @Remote
  async select(agent: Agent, key: string, expectedRevision: number): Promise<SessionVideoSelection> {
    if (!this.available()) throw new RemoteError('jubian-video/rejected', '本部署未启用会话视频模型选择', {})
    const option = (await this.catalogue()).find(candidate => candidate.key === key)
    if (!option) throw new RemoteError('jubian-video/rejected', '所选视频模型或分辨率已不可用，请刷新目录', {})
    return this.commit(agent, option, expectedRevision)
  }
  private commit(agent: Agent, option: VideoModelOption, expectedRevision: number): SessionVideoSelection {
    const previous = selectedVideo(agent.session)
    if ((previous?.revision ?? 0) !== expectedRevision) throw new RemoteError('jubian-video/rejected', '会话的视频模型已改变，请核对当前选择后重试', {})
    if (previous?.key === option.key && stableJson({ ...previous, revision: 0 }) === stableJson({ ...option, revision: 0 })) return previous
    const selection = { ...option, revision: expectedRevision + 1 }
    agent.session.append('jubian/video-selection', { selection })
    const context = [videoSelectionContext(selection)]
    let reviewFailed = false
    for (const entry of [...this.contextReviewers]) {
      if (!this.contextReviewers.has(entry)) continue
      try {
        const advice = entry.reviewer(agent, selection)
        if (advice !== '') context.push(advice)
      } catch (error) {
        this.ctx.logger.warn('Video selection advisory check failed: %s', String(error))
        reviewFailed = true
      }
    }
    if (reviewFailed) context.push('视频模型选择已保存；自动检查暂不可用，请重新运行 drama_shot 核对现有视频包。检查未完成不表示视频包已通过。')
    agent.inject(createUserMessage({ content: [{ type: 'text', text: context.join('\n') }],
      source: { kind: 'jubian-video-selection' } }))
    return selection
  }
  /**
   * Follow committed changes without polling or waking the dialogue model.
   * @param agent - Owning conversation.
   * @param signal - Remote stream lifetime.
   * @returns Initial choice followed by each latest committed choice.
   */
  @Remote({ mode: 'stream' })
  async *watch(agent: Agent, signal: AbortSignal): AsyncIterable<SessionVideoSelection | null> {
    await this.initialize(agent)
    let dirty = true
    let wake: (() => void) | undefined
    const notify = (): void => { dirty = true; wake?.(); wake = undefined }
    const dispose = this.ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'jubian/video-selection') notify()
    }, { global: true })
    signal.addEventListener('abort', notify)
    try {
      while (!signal.aborted) {
        if (dirty) { dirty = false; yield selectedVideo(agent.session) }
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally { dispose(); signal.removeEventListener('abort', notify) }
  }
  /**
   * Ask for an explicit model selection or resolve a duration conflict once for the affected batch.
   * @param agent - Calling conversation.
   * @param args - Human-readable reason and optional longest affected package.
   * @param signal - Tool lifetime.
   * @returns Chosen setting or instruction to retain the model and replan content.
   */
  async ask(agent: Agent, args: { reason: string; method: string; duration_seconds?: number }, signal: AbortSignal): Promise<{ action: 'replan_packages' | 'unchanged' | 'selected'; selection: SessionVideoSelection | null; paid_requests: 0 }> {
    const questions = this.ctx.get('userQuestions')
    if (!questions) throw new Error('User question service unavailable')
    const current = args.method === 'duration_conflict' ? await this.initialize(agent) : selectedVideo(agent.session)
    if (args.duration_seconds !== undefined && (!Number.isFinite(args.duration_seconds) || args.duration_seconds <= 0)) throw new Error('duration_seconds must be positive')
    if (args.method === 'duration_conflict' && (!current || args.duration_seconds === undefined)) throw new Error('Duration conflict requires a current model and longest affected package duration')
    if (args.method === 'duration_conflict') {
      const answer = await questions.ask({ agent, signal, questions: [{ id: 'duration', question: args.reason,
        options: [{ label: '保留当前模型，重新拆包', description: '按当前模型上限保留完整台词和剧情。' },
          { label: '更换模型，保留原视频包', description: '选择能容纳当前视频包的模型与分辨率。' }] }] })
      if (answer.answers[0]?.selected[0] === '保留当前模型，重新拆包') return { action: 'replan_packages', selection: current, paid_requests: 0 }
      if (answer.answers[0]?.selected[0] !== '更换模型，保留原视频包') return { action: 'unchanged', selection: current, paid_requests: 0 }
    }
    const options = (await this.catalogue()).filter(option => args.duration_seconds === undefined
      || (option.maxDurationSeconds !== null && option.maxDurationSeconds >= args.duration_seconds))
    if (!options.length) throw new Error('No verified model can hold the requested duration; keep the model and replan the packages')
    const labels = options.map(option => `${option.modelName} · ${option.resolution} · ${option.platformId} [${option.standardId}]`)
    const answer = await questions.ask({ agent, signal, questions: [{ id: 'video-model', question: args.reason,
      options: labels.map(label => ({ label })) }] })
    const index = labels.indexOf(answer.answers[0]?.selected[0] ?? '')
    if (index < 0) return { action: 'unchanged', selection: selectedVideo(agent.session), paid_requests: 0 }
    const chosen = options[index]
    if (!chosen) throw new Error('Selected model unavailable')
    const selection = await this.select(agent, chosen.key, current?.revision ?? 0)
    return { action: 'selected', selection, paid_requests: 0 }
  }
  /**
   * Validate the current user choice at the new paid reservation.
   * @param agent - Owning conversation.
   * @param saved - Frozen provider model configuration.
   */
  assertCurrent(agent: Agent, saved: Record<string, unknown>): void {
    const selection = selectedVideo(agent.session)
    if (!selection || saved.modelId !== selection.modelId || saved.platformId !== selection.platformId
      || saved.resolution !== selection.resolution || Number(saved.standardId) !== selection.standardId) {
      throw new Error('SESSION_VIDEO_SELECTION_CHANGED: 会话模型已变化，请重新 prepare_video 核对配置和费用；旧预览未提交')
    }
    if (selection.maxDurationSeconds !== null && Number(saved.duration) > selection.maxDurationSeconds) {
      throw new Error('SESSION_VIDEO_DURATION_EXCEEDED: 汇总超限视频包，用 jubian_video_model duration_conflict 询问用户')
    }
  }
  /**
   * Synchronize only an addressed board before preview; paid previews must match the current choice.
   * @param agent - Calling conversation.
   * @param args - Existing storyboard tool arguments.
   * @returns Resolves before the normal executor may continue.
   */
  async reconcile(agent: Agent, args: Record<string, unknown>): Promise<void> {
    const method = args.method === 'generate'
      ? await resolveGenerateMethod(this.options.ledger, args) : args.method
    if (method === 'legacy_replay') return
    if (method === 'prepare_video') requireArguments('jubian_storyboard', { ...args, method })
    // Original accepted/uncertain operations must remain reconcilable after a UI switch.
    const keys = method === 'submit_video_batch' && Array.isArray(args.video_previews)
      ? args.video_previews.map(item => row(item).idempotency_key) : [args.idempotency_key]
    if (String(method).startsWith('submit_video') && keys.length > 0
      && (await Promise.all(keys.map(async key => typeof key === 'string' ? await this.options.ledger.find(key) : undefined)))
        .every(record => record?.method === 'storyboard_native_submit')) return
    const selection = await this.initialize(agent)
    if (!selection) throw new Error('SESSION_VIDEO_MODEL_REQUIRED: 请调用 jubian_video_model 让用户选择本会话的视频模型与分辨率')
    if (method === 'prepare_video') {
      const board = row((await this.options.client.request({ method: 'GET', path: `/aigc/storyboard/${String(args.storyboard_id)}` })).data)
      const before = config(board)
      const duration = Number(before.duration)
      if (selection.maxDurationSeconds !== null && duration > selection.maxDurationSeconds) throw new Error(
        `SESSION_VIDEO_DURATION_EXCEEDED: 视频卡 ${String(board.id)} 为 ${duration} 秒，当前 ${selection.modelName} 上限 ${selection.maxDurationSeconds} 秒；汇总本批超限卡后用 jubian_video_model duration_conflict 询问用户，不直接缩短时长或截断对白。`)
      if (before.modelId === selection.modelId && before.platformId === selection.platformId && before.resolution === selection.resolution
        && Number(before.standardId) === selection.standardId) return
      if (typeof args.project_dir !== 'string') throw new Error('先使用 prepare_video 同步本会话模型，再提交生成')
      const changes = { modelId: selection.modelId, platformId: selection.platformId, resolution: selection.resolution }
      // Verify the whole target specification, including its original ratio and duration, before any write.
      resolveVideoModel((await this.options.client.request({ method: 'GET', path: '/model/charge/getSelectList?taskType=1' })).data,
        { ...before, ...changes })
      const preview = await modelMethod(this.options.client, this.options.ledger, { method: 'preview', project_dir: args.project_dir,
        script_id: Number(board.scriptId), scope: 'storyboards', storyboard_ids: [Number(board.id)], changes })
      if (selectedVideo(agent.session)?.revision !== selection.revision) throw new Error('会话模型已变化，请重新准备视频卡')
      const applied = await modelMethod(this.options.client, this.options.ledger, { method: 'apply', project_dir: args.project_dir, script_id: Number(board.scriptId), preview_path: String(preview.preview_path),
        idempotency_key: String(preview.fingerprint) })
      if (!Array.isArray(applied.items) || applied.items.some(item => row(item).status !== 'applied')) throw new Error('视频卡模型同步未确认，请回读核对；不提交生成')
      if (selectedVideo(agent.session)?.revision !== selection.revision) throw new Error('会话模型已变化，请重新准备视频卡')
      return
    }
    const paths = method === 'submit_video_batch' && Array.isArray(args.video_previews)
      ? args.video_previews.map(item => row(item).preview_path) : [args.preview_path]
    for (const path of paths) {
      if (path === undefined && method === 'submit_video') continue
      if (typeof path !== 'string') throw new Error('Prepare a current video preview before submitting')
      const frozen = row(JSON.parse(await readFile(path, 'utf8')))
      const saved = config(row(frozen.payload))
      this.assertCurrent(agent, saved)
    }
  }
}
