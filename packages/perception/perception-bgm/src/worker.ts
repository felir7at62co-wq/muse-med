/**
 * One resident Python process for emotion analysis.
 *
 * Resident because loading MERT costs about 10–16 seconds; a per-call spawn would
 * pay that fixed cost for every track. The protocol is newline-delimited JSON in
 * both directions. The child starts with `-I -B -X utf8` under a scrubbed
 * environment, matching the harness' other Python workers: no inherited API
 * keys, proxy credentials or DSH session facts reach model code.
 *
 * A timeout kills the process. Python inference cannot be interrupted safely at
 * the thread level, and leaving half a JSON stream alive would poison every
 * request after it.
 */
import { spawn } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

/** Interpreter, worker script, environment, and limits for one resident analysis process. */
export interface EmotionWorkerOptions {
  pythonExecutable: string
  scriptPath: string
  /** Extra non-secret environment entries needed by the model cache. */
  env?: Record<string, string>
  readyTimeoutMs?: number
  callTimeoutMs?: number
  maxLineBytes?: number
  /** Test/diagnostic seam: observes the exact launch without replacing it. */
  onLaunch?: (argv: string[], env: NodeJS.ProcessEnv) => void
}

/** Worker startup report describing the active face and missing analysis dependencies. */
export interface Handshake {
  ready: boolean
  face: string
  missing: string[]
  python?: string
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const DEFAULT_READY_TIMEOUT = 60000
const DEFAULT_CALL_TIMEOUT = 300000
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024

/** Long-lived NDJSON bridge to `worker_main.py`. */
export class EmotionWorker {
  private readonly options: EmotionWorkerOptions
  private child?: ReturnType<typeof spawn>
  private reader?: Interface
  private pending = new Map<string, Pending>()
  private counter = 0
  private ready?: Handshake
  /** In-flight start, so concurrent callers share one process instead of racing. */
  private startPromise: Promise<Handshake> | undefined
  private dead = false

  constructor(options: EmotionWorkerOptions) {
    this.options = options
  }

  /** Whether the process can accept another call. */
  get alive(): boolean {
    return !this.dead && this.child !== undefined && this.child.exitCode === null
  }

  /**
   * Start once and wait for the worker's dependency handshake.
   * @returns The shared startup report, including any missing dependencies.
   */
  async start(): Promise<Handshake> {
    if (this.ready !== undefined) return this.ready
    if (this.startPromise !== undefined) return await this.startPromise
    this.startPromise = this.startOnce()
    try {
      this.ready = await this.startPromise
      return this.ready
    } finally {
      this.startPromise = undefined
    }
  }

  /**
   * Send one request; callers must await {@link start} first.
   * @param method - Python worker operation name.
   * @param params - JSON-serializable arguments for that operation.
   * @returns The decoded result, or a rejection on worker error, timeout, or process exit.
   */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.alive) throw new Error('worker is not running')
    const child = this.child
    const stdin = child?.stdin
    if (child === undefined || stdin === null || stdin === undefined) throw new Error('worker stdin is unavailable')
    this.counter += 1
    const id = `c${this.counter}`
    const timeout = this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.kill()
        reject(new Error(`worker call "${method}" timed out after ${timeout} ms`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  /** Stop the process and reject every outstanding request. */
  dispose(): Promise<void> {
    this.kill()
    this.failAll(new Error('worker disposed'))
    return Promise.resolve()
  }

  private async startOnce(): Promise<Handshake> {
    const readyTimeout = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT
    const handshake = new Promise<Handshake>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete('__handshake__')
        this.kill()
        reject(new Error('worker handshake timeout'))
      }, readyTimeout)
      this.pending.set('__handshake__', {
        resolve: (value) => { clearTimeout(timer); resolve(value as Handshake) },
        reject: (error) => { clearTimeout(timer); reject(error) },
        timer,
      })
    })

    const argv = [this.options.pythonExecutable, '-I', '-B', '-X', 'utf8', this.options.scriptPath]
    const env: NodeJS.ProcessEnv = {}
    const modelEnvironment = ['HF_HOME', 'HF_HUB_CACHE', 'TRANSFORMERS_CACHE', 'HF_ENDPOINT']
    const configuredCache = modelEnvironment.some(key => this.options.env?.[key] !== undefined)
    // Declared model locations exclude ambient cache aliases and mirror endpoints.
    // Other launches retain the allowlisted deployment environment, never credentials.
    for (const key of ['SystemRoot', 'WINDIR', 'SYSTEMROOT', 'PATH', 'TEMP', 'TMP', ...modelEnvironment]) {
      if (configuredCache && modelEnvironment.includes(key)) continue
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    Object.assign(env, this.options.env)
    this.options.onLaunch?.(argv, env)
    this.dead = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0] ?? '', argv.slice(1),
        { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      this.pending.delete('__handshake__')
      this.dead = true
      throw new Error('worker failed to start')
    }
    this.child = child
    child.once('error', () => { this.failAll(new Error('worker failed to start')) })
    child.once('close', () => { this.failAll(new Error('worker exited')) })
    child.stderr?.on('data', () => { /* drain diagnostics; never mix them into JSON */ })
    if (child.stdout === null) {
      this.failAll(new Error('worker stdout is unavailable'))
      return await handshake
    }
    this.reader = createInterface({ input: child.stdout })
    this.reader.on('line', (line) => { this.onLine(line) })
    return await handshake
  }

  private onLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > (this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) {
      this.kill()
      this.failAll(new Error('worker response exceeded its byte limit'))
      return
    }
    let parsed: {
      id?: string
      status?: string
      result?: unknown
      error?: { code?: string; message?: string }
    }
    try { parsed = JSON.parse(line) as typeof parsed }
    catch { return }
    const id = parsed.id
    if (id === undefined) return
    const waiter = this.pending.get(id)
    if (waiter === undefined) return
    this.pending.delete(id)
    clearTimeout(waiter.timer)
    if (parsed.status === 'ok') waiter.resolve(parsed.result)
    else waiter.reject(new Error(`${parsed.error?.code ?? 'WORKER_ERROR'}: ${parsed.error?.message ?? ''}`))
  }

  private kill(): void {
    this.dead = true
    this.reader?.close()
    try { this.child?.kill('SIGKILL') } catch { /* already gone */ }
  }

  private failAll(error: Error): void {
    this.dead = true
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}
