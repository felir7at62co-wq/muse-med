/** A single persistent local or SSH helper; business parameters are JSON stdin only. */
import { randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { remoteCommand, verifyLocalHelper, localHelperEnvironment, type Config } from './config.ts'
import { ACTIONS, BridgeError, type Action, type Parameters, type RequestPort } from './port.ts'

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
  cancelled: boolean
  cancelReason?: string
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const remoteErrors = new Set(['target-not-ready', 'cancelled', 'unsupported-action', 'invalid-arguments',
  'native-timeout', 'native-error', 'capability-not-ready', 'connection-lost', 'protocol-error', 'wrong-target', 'busy',
  'parameters-invalid', 'parameters-too-large', 'operation-not-registered', 'operation-not-supported', 'operation-unconfirmed',
  'verified-context-required', 'identity-unconfirmed', 'context-invalidated', 'context-removed', 'closed', 'deadline',
  'evaluation-rejected', 'result-not-by-value', 'transport-failed', 'protocol-invalid', 'result-invalid', 'request-conflict', 'helper-identity-mismatch',
  'transfer-failed', 'output-already-exists', 'download-cancelled', 'media-process-cleanup-failed',
  'resume-state-invalid', 'resume-response-invalid', 'resume-resource-changed', 'resume-validator-missing',
  'request-binding-conflict', 'outcome-unconfirmed', 'setup-required'])

/** RequestPort for a digest-verified local or independently verified SSH --rpc-stdio helper. */
export class JsonlRequestPort implements RequestPort {
  private handle: SubprocessHandle | undefined
  private connection: Promise<void> | undefined
  private readonly pending = new Map<string, Pending>()
  private readonly lifetime = new AbortController()
  private buffered = Buffer.alloc(0)
  private failure: BridgeError | undefined
  private closing = false
  private closedEvent = false
  private closedCleanupConfirmed = false
  private disposal: Promise<void> | undefined
  private event: 'waiting_target' | 'ready' | 'closed' | undefined
  private activeCalls = 0
  private capabilities: ReadonlySet<Action> = new Set()

  constructor(private readonly subprocess: SubprocessRuntime, private readonly config: Config) {}

  /** Last allowlisted lifecycle event, without helper-provided details. */
  get connectionEvent(): 'waiting_target' | 'ready' | 'closed' | undefined { return this.event }

  /** Whether transport failure or shutdown prevents another request in this generation. */
  get terminalFailure(): boolean { return this.failure !== undefined || this.closing }

  /**
   * Execute one high-level operation after the exact helper handshake.
   * @param action - Allowed operation.
   * @param params - Business fields, never included in the SSH command.
   * @param signal - Initiating tool cancellation.
   * @returns Untrusted result JSON, validated by the tool adapter.
   */
  async request(action: Action, params: Parameters, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    this.assertOpen()
    if (this.activeCalls >= this.config.maxPending) throw new BridgeError('request-capacity')
    this.activeCalls++
    try {
      this.connection ??= this.connect()
      const startup = this.connection
      await new Promise<void>((resolve, reject) => {
        const aborted = (): void => reject(new BridgeError('cancelled'))
        signal.addEventListener('abort', aborted, { once: true })
        void startup.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
        if (signal.aborted) aborted()
      })
      signal.throwIfAborted()
      this.assertOpen()
      if (!this.capabilities.has(action)) throw new BridgeError('capability-not-ready')
      return await this.rpc(action, params, signal, (action === 'download_first_episode' || action === 'download_episode') ? this.config.downloadRequestTimeoutMs : this.config.requestTimeoutMs)
    } catch (error) {
      if (this.failure !== undefined) {
        try { await this.dispose() } catch (cleanupError) { void cleanupError; /* Failure remains explicit; remote cleanup may be unconfirmed. */ }
      }
      throw error
    } finally { this.activeCalls-- }
  }

  private assertOpen(): void {
    if (this.failure !== undefined) throw this.failure
    if (this.closing) throw new BridgeError('connection-closed')
  }

  private async connect(): Promise<void> {
    const argv = this.config.transport === 'local'
      ? [this.config.localPython, '-u', this.config.localHelper, '--rpc-stdio']
      : [this.config.sshExecutable, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ServerAliveInterval=10',
        '-o', 'ServerAliveCountMax=3', this.config.sshHostAlias, remoteCommand(this.config)]
    if (this.config.transport === 'local') await verifyLocalHelper(this.config, this.lifetime.signal)
    this.assertOpen()
    this.handle = this.subprocess.spawn({
      argv,
      ...(this.config.transport === 'local' ? { env: localHelperEnvironment() } : {}),
      cwd: this.config.cwd, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16384 } },
      graceMs: this.config.shutdownTimeoutMs, signal: this.lifetime.signal,
    })
    if (this.handle.stdin === undefined || this.handle.stdout === undefined) throw new BridgeError('process-pipes-unavailable')
    this.handle.stdin.on('error', () => this.fail(new BridgeError('connection-lost')))
    this.handle.stdout.on('data', (chunk: Buffer | string) => this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    this.handle.stdout.on('error', () => this.fail(new BridgeError('connection-lost')))
    void this.handle.done.then(() => {
      if (!this.closing) this.fail(new BridgeError('connection-lost'))
    }, () => { this.fail(new BridgeError('connection-lost')) })
    let value: unknown
    try {
      value = await this.rpc('hello', { expected_app_id: 'wx404dde55fb12df78', helper_sha256: this.config.helperSha256 },
        this.lifetime.signal, this.config.connectTimeoutMs)
    } catch (error) {
      this.fail(error instanceof BridgeError ? error : new BridgeError('handshake-failed'))
      throw error
    }
    if (!record(value) || value.protocol_version !== 1 || value.helper_sha256 !== this.config.helperSha256
      || value.expected_app_id !== 'wx404dde55fb12df78' || typeof value.ready !== 'boolean'
      || !Array.isArray(value.actions) || ![5, 7, ACTIONS.length].includes(value.actions.length)
      || !ACTIONS.slice(0, 5).every(action => Array.isArray(value.actions) && value.actions.includes(action))
      || value.actions.some(item => !ACTIONS.some(action => action === item)) || new Set(value.actions).size !== value.actions.length) {
      this.fail(new BridgeError('handshake-mismatch'))
      throw new BridgeError('handshake-mismatch')
    }
    this.capabilities = new Set(ACTIONS.filter(action => Array.isArray(value.actions) && value.actions.includes(action)))
  }

  private consume(chunk: Buffer): void {
    if (this.failure !== undefined) return
    this.buffered = Buffer.concat([this.buffered, chunk])
    for (;;) {
      const newline = this.buffered.indexOf(10)
      if (newline === -1) {
        if (this.buffered.byteLength > this.config.maxFrameBytes) this.fail(new BridgeError('frame-too-large'))
        return
      }
      if (newline > this.config.maxFrameBytes) { this.fail(new BridgeError('frame-too-large')); return }
      const line = this.buffered.subarray(0, newline)
      this.buffered = this.buffered.subarray(newline + 1)
      if (!isUtf8(line)) { this.fail(new BridgeError('invalid-response')); return }
      try { this.accept(JSON.parse(line.toString('utf8'))) }
      catch { this.fail(new BridgeError('invalid-response')); return }
      if (this.failure !== undefined) return
    }
  }

  private accept(frame: unknown): void {
    if (!record(frame) || frame.protocol !== 1) throw new BridgeError('invalid-response')
    if (frame.type === 'event') {
      if (!['waiting_target', 'ready', 'closed'].includes(String(frame.event)) || !record(frame.details)) throw new BridgeError('invalid-response')
      this.event = frame.event as 'waiting_target' | 'ready' | 'closed'
      if (this.event === 'closed') {
        this.closedEvent = true
        const cleanup = frame.details.cleanup
        this.closedCleanupConfirmed = ['control-close', 'control-eof', 'host-context-ended', 'hook-disposed', 'peer-ended', 'deadline', 'cancelled'].includes(String(frame.details.status))
          && record(cleanup) && ['dispose', 'unload', 'detach', 'serverClosed'].every(key => cleanup[key] === true)
        if (!this.closing) { this.closing = true; this.fail(new BridgeError('connection-closed')) }
      }
      return
    }
    if ((frame.type !== 'result' && frame.type !== 'error') || typeof frame.id !== 'string') throw new BridgeError('invalid-response')
    const entry = this.pending.get(frame.id)
    if (entry === undefined) throw new BridgeError('unexpected-response')
    this.pending.delete(frame.id); entry.cleanup()
    if (entry.cancelled) {
      if ((frame.type === 'error' && record(frame.error) && frame.error.code === 'cancelled')
        || (frame.type === 'result' && Object.hasOwn(frame, 'value'))) {
        entry.reject(new BridgeError(entry.cancelReason ?? 'cancelled')); return
      }
      const failure = new BridgeError('cancel-unconfirmed')
      this.fail(failure); entry.reject(failure); return
    }
    if (frame.type === 'result' && Object.hasOwn(frame, 'value')) { entry.resolve(frame.value); return }
    if (frame.type === 'error' && record(frame.error) && typeof frame.error.code === 'string') {
      entry.reject(new BridgeError(remoteErrors.has(frame.error.code) ? frame.error.code : 'remote-error')); return
    }
    entry.reject(new BridgeError('invalid-response')); throw new BridgeError('invalid-response')
  }

  private send(frame: Record<string, unknown>): void {
    const line = JSON.stringify(frame) + '\n'
    if (Buffer.byteLength(line) - 1 > this.config.maxFrameBytes) throw new BridgeError('frame-too-large')
    const stream = this.handle?.stdin
    if (stream === undefined || stream.destroyed) throw new BridgeError('connection-lost')
    stream.write(line, error => { if (error !== null && error !== undefined) this.fail(new BridgeError('connection-lost')) })
  }

  private rpc(method: string, params: object, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    signal.throwIfAborted()
    if (this.pending.size >= this.config.maxPending) return Promise.reject(new BridgeError('request-capacity'))
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      let cancellation: NodeJS.Timeout | undefined
      const timer = setTimeout(() => cancel('request-timeout'), timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer); if (cancellation !== undefined) clearTimeout(cancellation)
        signal.removeEventListener('abort', abort)
      }
      const cancel = (code: string): void => {
        const entry = this.pending.get(id)
        if (entry === undefined || entry.cancelled) return
        entry.cancelled = true
        entry.cancelReason = code
        try { this.send({ protocol: 1, type: 'cancel', id }) }
        catch { this.fail(new BridgeError('connection-lost')); return }
        cancellation = setTimeout(() => {
          entry.cancelReason = 'cancel-unconfirmed'
          void this.dispose().catch(() => { /* The initiating call reports unconfirmed cancellation after owned shutdown. */ })
        }, this.config.cancelTimeoutMs)
      }
      const abort = (): void => cancel('cancelled')
      this.pending.set(id, { resolve, reject, cleanup, cancelled: false })
      signal.addEventListener('abort', abort, { once: true })
      try { this.send({ protocol: 1, type: 'request', id, method, params }) }
      catch { this.fail(new BridgeError('connection-lost')) }
      if (signal.aborted) abort()
    })
  }

  private fail(error: BridgeError): void {
    this.failure ??= error
    for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(this.failure) }
    this.pending.clear()
  }

  /** Stop admission, ask remote cleanup, and wait for the managed SSH process range. */
  dispose(): Promise<void> { return this.disposal ??= this.close() }

  private async close(): Promise<void> {
    this.closing = true
    const handle = this.handle
    if (handle === undefined) {
      this.lifetime.abort()
      await this.connection?.catch((error: unknown) => { void error; /* Callers retain a failed pre-spawn identity result. */ })
      return
    }
    for (const id of this.pending.keys()) {
      const pending = this.pending.get(id)
      if (pending !== undefined) { pending.cancelled = true; pending.cancelReason ??= 'connection-closed' }
      try { this.send({ protocol: 1, type: 'cancel', id }) }
      catch { break }
    }
    try { this.send({ protocol: 1, type: 'close' }) }
    catch (error) { void error; /* A lost transport cannot confirm remote cleanup; exit facts are still collected. */ }
    handle.stdin?.end()
    const force = setTimeout(() => { handle.terminate() }, this.config.shutdownTimeoutMs)
    let gone: boolean
    try { gone = await handle.waitForExit(AbortSignal.timeout(this.config.shutdownTimeoutMs * 2)) }
    finally {
      clearTimeout(force)
      for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(new BridgeError(entry.cancelReason ?? 'connection-closed')) }
      this.pending.clear()
      this.lifetime.abort()
    }
    if (!gone || !this.closedEvent || !this.closedCleanupConfirmed) throw new BridgeError('remote-cleanup-unconfirmed')
    const outcome = await handle.done
    if (outcome.exitCode !== 0 || outcome.signal !== null) throw new BridgeError('remote-exit-failed')
  }
}
