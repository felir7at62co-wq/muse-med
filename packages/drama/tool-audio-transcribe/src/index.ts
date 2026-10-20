/** Model tool for account-bound cloud speech transcription of local media. */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MuseAccountService } from '@deepseek-ai/dsh-muse-account'
import { finishAudioTranscription, startAudioTranscription } from './runner.ts'

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
  /** Largest extracted audio chunk accepted for staging, in bytes. */
  readonly maxAudioBytes: number
}

/** Validated product settings; the gateway enforces its independent limits. */
export const Config: Schema<Config> = Schema.object({
  ffmpegPath: Schema.string().default('ffmpeg'),
  ffprobePath: Schema.string().default('ffprobe'),
  commandTimeoutMs: Schema.number().step(1).min(1_000).max(3_600_000).default(600_000),
  maxDurationSeconds: Schema.number().step(1).min(1).max(18_000).default(18_000),
  chunkSeconds: Schema.number().step(1).min(1).max(7200).default(600),
  maxAudioBytes: Schema.number().step(1).min(1).max(536_870_912).default(100_000_000),
})

const outputSchema = { type: 'object', additionalProperties: false, properties: {
  status: { type: 'string', required: true }, receipt: { type: 'string', required: true },
  job_id: { type: 'string', required: true }, diagnostic_job_id: { type: 'string', description: '长音轨结果中的诊断对应此原始分段 ID；所有分段的服务版本和诊断保留在原收据，不代表其他分段同样失败。' }, output_txt: { type: 'string' }, output_json: { type: 'string' }, output_srt: { type: 'string' },
  purpose: { type: 'string', enum: ['subtitles', 'screenplay'] },
  service_version: { type: 'string', enum: ['flash', 'standard-v1', 'standard-v2'], description: '原任务实际识别服务；旧任务未提供时不推断版本。' },
  queued: { type: 'boolean', description: '原任务已受理并正在等容量；不等于整个 ASR 池已满，不重复提交。' },
  provider_diagnostic: { type: 'object', additionalProperties: false, properties: {
    reason: { type: 'string', enum: ['timeout', 'transport', 'http', 'response', 'json', 'result', 'audio'] },
    operation: { type: 'string', enum: ['submit', 'query', 'flash'] },
    http_status: { type: 'number' }, provider_code: { type: 'string' },
  } },
  recovery: { type: 'object', additionalProperties: false, description: '按原任务实际恢复能力行动。no_query+inspect_receipt 表示该极速任务不能再向提供方查询，不继续盲等、不自动重投；客户端网络错误仍先回读服务端原任务。', properties: {
    capability: { type: 'string', enum: ['query_original_task', 'no_query', 'none'], required: true },
    next_action: { type: 'string', enum: ['poll_original', 'wait', 'inspect_receipt', 'use_result', 'resume_upload'], required: true },
    automatic_resubmit: { type: 'boolean', enum: [false], required: true },
  } },
  error_code: { type: 'string', description: '安全错误类别；provider_rate 是服务额度或提交频率限制，按等待秒数恢复；daily_quota 先处理账号日额度，sign-in-required 先登录，idempotency_conflict 先核对原任务，不直接重投。' },
  retry_after_seconds: { type: 'number', description: '服务端建议等待的秒数；等待后沿用原收据。' },
  resume_status: { type: 'object', additionalProperties: false, description: '可恢复时的下一次调用参数；查询确认未受理后可能补传同 ID 音轨，不新建任务。', properties: {
    method: { type: 'string', enum: ['status'], required: true }, project: { type: 'string', required: true }, receipt: { type: 'string', required: true },
  } },
} } as const

/**
 * Register one start/status tool; the Host account service keeps all credentials private.
 * @param ctx - Host context with the tool registry and MUSE account service.
 * @param config - Media binaries and local size/time limits.
 */
export function apply(ctx: Context, config: Config): void {
  const account = ctx.get('museAccount') as MuseAccountService
  ctx.tools.register(defineTool({
    name: 'audio_transcribe',
    description: '使用当前 Muse 账号转写本地音频或视频。start 提交异步任务并返回收据；inspect 只查询原任务、不补传音轨，完成后发布文字与字词时间戳；status 允许按服务端恢复指示补传同 ID 音轨，可能计费。长音频自动分段并合并时间轴；需要先登录 Muse。',
    parameters: {
      method: { type: 'string', required: true, enum: ['start', 'inspect', 'status'], description: 'start=提取音轨并提交；inspect=只回读原任务，绝不上传音轨，完成后发布本地结果；status=回读原收据，必要时按服务端恢复指示补传同 ID 音轨，可能计费。inspect_receipt 停止反复轮询，保留收据核对；限流按 retry_after_seconds 恢复。' },
      project: { type: 'string', required: true, description: '项目根目录，保存 transcript/jobs 收据及 transcript/raw 版本结果。' },
      input: { type: 'string', description: 'start 必填：获授权的本地音频或视频文件路径。' },
      receipt: { type: 'string', description: 'inspect/status 必填：start 返回的 transcript/jobs 收据路径。' },
      language: { type: 'string', enum: ['zh', 'auto'], description: 'start 识别语种；默认 zh。' },
      purpose: { type: 'string', enum: ['subtitles', 'screenplay'], description: 'start 用途：字幕校时用 subtitles（默认，极速）；音视频转小说或剧本用 screenplay（标准）。inspect/status 沿用收据用途，不可更改同一任务用途。' },
    },
    output: { schema: outputSchema, render: (_args, value): ContentBlock[] => [
      ...(value.error_code === 'queue_full' ? [{ type: 'text' as const, text: 'Muse 转写队列已满，请稍后重试' }] : []),
      { type: 'text', text: JSON.stringify(value) },
    ] },
    execute: async (args, exec) => {
      if (args.method === 'start') {
        if (!args.input) throw new Error('audio_transcribe start requires input')
        return await startAudioTranscription(args.project, args.input, args.language ?? 'zh', account, config, undefined, args.purpose, exec.signal)
      }
      if (!args.receipt) throw new Error('audio_transcribe inspect/status requires receipt')
      return await finishAudioTranscription(args.project, args.receipt, account, exec.signal, args.method === 'status')
    },
  }))
}
