/** Host-owned connection shared by scoped Lvpaopao tool consumers. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-agent'
import { Config as TransportConfig, validateConfig } from './config.ts'
import { JsonlRequestPort } from './jsonl.ts'
import { BridgeError, type Action, type Parameters } from './port.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Single Host-owned Windows target connection; consumers borrow its requests. */
    lvpaopaoBridge: LvpaopaoBridge
  }
}

/** Host configuration; connection details remain outside Session logs. */
export interface BridgeConfig {
  /** Absolute owner-private JSON file containing the transport configuration. */
  connectionFile: string
  /** Maximum waiting requests, excluding the one currently executing. */
  maxQueuedRequests: number
}

interface QueuedRequest {
  readonly action: Action
  readonly params: Parameters
  readonly signal: AbortSignal
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly detach: () => void
}

/** Read one bounded private file without following a replacement symlink. */
function readConnection(path: string): TransportConfig | undefined {
  if (!isAbsolute(path) || /[\x00\r\n]/.test(path)) throw new Error('lvpaopao: connectionFile must be absolute')
  let info
  try { info = lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('lvpaopao: connection file is unreadable')
  }
  if (!info.isFile() || info.isSymbolicLink()
    || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
    throw new Error('lvpaopao: connection file must be owner-private and regular')
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(descriptor)
    if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error('lvpaopao: connection file changed')
    const bytes = Buffer.alloc(65537)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, size)
      if (count === 0) break
      size += count
    }
    const after = fstatSync(descriptor)
    if (size > 65536 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error('lvpaopao: connection file is oversized or changed')
    }
    let value: unknown
    try { value = JSON.parse(bytes.subarray(0, size).toString('utf8')) }
    catch (error) { void error; throw new Error('lvpaopao: connection file must contain valid JSON') }
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !Object.hasOwn(TransportConfig.dict ?? {}, key))) {
      throw new Error('lvpaopao: connection file contains unknown fields')
    }
    try { return validateConfig(Schema.resolve(value, TransportConfig, {})[0] as TransportConfig) }
    catch (error) { void error; throw new Error('lvpaopao: connection configuration is invalid') }
  } finally { closeSync(descriptor) }
}

/** Single connection owner with bounded FIFO admission and explicit status-only recovery. */
export default class LvpaopaoBridge extends Service {
  static inject = ['subprocess', 'agents']

  static Config: Schema<BridgeConfig> = Schema.object({
    connectionFile: Schema.string().default(dshHomePath('lvpaopao', 'connection.json')),
    maxQueuedRequests: Schema.number().step(1).min(1).max(64).default(8),
  })

  private readonly settings: TransportConfig | undefined
  private readonly queue: QueuedRequest[] = []
  private readonly lifetime = new AbortController()
  private port: JsonlRequestPort | undefined
  private pump: Promise<void> | undefined
  private generationCleanup: Promise<void> | undefined
  private terminal: BridgeError | undefined
  private cleanupFailed = false
  private closing = false
  private disposal: Promise<void> | undefined

  constructor(ctx: Context, private readonly config: BridgeConfig) {
    const settings = readConnection(config.connectionFile)
    super(ctx, 'lvpaopaoBridge')
    this.settings = settings
    ctx.effect(() => () => this.dispose(), 'lvpaopao shared target cleanup')
  }

  /** Validated immutable connection settings, or undefined until configured and restarted. */
  get configuration(): TransportConfig | undefined { return this.settings }

  /**
   * Queue one operation without giving its consumer ownership of the connection.
   * Only an explicit status request may recover a failed generation after confirmed cleanup.
   * @param action - Allowlisted operation; business operations are never replayed.
   * @param params - Validated operation arguments, never retained in Session state here.
   * @param signal - Cancels this request; unconfirmed cancellation can retire the shared generation.
   * @returns The helper result for the caller to validate and project.
   */
  request(action: Action, params: Parameters, signal: AbortSignal): Promise<unknown> {
    if (this.closing) return Promise.reject(new BridgeError('connection-closed'))
    if (this.settings === undefined) return Promise.reject(new BridgeError('unconfigured'))
    if (signal.aborted) return Promise.reject(new BridgeError('cancelled'))
    if (this.queue.length >= this.config.maxQueuedRequests) return Promise.reject(new BridgeError('request-capacity'))
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        const index = this.queue.indexOf(request)
        if (index === -1) return
        this.queue.splice(index, 1); request.detach(); reject(new BridgeError('cancelled'))
      }
      const request: QueuedRequest = { action, params, signal, resolve, reject,
        detach: () => signal.removeEventListener('abort', abort) }
      signal.addEventListener('abort', abort, { once: true })
      this.queue.push(request)
      this.startPump()
    })
  }

  private startPump(): void {
    if (this.pump !== undefined) return
    this.pump = this.ctx.agents.withoutInitiator(async () => {
      while (this.queue.length > 0 && !this.closing) {
        const request = this.queue.shift()!
        request.detach()
        try { request.resolve(await this.perform(request)) }
        catch (error) { request.reject(error instanceof BridgeError ? error : new BridgeError('transport-error')) }
      }
    }).finally(() => {
      this.pump = undefined
      if (this.queue.length > 0 && !this.closing) this.startPump()
    })
  }

  private async perform(request: QueuedRequest): Promise<unknown> {
    const signal = AbortSignal.any([request.signal, this.lifetime.signal])
    if (signal.aborted) throw new BridgeError('cancelled')
    if (this.terminal !== undefined) {
      if (request.action !== 'status' || this.cleanupFailed) throw this.terminal
      await this.generationCleanup
      signal.throwIfAborted()
      this.port = undefined; this.generationCleanup = undefined; this.terminal = undefined
    }
    // request() admitted only a configured bridge; settings stay immutable for this Host lifetime.
    const settings = this.settings!
    this.port ??= new JsonlRequestPort(this.ctx.subprocess, settings)
    try { return await this.port.request(request.action, request.params, signal) }
    catch (error) {
      if (error instanceof BridgeError && error.code === 'cancelled' && !this.port.terminalFailure) throw error
      this.terminal = error instanceof BridgeError ? error : new BridgeError('transport-error')
      try { await this.closeGeneration() }
      catch (cleanupError) {
        void cleanupError
        this.cleanupFailed = true
        this.terminal = new BridgeError('remote-cleanup-unconfirmed')
      }
      throw this.terminal
    }
  }

  private closeGeneration(): Promise<void> {
    return this.generationCleanup ??= this.port?.dispose() ?? Promise.resolve()
  }

  /** Stop new admission, settle caller work and await the remote managed range. */
  private dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.closing = true; this.lifetime.abort()
      for (const request of this.queue.splice(0)) {
        request.detach(); request.reject(new BridgeError('connection-closed'))
      }
      await this.pump
      await this.closeGeneration()
    })()
  }
}
