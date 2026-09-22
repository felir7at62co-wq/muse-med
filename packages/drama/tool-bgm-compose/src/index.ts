/** Cordis plugin exposing deterministic short-drama BGM preview, composition, and verification. */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { runDramaBgm } from './compose.ts'
import { createSubprocessChannel } from './media.ts'

export { runDramaBgm } from './compose.ts'
export type { DramaBgmArguments, DramaBgmReport } from './types.ts'

/** Cordis plugin identity. */
export const name = 'tool-bgm-compose'

/** Required registries and the provider-managed process service. */
export const inject = ['tools', 'subprocess']

/** Deployment-varying executable and subprocess limits. */
export interface Config {
  /** FFmpeg executable or command name. */
  readonly ffmpegPath?: string
  /** ffprobe executable or command name. */
  readonly ffprobePath?: string
  /** Maximum duration of one media command. */
  readonly commandTimeoutMs?: number
  /** Provider termination grace. */
  readonly terminationGraceMs?: number
  /** Collected output cap for each process stream. */
  readonly outputMaxBytes?: number
}

/** Validate and default plugin configuration. */
export const Config: z<Config> = z.object({
  ffmpegPath: z.string().default('ffmpeg'),
  ffprobePath: z.string().default('ffprobe'),
  commandTimeoutMs: z.number().min(1).max(3_600_000).default(300_000),
  terminationGraceMs: z.number().min(1).max(60_000).default(5_000),
  outputMaxBytes: z.number().min(1).max(67_108_864).default(1_048_576),
})

const SegmentSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    track: { type: 'string', required: true, description: '计划里的曲目名。' },
    source: { type: 'string', required: true, description: '源曲绝对路径。' },
    source_sha256: { type: 'string', required: true, description: '实际源文件 SHA-256。' },
    start_seconds: { type: 'number', required: true, description: '正文时间线起点。' },
    end_seconds: { type: 'number', required: true, description: '正文时间线终点。' },
    reason: { type: 'string', required: true, description: 'Agent 记录的剧情选曲理由。' },
    input_duration_seconds: { type: 'number', required: true, description: '交叉淡化前消耗的源曲长度。' },
    source_start_seconds: { type: 'number', required: true, description: '源曲实际起播点。' },
    source_start_kind: { type: 'string', required: true, enum: ['explicit', 'onset'],
      description: 'explicit=计划指定；onset=在 1–5 秒窗口检测首个可听起音。' },
    source_mean_db: { type: 'number', required: true, description: '源窗口实测平均响度。' },
    applied_gain_db: { type: 'number', required: true, description: '应用的响度增益，自动提升不超过 9 dB。' },
    valence: { type: 'number', description: '计划可选：bgm_match 返回的实际愉悦度。' },
    arousal: { type: 'number', description: '计划可选：bgm_match 返回的实际能量。' },
  },
} as const

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    method: { type: 'string', required: true, enum: ['preview', 'compose', 'verify'] },
    episode: { type: 'string', required: true },
    project: { type: 'string', required: true },
    plan: { type: 'string', required: true },
    timeline: { type: 'string', required: true },
    output: { type: 'string', required: true },
    report: { type: 'string', required: true },
    body_duration_seconds: { type: 'number', required: true },
    crossfade_seconds: { type: 'number', required: true },
    segments: { type: 'array', required: true, items: SegmentSchema },
    repeated_sequence_episodes: { type: 'array', required: true, items: { type: 'string' } },
    media: {
      type: 'object', required: true, additionalProperties: false,
      properties: {
        codec: { type: 'string', required: true },
        sample_rate: { type: 'integer', required: true },
        channels: { type: 'integer', required: true },
        duration_seconds: { type: 'number', required: true },
        size_bytes: { type: 'integer', required: true },
        sha256: { type: 'string', required: true },
      },
    },
  },
} as const

const DESCRIPTION = '短剧整集 BGM 合成工具；只执行 Agent 已确认的 episodes/segments 计划，不选曲、不替代试听。'
  + '可先用 bgm_match 获取带实测愉悦度/能量的候选，再由 Agent 按剧情选择曲目、切点和理由并写入计划。'
  + 'preview=安全预检：验证时间线、来源和完整连续覆盖，检测 1–5 秒内的起音，测量源窗口平均响度并计算目标 -17.5 dB、最大 +9 dB 的增益，不写正式产物。'
  + 'compose=按计划截取源曲，以计划 crossfade_seconds（默认 1.5 秒）交叉淡化，首尾淡入淡出，输出 48kHz 双声道 pcm_s16le WAV；'
  + '先在同目录暂存并 ffprobe 回读，整批成功后才无覆盖发布 WAV 与 generation.json，失败会清理暂存文件。'
  + 'verify=只回读已有 WAV 的编码、采样率、声道、时长、大小和 SHA-256，不读取源曲、不重写文件，segments 为空。'
  + 'compose 返回的 output 传给 drama_render.bgm，同一 plan 传给 drama_render.bgm_plan。'
  + '本工具不依赖 bgm_match；bgm_match 的 m-a-p/MERT-v1-95M 骨干采用 CC-BY-NC-4.0，仅限非商业用途，只要使用其候选就必须遵守。'

/**
 * Register the `drama_bgm` model tool.
 * @param ctx - Host context carrying tool and subprocess services.
 * @param config - Deployment executable and subprocess limits.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolvedConfig = Config(config) as Required<Config>
  ctx.tools.register(defineTool({
    name: 'drama_bgm',
    description: DESCRIPTION,
    parameters: {
      method: { type: 'string', required: true, enum: ['preview', 'compose', 'verify'],
        description: 'preview=预检且不发布；compose=合成并无覆盖发布；verify=核验已有 WAV。' },
      project: { type: 'string', required: true, description: '短剧项目根目录。' },
      episode: { type: 'integer', required: true, description: '正整数集号，内部补成两位。' },
      timeline: { type: 'string', required: true,
        description: '项目内时间线 JSON，必须含 body_end，通常为 editing/<集>-timeline.json。' },
      plan: { type: 'string', required: true,
        description: '项目内 episodes/segments BGM 计划 JSON；段落必须连续完整覆盖正文。' },
      output: { type: 'string', description: '项目内 WAV 路径；省略为 audio/bgm/<集>.wav。' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args, exec) => await runDramaBgm(args, {
      ffmpegPath: resolvedConfig.ffmpegPath,
      ffprobePath: resolvedConfig.ffprobePath,
      channel: createSubprocessChannel(
        ctx.subprocess,
        resolve(args.project),
        resolvedConfig.commandTimeoutMs,
        resolvedConfig.terminationGraceMs,
        resolvedConfig.outputMaxBytes,
      ),
      signal: exec.signal,
    }),
  }))
}
