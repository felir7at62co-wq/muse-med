/** Session model budgets and advisory rechecks of logged packaging results. */
import { isAbsolute, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SessionVideoSelection } from '@deepseek-ai/dsh-tool-jubian/video-session-types'
import type {} from '@deepseek-ai/dsh-tool-jubian'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { DurationBudget, ShotIssue } from './types.ts'

const packageSchema = z.object({ index: z.number().int(), shots: z.array(z.number().int()), submit_seconds: z.number().positive() })
const reviewSchema = z.object({
  review_mode: z.literal('advisory'), method: z.enum(['preview', 'compile']), script: z.string(),
  packages: z.array(packageSchema),
  duration_budget: z.object({ selection: z.object({ revision: z.number().int() }).nullable() }).optional(),
})
const savedReviewSchema = z.object({ script: z.string(), packages: z.array(packageSchema),
  revision: z.number().int().nullable(), available: z.boolean().default(true) })
const productionReviewSchema = z.object({ mode: z.literal('advisory'), method: z.enum(['preview', 'update']),
  production_review: savedReviewSchema })
const reviewStateSchema = z.object({
  pending: z.array(z.object({ call_id: z.string(), packaging: z.boolean() })), latest: savedReviewSchema.nullable(),
})
type SavedReview = z.infer<typeof savedReviewSchema>
type ReviewState = z.infer<typeof reviewStateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { dramaShotReview: ReviewState }
}

/** Decode only the package facts needed for a capability recheck, from a durable tool result. */
function readReview(content: readonly ContentBlock[]): SavedReview | null {
  for (const block of content) {
    if (block.type !== 'text') continue
    let document: unknown
    try { document = JSON.parse(block.text) } catch (error) {
      // Other tool content and old error messages are not packaging reports.
      if (error instanceof SyntaxError) continue
      throw error
    }
    const parsed = reviewSchema.safeParse(document)
    if (parsed.success) return { script: parsed.data.script, packages: parsed.data.packages,
      revision: parsed.data.duration_budget?.selection?.revision ?? null, available: true }
    const production = productionReviewSchema.safeParse(document)
    if (production.success) return production.data.production_review
  }
  return null
}

/**
 * Preserve compact package facts when the model-facing report is spilled or pruned.
 * @param _args - Validated tool arguments.
 * @param value - Canonical report before content projections.
 * @returns Replayable package facts, or null for non-packaging results.
 */
export function reviewPresentationMeta(_args: unknown, value: unknown): { drama_shot_review: SavedReview | null } {
  const parsed = reviewSchema.safeParse(value)
  const production = productionReviewSchema.safeParse(value)
  return { drama_shot_review: parsed.success ? { script: parsed.data.script, packages: parsed.data.packages,
    revision: parsed.data.duration_budget?.selection?.revision ?? null, available: true }
    : production.success ? production.data.production_review : null }
}

function metaReview(meta: unknown): SavedReview | null {
  const parsed = z.object({ drama_shot_review: savedReviewSchema.nullable() }).safeParse(meta)
  return parsed.success ? parsed.data.drama_shot_review : null
}

function packagingCall(args: unknown): boolean {
  let value: unknown = args
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch (error) {
      if (error instanceof SyntaxError) return false
      throw error
    }
  }
  return typeof value === 'object' && value !== null && 'method' in value
    && (value.method === 'preview' || value.method === 'compile' || value.method === 'update')
}

function unavailableReview(): SavedReview { return { script: '', packages: [], revision: null, available: false } }

function boundContext(text: string, maxChars: number): string {
  const suffix = '（详细列表已省略；完整分包事实保留在上次工具结果，请重新 preview。仅作提示，不改卡、不截断台词。）'
  return text.length <= maxChars ? text : text.slice(0, maxChars - suffix.length) + suffix
}

/** Compare original requested package lengths without rewriting or rereading the script. */
function recheck(review: SavedReview, selection: SessionVideoSelection, maxChars: number, cwd: string | undefined): string {
  const script = isAbsolute(review.script) && cwd !== undefined ? relative(cwd, review.script) : review.script
  return boundContext(recheckText({ ...review, script }, selection), maxChars)
}

function recheckText(review: SavedReview, selection: SessionVideoSelection): string {
  if (!review.available) return '已保存当前视频模型选择，但最近一次分包结果无法读取，不能继续使用更早的建议。请重新调用 drama_shot preview 核对；仅作提示，原稿与视频卡未修改。'

  const prefix = `已按本会话新视频模型 ${selection.modelName} ${selection.resolution}（revision=${selection.revision}）复核最近一次 drama_shot 分包建议：${review.script}。`
  if (selection.maxDurationSeconds === null) return prefix
    + '当前模型的时长上限未知，不能断言原包可用，也不借用其他模型的上限；请核实时长能力后重新预览。仅作提示，原稿与视频卡未修改。'
  if (review.packages.length === 0) return prefix
    + `当前上限 ${selection.maxDurationSeconds} 秒；此前没有可用分包草案，请重新调用 drama_shot preview 按当前选择计算。仅作提示，原稿与视频卡未修改。`
  const maximum = selection.maxDurationSeconds
  const over = review.packages.filter(pack => pack.submit_seconds > maximum)
  const detail = over.length === 0 ? `原 ${review.packages.length} 包的提交时长均未超过当前 ${selection.maxDurationSeconds} 秒上限。`
    : `有 ${over.length} 包超过当前 ${selection.maxDurationSeconds} 秒上限：`
      + over.map(pack => `第${pack.index}包（镜${pack.shots.join('、')}，原提交${pack.submit_seconds}秒）`).join('；')
      + '。请结合完整台词、情绪和叙事节奏重新分包；调用 drama_shot preview 计算新建议，或用 jubian_video_model duration_conflict 询问是否换模型；不截断对白。'
  return `本次复核 ${review.packages.length} 包，其中 ${over.length} 包超出当前 ${selection.maxDurationSeconds} 秒上限。` + prefix + detail + '这是对上次工具结果的时长复核，未重新读取可能已修改的脚本或检查画面，不代表创作或生成验收通过。仅作提示，不自动改卡或提交生成。'
}

/**
 * Resolve the calling conversation's saved specification without accepting a stale model-supplied limit.
 * @param ctx - Context with the session video-selection service.
 * @param agent - Calling conversation, absent for direct non-agent calls.
 * @param provided - Old optional tool argument, used only to explain ignored values.
 * @param issues - Call-owned advisory findings.
 * @returns Actual session model and capability, with null for unavailable or unknown limits.
 */
export async function sessionDurationBudget(
  ctx: Context, agent: Agent | undefined, provided: number | undefined, issues: ShotIssue[],
): Promise<DurationBudget> {
  const service = ctx.get('jubianVideoSelection')
  if (service === undefined) throw new Error('drama_shot sessionVideoSelection 需要会话视频模型服务。')
  let selection: SessionVideoSelection | null = null
  if (agent !== undefined) {
    selection = service.current(agent)
    if (selection === null) {
      try { selection = await service.initialize(agent) } catch (error) {
        issues.push({ severity: 'warning', code: 'session_video_unavailable', shot: 0, line: 0,
          message: `暂时无法核实会话视频模型：${error instanceof Error ? error.message : String(error)}。本次保留原镜头，不采用传入的旧时长上限，请核对选择后重新预览。` })
      }
    }
  }
  const maximum = selection?.maxDurationSeconds ?? null
  if (selection === null) issues.push({ severity: 'warning', code: 'session_video_unavailable', shot: 0, line: 0,
    message: '未取得当前会话的视频模型选择，本次仅检查原镜头，不猜测模型上限或生成分包；请核对聊天框选择后重新预览。' })
  else if (maximum === null) issues.push({ severity: 'warning', code: 'session_video_duration_unknown', shot: 0, line: 0,
    message: `当前会话选择 ${selection.modelName} ${selection.resolution}，时长上限未知；本次仅检查原镜头，不套用其他模型上限或生成分包。` })
  if (provided !== undefined && provided !== maximum) issues.push({ severity: 'warning', code: 'session_video_budget_ignored', shot: 0, line: 0,
    message: `max_submit_seconds=${provided} 已忽略；分包能力以当前会话模型的${maximum === null ? '未知上限' : `${maximum}秒上限`}为准，不要求每包填满上限。` })
  return { source: 'session', max_submit_seconds: maximum, selection: selection === null ? null : {
    model_id: selection.modelId, model_name: selection.modelName, platform_id: selection.platformId,
    standard_id: selection.standardId, resolution: selection.resolution, max_duration_seconds: maximum, revision: selection.revision,
  } }
}

/**
 * Register durable last-review projection and selection-triggered, non-blocking context.
 * @param ctx - Injection-owned context with model selection and session projections.
 * @param definition - Exact scoped tool whose reviews this registration owns.
 * @param maxChars - Maximum characters in each switch-review context.
 */
export function installSessionReview(ctx: Context, definition: ToolDefinition, maxChars: number): void {
  const projections = ctx.get('sessionProjections')
  const service = ctx.get('jubianVideoSelection')
  if (projections === undefined || service === undefined) throw new Error('会话分包复核需要视频模型与会话投影服务。')
  projections.register({ key: 'dramaShotReview', stateSchema: reviewStateSchema, stateVersion: 1,
    init: () => ({ pending: [], latest: null }),
    apply: (state, event) => {
      if (event.type === 'tool/call' && ['drama_shot', 'muse_production'].includes(event.data.name)) {
        return { ...state, pending: [...state.pending, { call_id: event.data.callId, packaging: packagingCall(event.data.arguments) }] }
      }
      if (event.type === 'tool/result') {
        const pending = state.pending.find(call => call.call_id === event.data.message.toolCallId)
        if (pending === undefined) return state
        return { pending: state.pending.filter(call => call.call_id !== event.data.message.toolCallId),
          latest: event.data.message.isError || !pending.packaging ? state.latest
            : metaReview(event.data.meta) ?? readReview(event.data.message.content) ?? unavailableReview() }
      }
      if (event.type === 'tool/ptc-dispatch' && ['drama_shot', 'muse_production'].includes(event.data.name) && !event.data.isError && packagingCall(event.data.arguments)) {
        return { ...state, latest: readReview(event.data.content) ?? unavailableReview() }
      }
      return state
    } })
  ctx.effect(() => service.registerContextReviewer((agent: Agent, selection: SessionVideoSelection) => {
    if (ctx.tools.get('drama_shot', agent) !== definition) return ''
    const review = projections.stateOf(agent.session, 'dramaShotReview')?.latest ?? null
    return review === null ? '' : boundContext(recheck(review, selection, maxChars, agent.session.header.cwd)
      + (ctx.tools.get('muse_production', agent) ? 'Muse批量制作方案请用muse_production update刷新当前模型分包和素材候选，再自主复核。' : ''), maxChars)
  }))
  ctx.on('tools/result', (exec, result) => {
    if (!['drama_shot', 'muse_production'].includes(exec.name) || exec.agent === undefined || result.isError
      || ctx.tools.get('drama_shot', exec.agent) !== definition) return
    const review = metaReview(result.meta) ?? readReview(result.content)
    const selection = service.current(exec.agent)
    if (review === null || selection === null || review.revision === selection.revision) return
    exec.agent.inject(createUserMessage({ source: { kind: 'jubian-video-selection' },
      content: [{ type: 'text', text: boundContext('分包检查期间会话视频模型已切换；以下复核以最新选择为准。' + recheck(review, selection, maxChars, exec.agent.session.header.cwd), maxChars) }] }))
  })
}
