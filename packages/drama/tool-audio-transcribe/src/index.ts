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
  job_id: { type: 'string', required: true }, output_txt: { type: 'string' }, output_json: { type: 'string' }, output_srt: { type: 'string' },
  purpose: { type: 'string', enum: ['subtitles', 'screenplay'] },
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
    description: '使用当前 Muse 账号转写本地音频或视频。start 提交异步任务并返回收据；用 status 查询同一任务，完成后取得文字、字词时间戳 JSON 和 SRT。长音频自动分段并合并时间轴；可用于素材转写与字幕校时。需要先登录 Muse。',
    parameters: {
      method: { type: 'string', required: true, enum: ['start', 'status'], description: 'start=提取音轨并提交；status=按原收据查询、补传确认未受理的音轨并发布结果，补传可能计费。限流按 retry_after_seconds 等待后用原收据恢复；日额度、登录或任务冲突先处理，不直接重投。' },
      project: { type: 'string', required: true, description: '项目根目录，保存 transcript/jobs 收据及 transcript/raw 版本结果。' },
      input: { type: 'string', description: 'start 必填：获授权的本地音频或视频文件路径。' },
      receipt: { type: 'string', description: 'status 必填：start 返回的 transcript/jobs 收据路径。' },
      language: { type: 'string', enum: ['zh', 'auto'], description: 'start 识别语种；默认 zh。' },
      purpose: { type: 'string', enum: ['subtitles', 'screenplay'], description: 'start 用途：字幕校时用 subtitles（默认，极速）；音视频转剧本用 screenplay（标准）。status 沿用收据用途，不可更改同一任务用途。' },
    },
    output: { schema: outputSchema, render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      if (args.method === 'start') {
        if (!args.input) throw new Error('audio_transcribe start requires input')
        return await startAudioTranscription(args.project, args.input, args.language ?? 'zh', account, config, undefined, args.purpose, exec.signal)
      }
      if (!args.receipt) throw new Error('audio_transcribe status requires receipt')
      return await finishAudioTranscription(args.project, args.receipt, account, exec.signal)
    },
  }))
}
