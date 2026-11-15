/** Early stdin lifetime and named-profile plugin task ownership. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'
import { bindGuardianInput } from './episode-guardian-protocol.ts'
import type { GuardianRequest, GuardianReply } from './episode-guardian-protocol.ts'
import { guardianParsers } from './episode-guardian-journal.ts'
import { runWithEncoderGate } from './episode-guardian-fence.ts'
import type { ExecutionIdentity, GuardianJournal, CandidateEvidence } from './episode-guardian-fence.ts'
import { GuardianMediaChannel } from './episode-guardian-media.ts'
import type { ProcessChannel } from '@deepseek-ai/dsh-tool-episode-render'

/** Validated plugin Config; its JSON schema supplies deployment defaults. */
export interface GuardianWorkerConfig {
  readonly descriptorPath: string
  readonly descriptorSha256: string
  readonly requestBytes: number
  readonly replyBytes: number
  readonly descriptorBytes: number
  readonly journalBytes: number
  readonly lockWaitMs: number
  readonly mediaGraceMs: number
  readonly mediaStdoutBytes: number
  readonly mediaStderrBytes: number
  readonly diagnosticBytes: number
}

/** Values are decoded from the descriptor bytes that passed its expected SHA. */
export interface CapturedEpisodeExecution {
  readonly identity: ExecutionIdentity
  readonly stageRoot: string
  readonly ffmpeg: string
  readonly ffprobe: string
  readonly retry: 'initial' | 'host-disconnect-recovery' | 'explicit-retry'
}

/**
 * The adapter owns verified immutable inputs and resolved renderer settings.
 * Callbacks cannot retarget the project, settings or provider from mutable UI state.
 */
export interface EpisodeGuardianAdapter {
  /** Verify private profile, roots, descriptor bytes and exact request identity.
   * @param config - Validated worker limits and descriptor reference.
   * @param request - Strict single-frame request.
   * @param signal - Host pipe lifetime.
   * @returns Verified captured execution facts. */
  load(config: GuardianWorkerConfig, request: GuardianRequest, signal: AbortSignal): Promise<CapturedEpisodeExecution>
  /** Build the durable owner adapter.
   * @param execution - Verified captured execution.
   * @param config - Validated byte and lock limits.
   * @returns Strict job admission and execution journal operations. */
  journal(execution: CapturedEpisodeExecution, config: GuardianWorkerConfig): GuardianJournal
  /** Render from captured inputs through the owned media channel.
   * @param execution - Verified captured execution.
   * @param channel - Guardian-owned native process channel.
   * @param signal - Host pipe lifetime.
   * @returns Candidate bytes after renderer validation and hashing. */
  render(execution: CapturedEpisodeExecution, channel: ProcessChannel, signal: AbortSignal): Promise<CandidateEvidence>
}

/**
 * Called by the named apply(ctx, config) plugin; returns immediately so dsh
 * can commit appReady. The effect owns and awaits the entire worker task.
 * @param ctx - Named-profile plugin scope with subprocess injection.
 * @param config - Validated descriptor reference and resource limits.
 * @param createAdapter - Immutable input and renderer adapter factory.
 */
export function installEpisodeGuardian(ctx: Context, config: GuardianWorkerConfig, createAdapter: () => EpisodeGuardianAdapter): void {
  // Must be the first operation that can resume/read stdin or begin async work.
  const transport = bindGuardianInput(process.stdin, config.requestBytes, guardianParsers.parseRequest)
  let adapter: EpisodeGuardianAdapter
  try { adapter = createAdapter() } catch (error) {
    transport.cancel(); transport.dispose()
    throw error
  }
  const appExit = ctx.get('appExit')
  const appReady = ctx.get('appReady')
  if (appExit === undefined || appReady === undefined) {
    transport.cancel(); transport.dispose()
    throw new Error('episode guardian: named dsh profile launcher is required')
  }
  let media: GuardianMediaChannel | undefined
  let cancelExit = (): void => {}
  let cancelReady = (): void => {}
  const ready = new Promise<void>((resolve, reject) => {
    const aborted = (): void => { reject(new Error('episode guardian: cancelled before profile readiness')) }
    transport.signal.addEventListener('abort', aborted, { once: true })
    const unsubscribe = appReady.onReady(() => {
      transport.signal.removeEventListener('abort', aborted); resolve()
    })
    cancelReady = () => { unsubscribe(); transport.signal.removeEventListener('abort', aborted) }
    if (transport.signal.aborted) aborted()
  })
  void ready.catch((_cancelledReadiness: unknown) => { /* operation owns the rejection. */ })
  const diagnose = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : 'operation failed without an Error diagnostic'
    process.stderr.write(Buffer.from('episode guardian: ' + detail + '\n').subarray(0, config.diagnosticBytes))
  }
  const operation = async (): Promise<void> => {
    const request = await transport.request
    await ready
    const execution = await adapter.load(config, request, transport.signal)
    transport.signal.throwIfAborted()
    media = new GuardianMediaChannel({ subprocess: ctx.subprocess, cwd: execution.stageRoot,
      ffmpeg: execution.ffmpeg, ffprobe: execution.ffprobe, graceMs: config.mediaGraceMs,
      stdoutBytes: config.mediaStdoutBytes, stderrBytes: config.mediaStderrBytes, signal: transport.signal })
    const result = await runWithEncoderGate({ journal: adapter.journal(execution, config),
      identity: execution.identity, signal: transport.signal, lockWaitMs: config.lockWaitMs,
      retry: execution.retry, media,
      render: async () => {
        try { return await adapter.render(execution, mediaChannel(), transport.signal) }
        catch (error) { diagnose(error); throw error }
      } })
    const reply: GuardianReply = { version: 1, kind: 'result', identity: execution.identity, result }
    const frame = Buffer.from(JSON.stringify(reply) + '\n')
    if (frame.length > config.replyBytes) throw new Error('episode guardian: reply exceeds limit')
    // A closed Host may reject this write; the disk drain remains authoritative.
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(frame, (error) => { if (error === null || error === undefined) resolve(); else reject(error) })
    })
    cancelExit = appReady.onReady(() => { appExit(result.kind === 'unknown' ? 1 : 0) })
  }
  function mediaChannel(): GuardianMediaChannel {
    if (media === undefined) throw new Error('episode guardian: media channel is not mounted')
    return media
  }
  let settled = Promise.resolve()
  // SIGTERM or launcher failure may start disposal independently of stdout EOF.
  ctx.effect(() => async () => {
    transport.cancel()
    await settled
    if (media !== undefined) await media.stopAndJoin()
    cancelReady(); cancelExit(); transport.dispose()
  }, 'episode guardian task and media drain')
  // The owner is registered before the operation can read a request or await readiness.
  settled = operation().catch(async (_operationFailed: unknown) => {
    diagnose(_operationFailed)
    // If joining cannot prove empty, no proof is synthesized by this handler.
    if (media !== undefined) await media.stopAndJoin()
    cancelExit = appReady.onReady(() => { appExit(1) })
  })
}
