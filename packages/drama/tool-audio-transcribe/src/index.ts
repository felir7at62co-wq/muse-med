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
  /** FFmpeg executable used to extract the compressed speech track. */
  readonly ffmpegPath: string
  /** FFprobe executable used to inspect the local input. */
  readonly ffprobePath: string
  /** Maximum time for one local probe or extraction command, in milliseconds. */
  readonly commandTimeoutMs: number
  /** Longest local media file accepted for a transcription job, in seconds. */
  readonly maxDurationSeconds: number
  /** Largest extracted MP3 accepted for staging, in bytes. */
  readonly maxAudioBytes: number
}

/** Validated product settings; the gateway enforces its independent limits. */
export const Config: Schema<Config> = Schema.object({
  ffmpegPath: Schema.string().default('ffmpeg'),
  ffprobePath: Schema.string().default('ffprobe'),
  commandTimeoutMs: Schema.number().step(1).min(1_000).max(3_600_000).default(600_000),
  maxDurationSeconds: Schema.number().step(1).min(1).max(18_000).default(18_000),
  maxAudioBytes: Schema.number().step(1).min(1).max(536_870_912).default(209_715_200),
})

const outputSchema = { type: 'object', additionalProperties: false, properties: {
  status: { type: 'string', required: true }, receipt: { type: 'string', required: true },
  job_id: { type: 'string', required: true }, output_txt: { type: 'string' }, output_json: { type: 'string' },
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
    description: '使用当前 Muse 账号转写本地音频或视频。start 提交异步任务并返回收据；用 status 查询同一任务，完成后取得带时间戳的转写文件。需要先登录 Muse。',
    parameters: {
      method: { type: 'string', required: true, enum: ['start', 'status'], description: 'start=提取音轨并提交；status=按原收据查询及发布结果。' },
      project: { type: 'string', required: true, description: '项目根目录，保存 transcript/jobs 收据及 transcript/raw 版本结果。' },
      input: { type: 'string', description: 'start 必填：获授权的本地音频或视频文件路径。' },
      receipt: { type: 'string', description: 'status 必填：start 返回的 transcript/jobs 收据路径。' },
      language: { type: 'string', enum: ['zh', 'auto'], description: 'start 识别语种；默认 zh。' },
    },
    output: { schema: outputSchema, render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args) => {
      if (args.method === 'start') {
        if (!args.input) throw new Error('audio_transcribe start requires input')
        return await startAudioTranscription(args.project, args.input, args.language ?? 'zh', account, config)
      }
      if (!args.receipt) throw new Error('audio_transcribe status requires receipt')
      return await finishAudioTranscription(args.project, args.receipt, account)
    },
  }))
}
