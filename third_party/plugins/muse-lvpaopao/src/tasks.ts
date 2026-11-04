/** Session-owned Jobs wrap the existing series writer without changing its keys or manifest format. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { JobId, JobHandle, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BridgeError, type Parameters } from './port.ts'
import { authorizeOutput, type OutputDirectory } from './output.ts'
import type { CatalogSelection, IdentitySelection } from './catalog.ts'
import type { SeriesResult, SeriesSelection } from './series.ts'
import { errorResult, seriesResult, type Result, type ToolAction } from './result.ts'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { 'lvpaopao-series': 'lvpaopao-series' } }

/** Persistent outer identity; unrelated to the source-derived inner series task ID. */
export type SeriesTaskId = Branded<'LvpaopaoSeriesTaskId'>
/** Only a complete real catalog and locally verified files can produce completed. */
export type SeriesTaskState = 'queued' | 'running' | 'completed' | 'waiting_user' | 'waiting_source' | 'interrupted' | 'cancelled'
/** Public task metadata; the shared bridge generation and credentials remain private. */
export interface SeriesTaskEnvelope { id: SeriesTaskId; state: SeriesTaskState; jobId: JobId | null }
/** Deployment bounds for private state and completion output. */
export interface SeriesTaskLimits {
  readonly maxSeriesTasks: number
  readonly maxTaskStateBytes: number
  readonly taskLockWaitMs: number
  readonly maxSeriesJobOutputBytes: number
  readonly seriesTaskWaitMs: number
}
/** The production dependencies retain the original runSeries as the sole inner-manifest writer. */
export interface SeriesTaskDependencies {
  readonly directory?: string
  readonly resolveSource: (params: Parameters, signal: AbortSignal) => Promise<IdentitySelection>
  readonly catalog: (params: Parameters, signal: AbortSignal) => Promise<CatalogSelection>
  readonly run: (selection: SeriesSelection, output: OutputDirectory, signal: AbortSignal, beforeNative: () => Promise<void>) => Promise<SeriesResult>
  readonly localStatus: (params: Parameters, output: OutputDirectory, signal: AbortSignal) => Promise<SeriesResult>
  readonly recover: (signal: AbortSignal) => Promise<void>
}
interface TaskRecord {
  id: SeriesTaskId; ownerSessionId: SessionId; cwd: string; outputPath: string; source: { srcAppId: string; dramaId: string }
  state: SeriesTaskState; revision: number; jobId: JobId | null; createdAt: string; updatedAt: string
  jobRegistryInstance?: string; runnerPid?: number; manifestPath?: string; nativeStarted?: boolean; code?: string
}
interface Registry { schemaVersion: 1; revision: number; tasks: TaskRecord[] }
interface Active {
  readonly controller: AbortController; readonly owner: Agent; readonly executor: SeriesTasks
  jobId: JobId | null; done: Promise<Result>; stopState: 'cancelled' | 'interrupted'
}
const active = new Map<string, Active>(), registries = new WeakMap<JobRegistry, string>(), queues = new Map<string, Promise<void>>()
const states: readonly string[] = ['queued', 'running', 'completed', 'waiting_user', 'waiting_source', 'interrupted', 'cancelled']
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH') } }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const encode = (value: Registry): string => JSON.stringify(value, null, 2) + '\n'
const inside = (root: string, path: string): boolean => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part) }
const destination = (cwd: string, output: string): string => inside(cwd, output) ? `workspace:${relative(cwd, output).split(sep).join('/') || '.'}` : `absolute:${output}`
const codeOf = (error: unknown): string => error instanceof BridgeError ? error.code : 'series-task-state-failed'
function source(value: unknown): { srcAppId: string; dramaId: string } {
  if (!object(value) || typeof value.srcAppId !== 'string' || !/^wx[0-9a-f]{16}$/.test(value.srcAppId)
    || typeof value.dramaId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.dramaId)
    || Object.keys(value).some(key => !['srcAppId', 'dramaId'].includes(key))) throw new BridgeError('series-task-state-invalid')
  return { srcAppId: value.srcAppId, dramaId: value.dramaId }
}
function task(value: unknown): TaskRecord {
  if (!object(value) || typeof value.id !== 'string' || !/^lvs-[a-f0-9]{32}$/.test(value.id)
    || typeof value.ownerSessionId !== 'string' || !value.ownerSessionId || typeof value.cwd !== 'string' || !isAbsolute(value.cwd)
    || typeof value.outputPath !== 'string' || !isAbsolute(value.outputPath) || typeof value.state !== 'string' || !states.includes(value.state)
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || value.jobId !== null && typeof value.jobId !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string'
    || Object.keys(value).some(key => !['id', 'ownerSessionId', 'cwd', 'outputPath', 'source', 'state', 'revision', 'jobId', 'createdAt', 'updatedAt', 'jobRegistryInstance', 'runnerPid', 'manifestPath', 'nativeStarted', 'code'].includes(key))) throw new BridgeError('series-task-state-invalid')
  const selected = source(value.source)
  const expectedId = `lvs-${hash(JSON.stringify([value.ownerSessionId, selected.srcAppId, selected.dramaId, destination(value.cwd, value.outputPath)])).slice(0, 32)}`
  if (value.id !== expectedId) throw new BridgeError('series-task-state-invalid')
  const parsed: TaskRecord = { id: brandString<SeriesTaskId>(value.id), ownerSessionId: brandString<SessionId>(value.ownerSessionId), cwd: value.cwd,
    outputPath: value.outputPath, source: selected, state: value.state as SeriesTaskState, revision: value.revision,
    jobId: value.jobId === null ? null : brandString<JobId>(value.jobId), createdAt: value.createdAt, updatedAt: value.updatedAt }
  if (value.jobRegistryInstance !== undefined) { if (typeof value.jobRegistryInstance !== 'string') throw new BridgeError('series-task-state-invalid'); parsed.jobRegistryInstance = value.jobRegistryInstance }
  if (value.runnerPid !== undefined) { if (typeof value.runnerPid !== 'number' || !Number.isInteger(value.runnerPid) || value.runnerPid < 1) throw new BridgeError('series-task-state-invalid'); parsed.runnerPid = value.runnerPid }
  if (value.manifestPath !== undefined) { if (typeof value.manifestPath !== 'string' || !isAbsolute(value.manifestPath) || !inside(parsed.outputPath, value.manifestPath)) throw new BridgeError('series-task-state-invalid'); parsed.manifestPath = value.manifestPath }
  if (value.nativeStarted !== undefined) { if (typeof value.nativeStarted !== 'boolean' || value.nativeStarted && parsed.manifestPath === undefined) throw new BridgeError('series-task-state-invalid'); parsed.nativeStarted = value.nativeStarted }
  if (value.code !== undefined) { if (typeof value.code !== 'string' || !/^[a-z][a-z0-9-]{0,95}$/.test(value.code)) throw new BridgeError('series-task-state-invalid'); parsed.code = value.code }
  return parsed
}

/** Private metadata only; the old per-episode manifest is never written here. */
export class SeriesTaskStore {
  private initialization: Promise<void> | undefined
  private identity: { dev: number; ino: number } | undefined
  file: string
  /** @param directory Host-private task root. @param limits Deployment file/lock caps. */
  constructor(public directory: string, private readonly limits: SeriesTaskLimits) { this.file = join(directory, 'registry.json') }
  /** @returns Safe real directory creation without native work. */
  ready(): Promise<void> { return this.initialization ??= this.initialize() }
  private async initialize(): Promise<void> {
    if (!isAbsolute(this.directory)) throw new BridgeError('series-task-directory-unsafe')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new BridgeError('series-task-directory-unsafe')
    this.directory = resolve(await realpath(this.directory)); this.file = join(this.directory, 'registry.json')
    this.identity = { dev: info.dev, ino: info.ino }
  }
  private async check(): Promise<void> {
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.identity?.dev || info.ino !== this.identity.ino
      || resolve(await realpath(this.directory)) !== this.directory) throw new BridgeError('series-task-directory-unsafe')
  }
  /** @returns A fully bounded validated metadata registry; no missing media is inferred. */
  async read(): Promise<Registry> {
    await this.ready(); await this.check()
    let data: Buffer
    try {
      const info = await lstat(this.file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > this.limits.maxTaskStateBytes) throw new BridgeError('series-task-state-invalid')
      const handle = await open(this.file, 'r')
      try {
        const chunks: Buffer[] = []; let size = 0
        for await (const chunk of handle.createReadStream({ end: this.limits.maxTaskStateBytes, autoClose: false })) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += bytes.length
          if (size > this.limits.maxTaskStateBytes) throw new BridgeError('series-task-capacity')
          chunks.push(bytes)
        }
        data = Buffer.concat(chunks, size)
      } finally { await handle.close() }
    } catch (error) { if (missing(error)) return { schemaVersion: 1, revision: 0, tasks: [] }; throw error }
    let parsed: unknown
    try { parsed = JSON.parse(data.toString('utf8')) }
    catch (error) { void error; throw new BridgeError('series-task-state-invalid') }
    if (!object(parsed) || parsed.schemaVersion !== 1 || typeof parsed.revision !== 'number' || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0
      || !Array.isArray(parsed.tasks) || parsed.tasks.length > this.limits.maxSeriesTasks) throw new BridgeError('series-task-state-invalid')
    const tasks = parsed.tasks.map(task)
    if (new Set(tasks.map(item => item.id)).size !== tasks.length) throw new BridgeError('series-task-state-invalid')
    return { schemaVersion: 1, revision: parsed.revision, tasks }
  }
  /** @param change Locked metadata mutation. @returns Its result after bounded atomic publication with revision checks. */
  async transaction<T>(change: (registry: Registry) => T | Promise<T>): Promise<T> {
    await this.ready(); await this.check()
    return withFileLock(this.file, async () => {
      const value = await this.read(), before = encode(value), result = await change(value)
      if (encode(value) !== before) {
        if (value.tasks.length > this.limits.maxSeriesTasks) throw new BridgeError('series-task-capacity')
        value.revision++
        const text = encode(value)
        if (Buffer.byteLength(text) > this.limits.maxTaskStateBytes) throw new BridgeError('series-task-capacity')
        if (encode(await this.read()) !== before) throw new BridgeError('series-task-state-changed')
        await this.check(); await writeFileAtomic(this.file, text, { mode: 0o600, dirMode: 0o700 }); await this.check()
      }
      return result
    }, { waitMs: this.limits.taskLockWaitMs })
  }
}

/** Durable owner-bound execution around the unchanged series engine and shared native connection. */
export class SeriesTasks {
  readonly store: SeriesTaskStore
  private readonly running = new Set<Promise<Result>>()
  private readonly admissions = new Set<Promise<Result>>()
  private initialization: Promise<void> | undefined
  private closing = false
  private readonly registryToken: string
  /** @param ctx Live owner, Jobs and file-policy services. @param limits Deployment caps. @param dependencies Existing catalog, copy and series operations; native bridge ownership stays with the Host. */
  constructor(private readonly ctx: Context, private readonly limits: SeriesTaskLimits, private readonly dependencies: SeriesTaskDependencies) {
    // Cordis gives each consumer a traceable view; the registry implementation owns the ephemeral ID namespace.
    const jobs = (ctx.jobs as JobRegistry & { [symbols.original]?: JobRegistry })[symbols.original] ?? ctx.jobs
    let token = registries.get(jobs)
    if (token === undefined) { token = randomUUID(); registries.set(jobs, token) }
    this.registryToken = token
    this.store = new SeriesTaskStore(dependencies.directory ?? dshHomePath('lvpaopao', 'tasks', 'v1'), limits)
  }
  /** @returns Startup metadata classification only; no native request or automatic download is performed. */
  ready(): Promise<void> { return this.initialization ??= this.initialize() }
  private async initialize(): Promise<void> {
    await this.store.transaction(registry => {
      for (const item of registry.tasks) {
        if (active.has(this.key(item.id))) continue
        if (item.jobRegistryInstance !== this.registryToken) item.jobId = null
        if (['queued', 'running'].includes(item.state) && (item.runnerPid === undefined || !alive(item.runnerPid))) { item.state = 'interrupted'; item.jobId = null; item.revision++ }
      }
    })
  }
  private key(id: SeriesTaskId): string { return `${this.store.directory}:${id}` }
  private envelope(item: TaskRecord): SeriesTaskEnvelope { return { id: item.id, state: item.state, jobId: item.jobId } }
  private track(operation: Promise<Result>): Promise<Result> {
    this.admissions.add(operation)
    void operation.then(() => this.admissions.delete(operation), () => this.admissions.delete(operation))
    return operation
  }
  private async authorized(agent: Agent, outputDir: string | undefined, read = false, saved?: TaskRecord): Promise<{ cwd: string; output: OutputDirectory }> {
    if (this.ctx.agents.get(agent.id) !== agent || agent.session.id !== agent.id) throw new BridgeError('series-task-owner-mismatch')
    const declaredCwd = agent.session.header.cwd
    if (typeof declaredCwd !== 'string') throw new BridgeError('download-workspace-missing')
    const cwd = await realpath(declaredCwd)
    if (saved !== undefined && (saved.ownerSessionId !== agent.session.id || saved.cwd !== cwd)) throw new BridgeError('series-task-owner-mismatch')
    const policy = this.ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
    const output = await authorizeOutput(agent.session, outputDir, policy, read ? 'read' : 'write')
    if (saved !== undefined && output.path !== saved.outputPath) throw new BridgeError('series-task-output-changed')
    if (inside(output.path, this.store.directory)) throw new BridgeError('series-task-directory-unsafe')
    return { cwd, output }
  }
  private async stored(id: string, agent: Agent): Promise<TaskRecord> {
    if (!/^lvs-[a-f0-9]{32}$/.test(id)) throw new BridgeError('invalid-arguments')
    await this.ready()
    const item = (await this.store.read()).tasks.find(item => item.id === id)
    if (item === undefined || item.ownerSessionId !== agent.session.id) throw new BridgeError('series-task-owner-mismatch')
    return item
  }
  private async update(item: TaskRecord, change: (current: TaskRecord) => void): Promise<TaskRecord> {
    return this.store.transaction(registry => {
      const current = registry.tasks.find(value => value.id === item.id)
      if (current === undefined || current.ownerSessionId !== item.ownerSessionId) throw new BridgeError('series-task-owner-mismatch')
      change(current); current.revision++; current.updatedAt = new Date().toISOString()
      return structuredClone(current)
    })
  }
  private decorate(action: ToolAction, result: Result, item: TaskRecord): Result { return { ...result, action, data: { ...result.data, seriesTask: this.envelope(item) } } }
  private async inspect(item: TaskRecord, agent: Agent, signal: AbortSignal, action: ToolAction): Promise<Result> {
    const { output } = await this.authorized(agent, item.outputPath, true, item)
    try {
      const local = await this.dependencies.localStatus(item.source, output, signal)
      const visible = item.state === 'completed' && local.status !== 'complete' ? { ...item, state: 'interrupted' as const } : item
      return this.decorate(action, seriesResult('series_status', local), visible)
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 'series-task-not-found') throw error
      if (item.nativeStarted || item.manifestPath !== undefined) return this.decorate(action, errorResult(action, new BridgeError('series-task-original-manifest-required')), { ...item, state: 'interrupted' })
      return { action, ok: false, status: `series-${item.state}`, data: { seriesTask: this.envelope(item) }, warnings: ['The inner catalog/file manifest is not available; this task is not proven complete.'] }
    }
  }
  /** @param params Title or source identity. @param mode Explicit wait/background mode. @param agent Actual live owner. @param signal Accepting/calling tool signal. @param outputDir Optional authorized destination. @returns Existing wait fields with separate seriesTask, or stable background acceptance. */
  download(params: Parameters, mode: 'wait' | 'background', agent: Agent, signal: AbortSignal, outputDir?: string): Promise<Result> { return this.track(this.accept(params, mode, agent, signal, outputDir)) }
  private async accept(params: Parameters, mode: 'wait' | 'background', agent: Agent, signal: AbortSignal, outputDir?: string): Promise<Result> {
    if (this.closing) throw new BridgeError('connection-closed')
    const { cwd, output } = await this.authorized(agent, outputDir)
    signal.throwIfAborted()
    const identity = await this.dependencies.resolveSource(params, signal)
    if (identity.kind === 'selection-required') return { action: 'download_series', ok: false, status: 'selection-required', data: { candidates: [...identity.candidates] }, warnings: ['Select one returned source before downloading; no media task or output directory was created.'] }
    await this.ready()
    if (this.closing) throw new BridgeError('connection-closed')
    const id = brandString<SeriesTaskId>(`lvs-${hash(JSON.stringify([agent.session.id, identity.source.srcAppId, identity.source.dramaId, destination(cwd, output.path)])).slice(0, 32)}`)
    const item = await this.store.transaction(registry => {
      const previous = registry.tasks.find(item => item.id === id)
      if (previous !== undefined) {
        if (previous.cwd !== cwd || previous.outputPath !== output.path) throw new BridgeError('series-task-output-changed')
        return structuredClone(previous)
      }
      if (registry.tasks.length >= this.limits.maxSeriesTasks) throw new BridgeError('series-task-capacity')
      const now = new Date().toISOString()
      const item: TaskRecord = { id, ownerSessionId: agent.session.id, cwd, outputPath: output.path, source: identity.source, state: 'queued', revision: 0, jobId: null, createdAt: now, updatedAt: now }
      const prior = registry.tasks.find(value => value.outputPath === output.path && value.source.srcAppId === identity.source.srcAppId && value.source.dramaId === identity.source.dramaId && value.manifestPath !== undefined)
      if (prior?.manifestPath !== undefined) { item.manifestPath = prior.manifestPath; if (prior.nativeStarted) item.nativeStarted = true }
      registry.tasks.push(item); return structuredClone(item)
    })
    signal.throwIfAborted()
    const existing = active.get(this.key(id))
    if (existing !== undefined) return mode === 'background' ? this.accepted('download_series', item, existing.jobId) : this.wait(existing, agent, signal)
    if (this.closing) { await this.update(item, current => { current.state = 'interrupted' }); throw new BridgeError('connection-closed') }
    if (item.nativeStarted || item.manifestPath !== undefined) await this.requireManifest(item, output, signal)
    signal.throwIfAborted()
    return this.launch(item, agent, mode, false, signal, 'download_series')
  }
  private accepted(action: ToolAction, item: TaskRecord, jobId: JobId | null): Result { return { action, ok: true, status: 'series-queued', data: { seriesTask: { id: item.id, state: 'queued', jobId } }, warnings: [] } }
  private async wait(run: Active, agent: Agent, signal?: AbortSignal): Promise<Result> {
    if (run.jobId === null) throw new BridgeError('series-task-job-unavailable')
    await this.ctx.jobs.wait(run.jobId, this.limits.seriesTaskWaitMs, agent.id, signal)
    return run.done
  }
  private async launch(item: TaskRecord, agent: Agent, mode: 'wait' | 'background', recover: boolean, callerSignal: AbortSignal, action: ToolAction): Promise<Result> {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (mode === 'wait') { if (callerSignal.aborted) controller.abort(); else callerSignal.addEventListener('abort', abort, { once: true }) }
    const run: Active = { controller, owner: agent, executor: this, jobId: null, done: Promise.resolve(errorResult(action, new BridgeError('series-task-not-started'))), stopState: 'cancelled' }
    active.set(this.key(item.id), run)
    try {
      const jobId = this.ctx.jobs.start({ kind: 'lvpaopao-series', owner: agent.id, label: 'Lvpaopao selected series', outputLimitBytes: this.limits.maxSeriesJobOutputBytes,
        run: job => {
          run.jobId = job.id
          const queueKey = `${this.store.directory}:${hash(JSON.stringify([item.outputPath, item.source.srcAppId, item.source.dramaId]))}`
          const previous = queues.get(queueKey) ?? Promise.resolve()
          let release!: () => void
          const slot = new Promise<void>(resolve => { release = resolve }), tail = previous.then(() => slot)
          queues.set(queueKey, tail)
          void tail.then(() => { if (queues.get(queueKey) === tail) queues.delete(queueKey) })
          run.done = this.run(item, agent, recover, run, job, action, previous, release).finally(() => { callerSignal.removeEventListener('abort', abort); active.delete(this.key(item.id)) })
          this.running.add(run.done)
          void run.done.then(() => this.running.delete(run.done), () => this.running.delete(run.done))
          return { cancel: reason => { if (!controller.signal.aborted) { run.stopState = /owner|dispos|unload|teardown/i.test(reason ?? '') ? 'interrupted' : 'cancelled'; controller.abort() } },
            done: run.done.then((result): JobOutcome => ({ status: result.data.seriesTask?.state === 'completed' ? 'completed' : controller.signal.aborted ? 'killed' : 'failed', detail: result.status, result: JSON.stringify(result) }), (): JobOutcome => ({ status: 'failed', detail: 'Series task state could not be recorded' })) }
        },
      })
      run.jobId = jobId
      return mode === 'background' ? this.accepted(action, item, jobId) : this.wait(run, agent)
    } catch (error) {
      callerSignal.removeEventListener('abort', abort); active.delete(this.key(item.id))
      await this.update(item, current => { current.state = 'interrupted'; current.jobId = null; current.code = 'series-task-job-unavailable' })
      throw error
    }
  }
  private async requireManifest(item: TaskRecord, output: OutputDirectory, signal: AbortSignal): Promise<SeriesResult | undefined> {
    try {
      const result = await this.dependencies.localStatus(item.source, output, signal)
      if ((item.nativeStarted || item.manifestPath !== undefined) && result.manifestPath !== item.manifestPath) throw new BridgeError('series-task-original-manifest-required')
      return result
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 'series-task-not-found') throw error
      if (item.nativeStarted || item.manifestPath !== undefined) throw new BridgeError('series-task-original-manifest-required')
      return undefined
    }
  }
  private async run(item: TaskRecord, agent: Agent, recover: boolean, run: Active, job: JobHandle, action: ToolAction, previous: Promise<void>, release: () => void): Promise<Result> {
    const signal = run.controller.signal
    let observed: SeriesResult | undefined
    let acquired = false
    try {
      item = await this.update(item, current => { current.state = 'queued'; current.jobId = run.jobId; current.jobRegistryInstance = this.registryToken; current.runnerPid = process.pid })
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(new BridgeError('cancelled'))
        if (signal.aborted) { reject(new BridgeError('cancelled')); return }
        signal.addEventListener('abort', abort, { once: true })
        previous.then(() => { signal.removeEventListener('abort', abort); resolve() }, error => { signal.removeEventListener('abort', abort); reject(error) })
      })
      acquired = true
      const lease = join(this.store.directory, `target-${hash(JSON.stringify([item.outputPath, item.source.srcAppId, item.source.dramaId])).slice(0, 32)}`)
      return await withFileLock(lease, async () => {
        signal.throwIfAborted()
        const { output } = await this.authorized(agent, item.outputPath, false, item)
        if (item.nativeStarted || item.manifestPath !== undefined) await this.requireManifest(item, output, signal)
        if (recover) await this.dependencies.recover(signal)
        job.updateProgress('Confirming the selected source catalog')
        const selected = await this.dependencies.catalog(item.source, signal)
        if (selected.kind !== 'selected' || selected.selection.srcAppId !== item.source.srcAppId || selected.selection.dramaId !== item.source.dramaId) throw new BridgeError('response-identity-mismatch')
        item = await this.update(item, current => { current.state = 'running'; delete current.code })
        job.updateProgress(`Processing ${selected.selection.actualEpisodeNumbers.length} observed catalog episodes`)
        let marked = item.nativeStarted === true
        observed = await this.dependencies.run(selected.selection, output, signal, async () => {
          if (marked) return
          const stored = await this.requireManifest(item, output, signal)
          if (stored === undefined) throw new BridgeError('series-task-original-manifest-required')
          item = await this.update(item, current => { current.nativeStarted = true; current.manifestPath = stored.manifestPath })
          marked = true
        })
        const state: SeriesTaskState = observed.status === 'complete' ? 'completed' : signal.aborted ? run.stopState
          : observed.unknownEpisodeNumbers.length ? 'interrupted' : observed.deniedEpisodeNumbers.length ? 'waiting_user' : 'waiting_source'
        item = await this.update(item, current => { current.state = state; current.manifestPath = observed!.manifestPath })
        return this.decorate(action, seriesResult('download_series', observed), item)
      }, { waitMs: this.limits.taskLockWaitMs })
    } catch (error) {
      const code = codeOf(error), unconfirmed = code.includes('cleanup-unconfirmed') || code.includes('cancel-unconfirmed')
      const state: SeriesTaskState = observed !== undefined ? 'interrupted' : signal.aborted && !unconfirmed ? run.stopState : /login|verification|straight-playback|playable-episode/.test(code) ? 'waiting_user' : unconfirmed ? 'interrupted' : 'waiting_source'
      try { item = await this.update(item, current => { current.state = state; current.code = code }) }
      catch (stateError) { void stateError; item = { ...item, state: 'interrupted' } }
      const result = observed === undefined ? errorResult(action, error) : { ...seriesResult('download_series', observed), ok: false, status: 'series-interrupted', error: { code: 'series-task-state-failed', message: 'Inner episode receipts were preserved, but outer task metadata was not committed.' } }
      return this.decorate(action, result, item)
    } finally {
      if (acquired) release()
      else void previous.then(release, release)
    }
  }
  /** @param id Outer owner-bound ID. @param agent Exact live caller. @param signal Local verification cancellation. @returns Fresh local episode proof plus outer identity, without native requests. */
  status(id: string, agent: Agent, signal: AbortSignal): Promise<Result> { return this.track((async () => this.inspect(await this.stored(id, agent), agent, signal, 'series_status'))()) }
  /** @param id Outer owner-bound ID. @param agent Exact live caller. @param signal Pre-acceptance cancellation only. @returns A new owned background job after current authorization and local proof checks. */
  resume(id: string, agent: Agent, signal: AbortSignal): Promise<Result> {
    return this.track((async () => {
      if (this.closing) throw new BridgeError('connection-closed')
      const item = await this.stored(id, agent), { output } = await this.authorized(agent, item.outputPath, false, item)
      signal.throwIfAborted()
      await this.requireManifest(item, output, signal)
      signal.throwIfAborted()
      if (this.closing) throw new BridgeError('connection-closed')
      const previous = active.get(this.key(item.id))
      return previous === undefined ? this.launch(item, agent, 'background', true, signal, 'series_resume') : this.accepted('series_resume', item, previous.jobId)
    })())
  }
  /** @param id Outer owner-bound ID. @param agent Exact live caller. @param signal Local status cancellation. @returns Actual stopped state after native/copy cleanup; the borrowed Host bridge is not disposed. */
  cancel(id: string, agent: Agent, signal: AbortSignal): Promise<Result> {
    return this.track((async () => {
      let item = await this.stored(id, agent)
      await this.authorized(agent, item.outputPath, true, item)
      const run = active.get(this.key(item.id))
      if (run !== undefined) { run.stopState = 'cancelled'; run.controller.abort(); await run.done; item = await this.stored(id, agent) }
      else if (['queued', 'running'].includes(item.state)) throw new BridgeError('series-task-runner-unavailable')
      else if (item.state !== 'completed') item = await this.update(item, current => { current.state = 'cancelled' })
      return this.inspect(item, agent, signal, 'series_cancel')
    })())
  }
  /** @returns Completion after all owned admissions/runners and local copy cleanup settle; the Host bridge remains mounted. */
  async dispose(): Promise<void> {
    this.closing = true
    for (const run of active.values()) if (run.executor === this && !run.controller.signal.aborted) { run.stopState = 'interrupted'; run.controller.abort() }
    await Promise.allSettled([...this.admissions]); await Promise.allSettled([...this.running])
  }
}
