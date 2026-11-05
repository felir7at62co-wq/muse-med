/** Opt-in recovery modes and their single worker ownership. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { checkVideoMedia, VideoMediaDrainError, type VideoMediaDecoder } from './video-media-check.ts'
import { recoveryProject, recordedVideoPreview } from './video-recovery-project.ts'
import { reviewRecoveredVideo, runVideoRecovery } from './video-recovery.ts'
import { JubianVideoRecovery } from './video-recovery-service.ts'

/** Mutually exclusive new recovery entry points; neither is enabled by default. */
export interface VideoRecoveryConfig {
  /** Enable authenticated dynamic project selection and review. Incompatible with videoRecovery. */
  videoRecoverySettings?: boolean
  /** Fixed deployment project and optional original keys; incompatible with Settings mode. */
  videoRecovery?: {
    /** Absolute project directory bound to the original provider script. */
    projectDir: string
    /** Original keys to inspect; omission discovers all recoverable intents for the project. */
    keys?: string[]
    /** Absolute native FFmpeg executable. */
    ffmpegPath: string
    /** Fixed decoder deadline; omit when videoRecoveryDecodeTimeoutMs is provided. */
    decodeTimeoutMs?: number
  }
  /** Absolute Settings decoder override; omission uses the Host launch decoder when available. */
  videoRecoveryFfmpegPath?: string
  /** Independent decoder deadline; omission uses fixed.decodeTimeoutMs or watchTimeoutMs. */
  videoRecoveryDecodeTimeoutMs?: number
  /** Decoder termination grace in milliseconds; default 1000, integer 1..86400000. */
  videoRecoveryDecodeGraceMs?: number
  /** Collected bytes per decoder output stream; default 65536, integer 1..1048576. */
  videoRecoveryDecodeMaxOutputBytes?: number
}

/** Validated opt-in modes and complete process limits. */
export interface ResolvedVideoRecovery {
  readonly settings: boolean
  readonly fixed: VideoRecoveryConfig['videoRecovery']
  readonly ffmpegPath: string | undefined
  readonly timeoutMs: number
  readonly graceMs: number
  readonly maxOutputBytes: number
}

/**
 * Resolve recovery modes before any plugin effect is registered.
 * @param config - Optional deployment fields; omission disables both modes.
 * @param watchTimeoutMs - Already validated default decoder timeout.
 * @param launchedDecoder - Host launch decoder path; omission leaves Settings decoding unavailable.
 * @returns Explicit modes and bounded decoder limits.
 */
export function resolveVideoRecovery(config: VideoRecoveryConfig, watchTimeoutMs: number, launchedDecoder?: string): ResolvedVideoRecovery {
  if (config.videoRecoverySettings !== undefined && typeof config.videoRecoverySettings !== 'boolean') {
    throw new TypeError('videoRecoverySettings must be a boolean')
  }
  const fixed = config.videoRecovery
  if (config.videoRecoverySettings === true && fixed !== undefined) {
    throw new TypeError('videoRecoverySettings and videoRecovery are mutually exclusive')
  }
  if (fixed !== undefined && config.videoRecoveryFfmpegPath !== undefined) {
    throw new TypeError('videoRecoveryFfmpegPath configures Settings mode, not a fixed recovery project')
  }
  if (fixed?.decodeTimeoutMs !== undefined && config.videoRecoveryDecodeTimeoutMs !== undefined) {
    throw new TypeError('Set one video recovery decoder timeout')
  }
  const ffmpegPath = config.videoRecoveryFfmpegPath ?? (config.videoRecoverySettings === true ? launchedDecoder : fixed?.ffmpegPath)
  if ((config.videoRecoveryFfmpegPath !== undefined && (typeof config.videoRecoveryFfmpegPath !== 'string' || !isAbsolute(config.videoRecoveryFfmpegPath)))
    || (ffmpegPath !== undefined && (typeof ffmpegPath !== 'string' || !isAbsolute(ffmpegPath)))) {
    throw new TypeError('videoRecoveryFfmpegPath requires an absolute Host decoder path')
  }
  const timeoutMs = config.videoRecoveryDecodeTimeoutMs ?? fixed?.decodeTimeoutMs ?? watchTimeoutMs
  const graceMs = config.videoRecoveryDecodeGraceMs ?? 1000
  const maxOutputBytes = config.videoRecoveryDecodeMaxOutputBytes ?? 65536
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000
    || !Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 86400000
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1048576) {
    throw new TypeError('Video recovery requires bounded positive decoder timeout, grace and output limits')
  }
  if (fixed !== undefined && (!isAbsolute(fixed.projectDir) || !isAbsolute(fixed.ffmpegPath)
    || (fixed.keys !== undefined && (!Array.isArray(fixed.keys) || fixed.keys.length === 0
      || fixed.keys.some(key => typeof key !== 'string' || !key.trim()) || new Set(fixed.keys).size !== fixed.keys.length)))) {
    throw new TypeError('videoRecovery requires absolute projectDir and ffmpegPath and distinct nonempty optional keys')
  }
  return { settings: config.videoRecoverySettings === true, fixed, ffmpegPath, timeoutMs, graceMs, maxOutputBytes }
}

/**
 * Mount exactly one dynamic service or one fixed worker with explicit command review.
 * @param ctx - Owning Jubian plugin context.
 * @param config - Validated, mutually exclusive deployment modes.
 * @param options - Existing ledger, read-only transport factory, settings file and polling interval.
 */
export async function mountVideoRecovery(ctx: Context, config: ResolvedVideoRecovery, options: {
  ledger: JubianLedger
  clientForProject: (projectDir: string) => JubianClient
  settingsPath: string
  intervalMs: number
}): Promise<void> {
  if (config.settings) {
    await ctx.plugin(JubianVideoRecovery, { ...options, ffmpegPath: config.ffmpegPath,
      decodeTimeoutMs: config.timeoutMs, decodeGraceMs: config.graceMs, decodeMaxOutputBytes: config.maxOutputBytes }).await()
    return
  }
  const fixed = config.fixed
  if (fixed === undefined) return
  await ctx.plugin({ name: 'jubian-fixed-video-recovery', inject: ['tools', 'subprocess', 'workingDirectory'],
    async apply(scope: Context) {
      const lifetime = new AbortController()
      const operations = new Set<Promise<unknown>>()
      let closing = false
      let unregister = () => {}
      let done = Promise.resolve()
      const initialized = Promise.resolve().then(async () => {
        const project = await recoveryProject(fixed.projectDir, lifetime.signal)
        const ffmpegPath = await scope.subprocess.resolveExecutable(fixed.ffmpegPath, undefined, lifetime.signal)
        lifetime.signal.throwIfAborted()
        const decoder: VideoMediaDecoder = { subprocess: scope.subprocess, ffmpegPath,
          timeoutMs: config.timeoutMs, graceMs: config.graceMs, maxOutputBytes: config.maxOutputBytes }
        done = runVideoRecovery(options.clientForProject(project.directory), options.ledger, project.directory,
          fixed.keys, options.intervalMs, lifetime.signal,
          () => { scope.logger.warn('Video recovery read failed; retaining the original key') },
          (url, signal) => checkVideoMedia(url, decoder, signal))
        void done.catch((error: unknown) => {
          if (!lifetime.signal.aborted) scope.logger.warn('Video recovery worker stopped: %s', error instanceof Error ? error.message : String(error))
        })
        unregister = scope.tools.register(defineTool({
          name: 'jubian_video_review',
          description: '读取本项目原 key 的视频质检报告。approve/reject 仅接受用户当前消息完整命令：动作、原 key、digest，以空格分隔。不会重新生成或付费。',
          parameters: {
            action: { type: 'string', enum: ['read', 'approve', 'reject'], required: true },
            idempotency_key: { type: 'string', required: true }, digest: { type: 'string' },
          },
          output: { schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute(args, exec) {
            if (closing) return Promise.reject(new Error('Video recovery is shutting down'))
            const signal = AbortSignal.any([lifetime.signal, exec.signal])
            const operation = Promise.resolve().then(async () => {
              signal.throwIfAborted()
              const agent = exec.agent
              if (agent === undefined) throw new Error('Video review requires the configured project session')
              const directory = await scope.workingDirectory.ensure(agent, signal)
              const current = await recoveryProject(directory, signal)
              const record = await options.ledger.find(args.idempotency_key)
              if (current.directory !== project.directory || (fixed.keys !== undefined && !fixed.keys.includes(args.idempotency_key))
                || !await recordedVideoPreview(record, project, signal)) throw new Error('Video review requires the configured project session and original key')
              signal.throwIfAborted()
              if (args.action === 'read') return reviewRecoveredVideo(project.directory, args.idempotency_key, undefined, signal)
              const message = agent.session.deriveMessages().findLast(item => item.role === 'user' && item.source.kind === 'user')
              const text = message?.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
              if (!args.digest || text?.trim() !== `${args.action} ${args.idempotency_key} ${args.digest}`) {
                throw new Error('Video review requires the exact latest user decision, original key and report digest')
              }
              return reviewRecoveredVideo(project.directory, args.idempotency_key,
                { action: args.action, digest: args.digest }, signal)
            })
            operations.add(operation)
            void operation.then(() => { operations.delete(operation) }, () => { operations.delete(operation) })
            return operation
          },
        }))
      })
      scope.effect(() => async () => {
        closing = true
        unregister()
        lifetime.abort(new Error('Fixed video recovery disposed'))
        const settled = await Promise.allSettled([initialized, ...operations, done])
        const incomplete = settled.find(result => result.status === 'rejected' && result.reason instanceof VideoMediaDrainError)
        if (incomplete?.status === 'rejected') throw incomplete.reason
      })
      await initialized
    },
  }).await()
}
