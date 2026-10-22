/** Host-owned connection shared by scoped Lvpaopao tool consumers. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-agent'
import { Config as TransportConfig, validateConfig, verifyLocalHelper, localHelperEnvironment } from './config.ts'
import { JsonlRequestPort } from './jsonl.ts'
import { BridgeError, type Action, type Parameters } from './port.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Single Host-owned local or SSH target connection; consumers borrow its requests. */
    lvpaopaoBridge: LvpaopaoBridge
  }
}

/** Host configuration; connection details remain outside Session logs. */
export interface BridgeConfig {
  /** Absolute owner-private JSON file containing the transport configuration. */
  connectionFile: string
  /** Maximum waiting requests, excluding the one currently executing. */
  maxQueuedRequests: number
  /** Prepare the packaged local helper when no explicit connection file exists. */
  autoSetup: boolean
  /** Host-selected Python executable; never supplied by model arguments. */
  pythonExecutable: string
  /** Installed read-only native source tree. */
  resourcesDirectory: string
  /** Maximum local preparation and target-readiness wait. */
  setupTimeoutMs: number
  /** Bound for setup process range cleanup. */
  setupShutdownTimeoutMs: number
  /** Maximum managed helper connection lifetime for a long download job. */
  helperLifetimeMs: number
  /** Maximum verified native callbacks admitted during one helper connection. */
  helperMaxCallbacks: number
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
    autoSetup: Schema.boolean().default(true),
    pythonExecutable: Schema.string().default(process.env.MUSE_LVPAOPAO_PYTHON_PATH || process.env.MUSE_DOUYIN_PYTHON_PATH || ''),
    resourcesDirectory: Schema.string().default(fileURLToPath(new URL('../native/', import.meta.url))),
    setupTimeoutMs: Schema.number().step(1).min(1000).max(600000).default(120000),
    setupShutdownTimeoutMs: Schema.number().step(1).min(100).max(60000).default(10000),
    helperLifetimeMs: Schema.number().step(1).min(60000).max(14400000).default(3600000),
    helperMaxCallbacks: Schema.number().step(1).min(1).max(16384).default(4096),
  })

  private settings: TransportConfig | undefined
  private autoPrepared = false
  private initialization: Promise<TransportConfig> | undefined
  private setupCleanupFailure: BridgeError | undefined
  private initializationFailure: BridgeError | undefined
  private resolvingRequests = 0
  private readonly runtimeHome: string
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
    if (config.autoSetup && (!isAbsolute(config.resourcesDirectory) || /[\x00\r\n]/.test(config.resourcesDirectory))) throw new Error('lvpaopao: resourcesDirectory must be absolute')
    if (config.pythonExecutable !== undefined && /[\x00\r\n]/.test(config.pythonExecutable)) throw new Error('lvpaopao: invalid Python executable')
    super(ctx, 'lvpaopaoBridge')
    this.settings = settings
    this.runtimeHome = dshHomePath('lvpaopao', 'runtime')
    ctx.effect(() => () => this.dispose(), 'lvpaopao shared target cleanup')
  }

  /** Validated immutable settings, available after an explicit file or local preparation resolves. */
  get configuration(): TransportConfig | undefined { return this.settings }

  /**
   * Queue one operation without giving its consumer ownership of the connection.
   * Only an explicit status request may recover a failed generation after confirmed cleanup.
   * @param action - Allowlisted operation; business operations are never replayed.
   * @param params - Validated operation arguments, never retained in Session state here.
   * @param signal - Cancels this request; unconfirmed cancellation can retire the shared generation.
   * @returns The helper result for the caller to validate and project.
   */
  async request(action: Action, params: Parameters, signal: AbortSignal): Promise<unknown> {
    if (this.closing) throw new BridgeError('connection-closed')
    if (signal.aborted) throw new BridgeError('cancelled')
    if (this.resolvingRequests >= this.config.maxQueuedRequests + 1) throw new BridgeError('request-capacity')
    this.resolvingRequests++
    try { await this.resolveConfiguration(signal, action === 'status') }
    finally { this.resolvingRequests-- }
    if (this.closing) throw new BridgeError('connection-closed')
    if (signal.aborted) throw new BridgeError('cancelled')
    if (this.queue.length >= this.config.maxQueuedRequests) throw new BridgeError('request-capacity')
    return await new Promise((resolve, reject) => {
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

  /**
   * Resolve one shared local preparation without inheriting a caller's authority or lifetime.
   * @param signal - Cancels this caller's wait; only Host disposal aborts preparation.
   * @param recover - Explicit status-only retry after a failed setup range was confirmed empty.
   * @returns Immutable explicit or locally prepared settings; failure never selects SSH implicitly.
   */
  async resolveConfiguration(signal: AbortSignal, recover = false): Promise<TransportConfig> {
    if (this.closing) throw new BridgeError('connection-closed')
    if (signal.aborted) throw new BridgeError('cancelled')
    if (this.settings !== undefined) return this.settings
    if (!this.config.autoSetup) throw new BridgeError('unconfigured')
    if (recover && this.setupCleanupFailure === undefined && this.initializationFailure !== undefined
      && ['setup-required', 'setup-timeout'].includes(this.initializationFailure.code)) {
      this.initialization = undefined; this.initializationFailure = undefined
    }
    this.initialization ??= this.ctx.agents.withoutInitiator(async () => {
      const settings = await this.prepareLocal()
      if (this.closing) throw new BridgeError('connection-closed')
      this.settings = settings; this.autoPrepared = true
      return settings
    }).catch((error: unknown) => {
      this.initializationFailure = error instanceof BridgeError ? error : new BridgeError('setup-required')
      throw this.initializationFailure
    })
    const preparation = this.initialization
    return await new Promise<TransportConfig>((resolve, reject) => {
      const abort = (): void => reject(new BridgeError('cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      void preparation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    })
  }

  private async prepareLocal(): Promise<TransportConfig> {
    if (!this.config.pythonExecutable?.trim() || /[\x00\r\n]/.test(this.config.pythonExecutable)
      || !isAbsolute(this.config.resourcesDirectory) || /[\x00\r\n]/.test(this.config.resourcesDirectory)) throw new BridgeError('setup-required')
    const helper = join(this.runtimeHome, 'passive-probe', 'next-stage', 'run-persistent-host.py')
    const boot = join(this.config.resourcesDirectory, 'boot.py')
    try {
      const info = await lstat(boot)
      if (!info.isFile() || info.isSymbolicLink() || resolve(await realpath(boot)) !== resolve(boot)) throw new BridgeError('setup-required')
    } catch (error) { void error; throw new BridgeError('setup-required') }
    const active = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.setupTimeoutMs)])
    const handle = this.ctx.subprocess.spawn({ argv: [this.config.pythonExecutable, '-u', boot, '--prepare',
      '--home', this.runtimeHome, '--resources', this.config.resourcesDirectory, '--lifetime-ms', String(this.config.helperLifetimeMs),
      '--max-callbacks', String(this.config.helperMaxCallbacks)],
      cwd: this.config.resourcesDirectory, env: localHelperEnvironment(), stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: 'pipe' },
      graceMs: this.config.setupShutdownTimeoutMs, signal: active })
    let stderr = '', waitingReported = false, failed = true
    const onData = (chunk: Buffer | string): void => {
      stderr += chunk.toString()
      if (stderr.length > 4096) { stderr = ''; return }
      for (;;) {
        const newline = stderr.indexOf('\n'); if (newline === -1) break
        const line = stderr.slice(0, newline); stderr = stderr.slice(newline + 1)
        try {
          const value: unknown = JSON.parse(line)
          if (!waitingReported && value !== null && typeof value === 'object' && !Array.isArray(value)
            && Object.keys(value).length === 1 && 'event' in value && value.event === 'waiting_target') {
            waitingReported = true; this.ctx.logger.info('lvpaopao: waiting-target')
          }
        } catch (error) { void error; /* Unrecognized diagnostics never enter logs or model results. */ }
      }
    }
    handle.stderr?.on('data', onData)
    try {
      const outcome = await new Promise<Awaited<typeof handle.done>>((resolve, reject) => {
        const aborted = (): void => reject(new BridgeError(this.lifetime.signal.aborted ? 'connection-closed' : 'setup-timeout'))
        active.addEventListener('abort', aborted, { once: true })
        void handle.done.then(resolve, reject).finally(() => active.removeEventListener('abort', aborted))
        if (active.aborted) aborted()
      })
      if (active.aborted) throw new BridgeError(this.lifetime.signal.aborted ? 'connection-closed' : 'setup-timeout')
      if (outcome.exitCode !== 0 || outcome.signal !== null) throw new BridgeError('setup-required')
      const output = handle.collected.stdout?.readFrom(0)
      if (output === undefined || output.lossy || Buffer.byteLength(output.text) > 65536) throw new BridgeError('setup-required')
      let value: unknown
      try { value = JSON.parse(output.text) }
      catch (error) { void error; throw new BridgeError('setup-required') }
      if (value === null || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !Object.hasOwn(TransportConfig.dict ?? {}, key))) throw new BridgeError('setup-required')
      let settings: TransportConfig
      try { settings = validateConfig(Schema.resolve(value, TransportConfig, {})[0] as TransportConfig) }
      catch (error) { void error; throw new BridgeError('setup-required') }
      if (settings.transport !== 'local' || resolve(settings.localHelper) !== helper || resolve(settings.cwd) !== dirname(helper)) throw new BridgeError('setup-required')
      const home = await realpath(this.runtimeHome), actual = await realpath(settings.localHelper)
      if (actual !== join(home, relative(this.runtimeHome, helper))) throw new BridgeError('setup-required')
      await verifyLocalHelper(settings, active)
      failed = false
      return settings
    } catch (error) {
      if (error instanceof BridgeError) throw error
      throw new BridgeError('setup-required')
    } finally {
      handle.stderr?.off('data', onData)
      if (failed || active.aborted) handle.terminate()
      let gone = false
      try { gone = await handle.waitForExit(AbortSignal.timeout(this.config.setupShutdownTimeoutMs)) }
      catch (error) { void error; /* A failed range observation cannot confirm setup cleanup. */ }
      if (!gone) {
        this.setupCleanupFailure = new BridgeError('setup-cleanup-unconfirmed')
        throw this.setupCleanupFailure
      }
    }
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
      if (this.autoPrepared) {
        this.settings = undefined; this.initialization = undefined; this.initializationFailure = undefined; this.autoPrepared = false
        await this.resolveConfiguration(signal)
      }
    }
    // Status recovery can renew auto-discovered target identity while requests wait in FIFO order.
    const settings = await this.resolveConfiguration(signal)
    this.port ??= new JsonlRequestPort(this.ctx.subprocess, settings)
    try { return await this.port.request(request.action, request.params, signal) }
    catch (error) {
      if (error instanceof BridgeError && error.code === 'cancelled' && !this.port.terminalFailure) throw error
      if (error instanceof BridgeError && ['target-not-ready', 'capability-not-ready', 'transfer-failed'].includes(error.code) && !this.port.terminalFailure) throw error
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
      await this.initialization?.catch((error: unknown) => { void error; /* Requests own their explicit setup result. */ })
      await this.closeGeneration()
      if (this.setupCleanupFailure !== undefined) throw this.setupCleanupFailure
    })()
  }
}
