/** Model tool for account-bound cloud speech transcription of local media. */
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { MuseAccountService } from '@deepseek-ai/dsh-muse-account'
import { finishAudioTranscription, probeMediaDuration, startAudioTranscription, startAudioTranscriptionBatch } from './runner.ts'

/** Cordis row name for model-visible speech transcription. */
export const name = 'tool-audio-transcribe'

/** The account service supplies the current cookie without a model-visible field. */
export const inject = ['tools', 'museAccount']

/** Deployment media executables and bounded local staging. */
export interface Config {
  /** FFmpeg executable used to extract the speech track. */
  readonly ffmpegPath: string
  /** FFprobe executable used to inspect the local input. */
  readonly ffprobePath: string
  /** Maximum time for one local probe or extraction command, in milliseconds. */
  readonly commandTimeoutMs: number
  /** Longest local media file accepted for a transcription job, in seconds. */
  readonly maxDurationSeconds: number
  /** Maximum duration of one cloud upload; longer input is split with preserved offsets. */
  readonly chunkSeconds: number
  /** Delay between native read-only task queries, in milliseconds. */
  readonly pollIntervalMs: number
  /** Largest extracted audio chunk accepted for staging, in bytes. */
  readonly maxAudioBytes: number
  /**
   * Total delay one call spends waiting out upload_busy or request_rate refusals
   * before offering the same staged upload again, in milliseconds; 0 returns the refusal at once.
   */
  readonly uploadRetryBudgetMs: number
  /** Largest number of files one batch start accepts. */
  readonly maxBatchInputs: number
}

/** Validated product settings; the gateway enforces its independent limits. */
export const Config: Schema<Config> = Schema.object({
  ffmpegPath: Schema.string().default('ffmpeg'),
  ffprobePath: Schema.string().default('ffprobe'),
  commandTimeoutMs: Schema.number().step(1).min(1_000).max(3_600_000).default(600_000),
  maxDurationSeconds: Schema.number().step(1).min(1).max(18_000).default(18_000),
  pollIntervalMs: Schema.number().step(1).min(1000).max(30_000).default(2000),
  chunkSeconds: Schema.number().step(1).min(1).max(7200).default(600),
  maxAudioBytes: Schema.number().step(1).min(1).max(536_870_912).default(100_000_000),
  uploadRetryBudgetMs: Schema.number().step(1).min(0).max(600_000).default(120_000),
  maxBatchInputs: Schema.number().step(1).min(1).max(100).default(10),
})

const resultProperties = {
  status: { type: 'string', required: true }, receipt: { type: 'string', required: true },
  job_id: { type: 'string', required: true }, diagnostic_job_id: { type: 'string', description: '长音轨结果中的诊断对应此原始分段 ID；所有分段的服务版本和诊断保留在原收据，不代表其他分段同样失败。' }, output_txt: { type: 'string' }, output_json: { type: 'string' }, output_srt: { type: 'string' },
  purpose: { type: 'string', enum: ['subtitles', 'screenplay'] },
  service_version: { type: 'string', enum: ['flash', 'standard-v1', 'standard-v2'], description: '原任务实际识别服务；旧任务未提供时不推断版本。' },
  queued: { type: 'boolean', description: '原任务已受理并正在等容量；不等于整个 ASR 池已满，不重复提交。' },
  provider_diagnostic: { type: 'object', additionalProperties: false, properties: {
    reason: { type: 'string', enum: ['timeout', 'transport', 'http', 'response', 'json', 'result', 'audio'] },
    operation: { type: 'string', enum: ['submit', 'query', 'flash'] },
    http_status: { type: 'number' }, provider_code: { type: 'string' },
    quota_type: { type: 'string', enum: ['qps', 'concurrency', 'audio_duration', 'audio_duration_saas', 'audio_duration_lifetime', 'text_words_lifetime', 'tokens_lifetime'], description: '供应商明确返回的额度种类；lifetime 表示试用额度耗尽，需在原应用恢复额度，不能当作普通排队。' },
  } },
  recovery: { type: 'object', additionalProperties: false, description: '按原任务实际恢复能力行动。no_query+inspect_receipt 表示该极速任务不能再向提供方查询，不继续盲等、不自动重投；客户端网络错误仍先回读服务端原任务。', properties: {
    capability: { type: 'string', enum: ['query_original_task', 'no_query', 'none'], required: true },
    next_action: { type: 'string', enum: ['poll_original', 'wait', 'inspect_receipt', 'use_result', 'resume_upload'], required: true },
    automatic_resubmit: { type: 'boolean', enum: [false], required: true },
    retry_after: { type: 'number', description: '网关下次查询原任务前的等待秒数；不授权重新提交，额度耗尽时先恢复原应用额度。' },
  } },
  error_code: { type: 'string', description: '安全错误类别；provider_rate 是服务额度或提交频率限制，按等待秒数恢复；daily_quota 先处理账号日额度，sign-in-required 先登录，idempotency_conflict 先核对原任务，不直接重投。' },
  retry_after_seconds: { type: 'number', description: '服务端建议等待的秒数；等待后沿用原收据。' },
  polling_note: { type: 'string' },
  progress: { type: 'object', additionalProperties: false, properties: { completed_parts: { type: 'number', required: true }, total_parts: { type: 'number', required: true } } },
  timing_warnings: { type: 'array', description: '旧分段实际音轨长于计划范围；已核对音轨摘要和实际时长，保留原词与时间戳，边界可能重叠。', items: { type: 'object', additionalProperties: false, properties: { part_id: { type: 'string', required: true }, planned_seconds: { type: 'number', required: true }, staged_seconds: { type: 'number', required: true } } } },
  speaker_summary: { type: 'object', additionalProperties: false, description: '完成产物中实际说话人标签的覆盖；读取 output_json 做角色映射，不能把分组数量当人数。没有标签仅提示，不影响原转写使用。', properties: {
    status: { type: 'string', enum: ['available', 'partial', 'not_provided'], required: true, description: 'available=所有片段有标签；partial=部分缺失；not_provided=本结果未提供标签。不能由此推断服务是否启用了分离。' },
    total_segments: { type: 'number', required: true }, labelled_segments: { type: 'number', required: true },
    unlabelled_segments: { type: 'number', required: true }, observed_groups: { type: 'number', required: true, description: '原始任务作用域内声学标签的去重数，不是人物数，也不建立跨集身份。' },
    note: { type: 'string', required: true },
  } },
  resume_status: { type: 'object', additionalProperties: false, description: '下一次原收据调用参数；inspect 只查询，status 仅在确认未受理时补传同 ID，不新建任务。', properties: {
    method: { type: 'string', enum: ['inspect', 'status'], required: true }, project: { type: 'string', required: true }, receipt: { type: 'string', required: true },
  } },
} as const

const batchResult = { type: 'object', additionalProperties: false, properties: {
  items: { type: 'array', required: true, description: '与 inputs 同序的逐集结果；字段同单集结果，input 为原输入。', items: {
    type: 'object', additionalProperties: false, properties: {
      input: { type: 'string', required: true }, ...resultProperties,
      status: { type: 'string' }, receipt: { type: 'string' }, job_id: { type: 'string' },
      error: { type: 'string', description: '该集出错原因，批次在此停止；修正后再 start。' },
    },
  } },
  not_started: { type: 'array', items: { type: 'string' }, description: '本次未处理的输入；处理停止原因后，把同一 inputs 原样再次 start 即可继续。' },
  polling_note: { type: 'string' },
} } as const

// Both branches are closed objects with disjoint required fields, so a result matches exactly one branch.
const outputSchema = { oneOf: [{ type: 'object', additionalProperties: false, properties: resultProperties }, batchResult] } as const

/** Prepended to a screenplay-purpose result the service reported as silent; the gateway's recovery fields stay unchanged. */
const SILENT_SCREENPLAY_NOTE = '剧本用途音轨被云端判为无语音（silent），不等于本集没有对白。先用 video_ocr 读硬字幕、用 video_inspect 核对口型和画面，不要只凭少量抽帧补写台词。确有对白时可用单个 input 并带 purpose: screenplay 再 start 重转一次（新版本，会计费；批量 inputs 只返回原 silent 收据）；重转仍为 silent 就以字幕和画面为准，不再重转。'

/**
 * Anchor a relative project root to the calling Session workspace, never to the Host process directory.
 * @param project - Model-supplied project root.
 * @param workspace - The calling Session's cwd, when it has one.
 * @returns Absolute project root.
 */
function projectRoot(project: string, workspace: string | undefined): string {
  if (isAbsolute(project)) return project
  if (workspace === undefined) throw new ToolArgsError([`project "${project}" is relative but this Session has no workspace; pass an absolute project path`])
  return resolve(workspace, project)
}

/**
 * Register one start/status tool; the Host account service keeps all credentials private.
 * @param ctx - Host context with the tool registry and MUSE account service.
 * @param config - Media binaries and local size/time limits.
 */
export function apply(ctx: Context, config: Config): void {
  const account = ctx.get('museAccount') as MuseAccountService
  ctx.tools.register(defineTool({
    name: 'audio_transcribe',
    description: '使用当前 Muse 账号转写本地音频或视频。start 提交异步任务并返回收据；多集用 inputs 一次提交，工具逐集上传，上传繁忙或请求过频时按服务端提示等待，并沿用同一收据重试。inspect 只查询原任务、不补传音轨，完成后发布文字、字词时间戳及说话人标签覆盖摘要；角色对齐读取 output_json，TXT/SRT 不含标签。status 允许按服务端恢复指示补传同 ID 音轨，可能计费。长音频自动分段并合并时间轴；inspect 可用 wait_seconds 在工具内等待查询。收据不会自行刷新，用本工具回读，不能只循环读本地文件，也不要删除收据。需要先登录 Muse。',
    parameters: {
      method: { type: 'string', required: true, enum: ['start', 'inspect', 'status'], description: 'start=提取音轨并提交；inspect=只回读原任务，绝不上传音轨，完成后发布本地结果；status=回读原收据，必要时按服务端恢复指示补传同 ID 音轨，可能计费。inspect_receipt 停止反复轮询，保留收据核对；限流按 retry_after_seconds 恢复。' },
      project: { type: 'string', required: true, description: '项目根目录，保存 transcript/jobs 收据及 transcript/raw 版本结果。' },
      input: { type: 'string', description: 'start 单个输入（与 inputs 二选一）：获授权的本地音频或视频文件路径；相对路径以 project 为基准。' },
      inputs: { type: 'array', items: { type: 'string' }, description: `start 多集输入（与 input 二选一，1–${config.maxBatchInputs} 个）：获授权的本地音频或视频路径，相对路径以 project 为基准。按顺序逐集提交，每集一张收据；已有同用途且源文件字节未变的收据沿用原收据，不重新计费；源文件字节变化按新输入提交；已完成或已失败的集需要重转时单独用 input。某集被拒或出错时停止，其余列入 not_started。` },
      wait_seconds: { type: 'number', description: 'inspect/status 在工具内持续只读查询的等待预算（0–30 秒），默认 0；单次网络请求另受请求超时约束。到时返回实际状态和下一次调用参数。' },
      receipt: { type: 'string', description: 'inspect/status 必填：start 返回的 transcript/jobs 收据路径；相对路径以 project 为基准。' },
      language: { type: 'string', enum: ['zh', 'auto'], description: 'start 识别语种；默认 zh。' },
      purpose: { type: 'string', enum: ['subtitles', 'screenplay'], description: 'start 用途：字幕校时用 subtitles（默认，极速）；音视频转小说或剧本用 screenplay（标准）。inspect/status 沿用收据用途，不可更改同一任务用途。' },
    },
    output: { schema: outputSchema, render: (_args, value): ContentBlock[] => {
      const results: readonly { status?: string; purpose?: string; error_code?: string }[] = 'items' in value ? value.items : [value]
      return [
        ...(results.some(item => item.error_code === 'queue_full') ? [{ type: 'text' as const, text: 'Muse 转写队列已满，请稍后重试' }] : []),
        ...(results.some(item => item.status === 'silent' && item.purpose === 'screenplay') ? [{ type: 'text' as const, text: SILENT_SCREENPLAY_NOTE }] : []),
        { type: 'text', text: JSON.stringify(value) },
      ]
    } },
    execute: async (args, exec) => {
      const project = projectRoot(args.project, exec.agent?.session.header.cwd)
      const pacing = { retryBudgetMs: config.uploadRetryBudgetMs }
      if (args.method === 'start') {
        if (args.input !== undefined && args.inputs !== undefined) throw new ToolArgsError(['start accepts input or inputs, not both'])
        if (args.inputs !== undefined) {
          if (args.inputs.length === 0 || args.inputs.length > config.maxBatchInputs) throw new ToolArgsError([`inputs must list 1 to ${config.maxBatchInputs} files`])
          return await startAudioTranscriptionBatch(project, args.inputs, args.language ?? 'zh', account, config, undefined, args.purpose, exec.signal, pacing)
        }
        if (!args.input) throw new ToolArgsError(['start requires input or inputs'])
        return await startAudioTranscription(project, args.input, args.language ?? 'zh', account, config, undefined, args.purpose, exec.signal, pacing)
      }
      if (!args.receipt) throw new Error('audio_transcribe inspect/status requires receipt')
      return await finishAudioTranscription(project, args.receipt, account, exec.signal, args.method === 'status', { waitMs: (args.wait_seconds ?? 0) * 1000, pollIntervalMs: config.pollIntervalMs, probe: (source, signal) => probeMediaDuration(source, config, signal) }, pacing)
    },
  }))
}
