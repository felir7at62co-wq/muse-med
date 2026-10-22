/** Persistent whole-series progress; native acquisition remains with the injected downloader. */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { LocalMedia } from './download.ts'
import type { OutputDirectory } from './output.ts'
import { BridgeError } from './port.ts'

/** Exact selected source and freshly observed catalog; omitted numbers never become downloads. */
export interface SeriesSelection {
  readonly srcAppId: string
  readonly dramaId: string
  readonly title?: string
  readonly episodeCount: number
  readonly actualEpisodeNumbers: readonly number[]
  readonly catalogComplete: boolean
}
/** Session-authorized destination and deployment-owned bounds for one invocation. */
export interface SeriesOptions {
  readonly selection: SeriesSelection
  readonly output: OutputDirectory
  /** Host-private coordination directory, outside user-editable output trees. */
  readonly lockDirectory: string
  readonly maxAttempts: number
  readonly retryDelayMs: number
  readonly lockWaitMs: number
  readonly maxEpisodes: number
  readonly maxMediaBytes: number
}
/** Read-only lookup inputs; the saved catalog supplies selection without contacting native. */
export type StoredSeriesOptions = Omit<SeriesOptions, 'selection'> & { readonly srcAppId: string; readonly dramaId: string }
/** Original durable key and stable local directory, reused across safe retries. */
export interface EpisodeRequest {
  readonly episodeNo: number
  readonly requestKey: string
  readonly episodeDirectory: string
  readonly attempt: number
}
/** A transport classifies only established outcomes; unknown acquisition cannot be replayed. */
export interface SeriesFailure { readonly code: string; readonly retry: 'safe' | 'unknown' | 'denied' }
/** Reconciliation uses the original key and must not acquire a second media address. */
export type EpisodeReconciliation = { readonly kind: 'verified'; readonly media: LocalMedia }
  | { readonly kind: 'retry' } | { readonly kind: 'unknown'; readonly code?: string }
/** Native work must settle its children before resolving or rejecting after cancellation. */
export interface SeriesDependencies {
  readonly download: (request: EpisodeRequest, signal: AbortSignal) => Promise<LocalMedia>
  readonly reconcile: (request: EpisodeRequest, signal: AbortSignal) => Promise<EpisodeReconciliation>
  readonly classify: (error: unknown) => SeriesFailure
}
/** Per-episode durable status; downloading is reconciled after an interrupted process. */
export type SeriesEpisodeState = 'pending' | 'downloading' | 'complete' | 'failed' | 'denied' | 'unknown'
/** Current-catalog episode progress, including only verified local file metadata. */
export interface SeriesEpisodeResult {
  readonly episodeNo: number
  readonly state: SeriesEpisodeState
  readonly attempts: number
  readonly lastError?: string
  readonly media?: LocalMedia
}
/** Current-catalog progress; completion requires a contiguous catalog and every actual file verified locally. */
export interface SeriesResult {
  readonly taskId: string
  readonly taskDirectory: string
  readonly manifestPath: string
  readonly status: 'complete' | 'partial' | 'cancelled'
  readonly episodeCount: number
  readonly catalogComplete: boolean
  readonly actualEpisodeNumbers: readonly number[]
  readonly completedEpisodeNumbers: readonly number[]
  readonly pendingEpisodeNumbers: readonly number[]
  readonly inProgressEpisodeNumbers: readonly number[]
  readonly failedEpisodeNumbers: readonly number[]
  readonly deniedEpisodeNumbers: readonly number[]
  readonly unknownEpisodeNumbers: readonly number[]
  readonly missingEpisodeNumbers: readonly number[]
  readonly episodes: readonly SeriesEpisodeResult[]
}
interface EpisodeRecord {
  episodeNo: number
  state: SeriesEpisodeState
  attempts: number
  requestKey: string
  lastError?: string
  retry?: 'safe' | 'unknown' | 'denied'
  media?: LocalMedia
}
interface Manifest {
  schemaVersion: 1
  taskId: string
  selection: SeriesSelection
  /** Historical request keys survive temporary omissions from the current catalog. */
  episodes: EpisodeRecord[]
}
interface TaskPaths { taskId: string; taskDirectory: string; manifestPath: string }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const absent = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
const inside = (root: string, file: string): boolean => {
  const path = relative(root, file)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
const safeCode = (value: string): string => /^[a-z][a-z0-9-]{0,95}$/.test(value) ? value : 'series-operation-failed'
const states: ReadonlySet<string> = new Set(['pending', 'downloading', 'complete', 'failed', 'denied', 'unknown'])

function validateOptions(options: SeriesOptions): void {
  const selected = options.selection
  if (!/^wx[0-9a-f]{16}$/.test(selected.srcAppId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(selected.dramaId)
    || selected.title !== undefined && (selected.title.length > 300 || /[\x00-\x1f]|https?:\/\//i.test(selected.title))
    || !isAbsolute(options.output.path) || !isAbsolute(options.lockDirectory) || /[\x00\r\n]/.test(options.lockDirectory)
    || resolve(options.lockDirectory) === resolve(options.output.path) || inside(options.output.path, options.lockDirectory) || !Number.isSafeInteger(options.maxEpisodes) || options.maxEpisodes < 1 || options.maxEpisodes > 10000
    || !Number.isSafeInteger(selected.episodeCount) || selected.episodeCount < 1 || selected.episodeCount > options.maxEpisodes
    || typeof selected.catalogComplete !== 'boolean' || !Array.isArray(selected.actualEpisodeNumbers)
    || selected.actualEpisodeNumbers.length > options.maxEpisodes
    || selected.actualEpisodeNumbers.some(number => !Number.isSafeInteger(number) || number < 1 || number > selected.episodeCount)
    || new Set(selected.actualEpisodeNumbers).size !== selected.actualEpisodeNumbers.length
    || !Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 20
    || !Number.isSafeInteger(options.retryDelayMs) || options.retryDelayMs < 0 || options.retryDelayMs > 60000
    || !Number.isSafeInteger(options.lockWaitMs) || options.lockWaitMs < 0 || options.lockWaitMs > 60000
    || !Number.isSafeInteger(options.maxMediaBytes) || options.maxMediaBytes < 1 || options.maxMediaBytes > 2147483648) throw new BridgeError('series-options-invalid')
}
function paths(options: SeriesOptions): TaskPaths {
  const taskId = createHash('sha256').update(JSON.stringify([options.selection.srcAppId, options.selection.dramaId])).digest('hex').slice(0, 24)
  const taskDirectory = join(options.output.path, `lvpaopao-${taskId}`)
  return { taskId, taskDirectory, manifestPath: join(taskDirectory, 'manifest.json') }
}
async function privateLock(options: SeriesOptions, task: TaskPaths): Promise<string> {
  let anchor = resolve(options.lockDirectory)
  const suffix: string[] = []
  for (;;) {
    try {
      const info = await lstat(anchor)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new BridgeError('series-lock-directory-unsafe')
      break
    } catch (error) {
      if (!absent(error)) throw error
      const parent = dirname(anchor)
      if (parent === anchor) throw new BridgeError('series-lock-directory-unsafe')
      suffix.unshift(relative(parent, anchor)); anchor = parent
    }
  }
  let current = await realpath(anchor)
  const absolute = join(current, ...suffix)
  if (absolute === options.output.path || inside(options.output.path, absolute)) throw new BridgeError('series-lock-directory-unsafe')
  for (const part of suffix) {
    current = join(current, part)
    try { await mkdir(current, { mode: 0o700 }) }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(current)) !== current) throw new BridgeError('series-lock-directory-unsafe')
  }
  const destination = createHash('sha256').update(options.output.path).digest('hex').slice(0, 24)
  return join(absolute, `${task.taskId}-${destination}.json`)
}
function initial(options: SeriesOptions, task: TaskPaths): Manifest {
  return { schemaVersion: 1, taskId: task.taskId, selection: options.selection,
    episodes: [...options.selection.actualEpisodeNumbers].sort((a, b) => a - b).map(episodeNo => ({ episodeNo, state: 'pending', attempts: 0, requestKey: randomBytes(32).toString('hex') })) }
}
function parseMedia(value: unknown, options: SeriesOptions, directory: string): LocalMedia {
  if (!record(value) || typeof value.localPath !== 'string' || typeof value.receiptPath !== 'string'
    || !isAbsolute(value.localPath) || !isAbsolute(value.receiptPath) || !inside(directory, value.localPath) || !inside(directory, value.receiptPath)
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > options.maxMediaBytes
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.durationSeconds !== 'number' || !Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0
    || !Number.isSafeInteger(value.width) || Number(value.width) < 1 || !Number.isSafeInteger(value.height) || Number(value.height) < 1
    || typeof value.hasAudio !== 'boolean' || value.fullDecodePassed !== true) throw new BridgeError('series-manifest-invalid')
  return { localPath: value.localPath, receiptPath: value.receiptPath, bytes: Number(value.bytes), sha256: value.sha256,
    durationSeconds: value.durationSeconds, width: Number(value.width), height: Number(value.height), hasAudio: value.hasAudio, fullDecodePassed: true }
}
function episodeDirectory(task: TaskPaths, episodeNo: number): string { return join(task.taskDirectory, 'episodes', String(episodeNo).padStart(4, '0')) }
async function readManifestValue(task: TaskPaths): Promise<unknown> {
  let source: string
  try {
    const info = await lstat(task.manifestPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8388608) throw new BridgeError('series-manifest-invalid')
    source = await readFile(task.manifestPath, 'utf8')
  } catch (error) { if (absent(error)) return undefined; throw error }
  let value: unknown
  try { value = JSON.parse(source) }
  catch (error) { void error; throw new BridgeError('series-manifest-invalid') }
  return value
}
async function load(options: SeriesOptions, task: TaskPaths): Promise<Manifest | undefined> {
  const value = await readManifestValue(task)
  if (value === undefined) return undefined
  if (!record(value) || value.schemaVersion !== 1 || value.taskId !== task.taskId || !record(value.selection)
    || value.selection.srcAppId !== options.selection.srcAppId || value.selection.dramaId !== options.selection.dramaId
    || !Array.isArray(value.episodes) || value.episodes.length > options.maxEpisodes) throw new BridgeError('series-manifest-invalid')
  const entries: EpisodeRecord[] = []
  for (const item of value.episodes) {
    if (!record(item) || !Number.isSafeInteger(item.episodeNo) || Number(item.episodeNo) < 1 || Number(item.episodeNo) > options.maxEpisodes
      || typeof item.state !== 'string' || !states.has(item.state) || !Number.isSafeInteger(item.attempts) || Number(item.attempts) < 0
      || typeof item.requestKey !== 'string' || !/^[a-f0-9]{64}$/.test(item.requestKey)
      || item.lastError !== undefined && (typeof item.lastError !== 'string' || safeCode(item.lastError) !== item.lastError)
      || item.retry !== undefined && item.retry !== 'safe' && item.retry !== 'unknown' && item.retry !== 'denied') throw new BridgeError('series-manifest-invalid')
    const entry: EpisodeRecord = { episodeNo: Number(item.episodeNo), state: item.state as SeriesEpisodeState, attempts: Number(item.attempts), requestKey: item.requestKey }
    if (item.lastError !== undefined) entry.lastError = item.lastError
    if (item.retry !== undefined) entry.retry = item.retry
    if (item.media !== undefined) entry.media = parseMedia(item.media, options, episodeDirectory(task, entry.episodeNo))
    if (entry.state === 'complete' && entry.media === undefined) throw new BridgeError('series-manifest-invalid')
    entries.push(entry)
  }
  if (new Set(entries.map(entry => entry.episodeNo)).size !== entries.length) throw new BridgeError('series-manifest-invalid')
  const previous = new Set(entries.map(entry => entry.episodeNo))
  for (const episodeNo of options.selection.actualEpisodeNumbers) {
    if (!previous.has(episodeNo)) entries.push({ episodeNo, state: 'pending', attempts: 0, requestKey: randomBytes(32).toString('hex') })
  }
  return { schemaVersion: 1, taskId: task.taskId, selection: options.selection, episodes: entries.sort((a, b) => a.episodeNo - b.episodeNo) }
}
function currentEpisodes(manifest: Manifest): EpisodeRecord[] {
  const current = new Set(manifest.selection.actualEpisodeNumbers)
  return manifest.episodes.filter(entry => current.has(entry.episodeNo))
}
async function verifiedMedia(media: LocalMedia, options: SeriesOptions, directory: string, signal: AbortSignal): Promise<boolean> {
  parseMedia(media, options, directory)
  try {
    const info = await lstat(media.localPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== media.bytes || resolve(await realpath(media.localPath)) !== resolve(media.localPath)) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(media.localPath, { signal })) hash.update(chunk)
    const after = await lstat(media.localPath)
    return after.isFile() && !after.isSymbolicLink() && after.dev === info.dev && after.ino === info.ino
      && after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs && hash.digest('hex') === media.sha256
  } catch (error) { if (signal.aborted) throw error; if (absent(error)) return false; throw error }
}
async function checkCompleted(manifest: Manifest, options: SeriesOptions, task: TaskPaths, signal: AbortSignal, reconcileInterrupted: boolean): Promise<void> {
  for (const entry of currentEpisodes(manifest)) {
    signal.throwIfAborted()
    if (reconcileInterrupted && entry.state === 'downloading') { entry.state = 'unknown'; entry.retry = 'unknown'; entry.lastError = 'series-interrupted' }
    if (entry.state === 'complete' && entry.media !== undefined && !await verifiedMedia(entry.media, options, episodeDirectory(task, entry.episodeNo), signal)) {
      entry.state = 'failed'; entry.retry = 'safe'; entry.lastError = 'series-local-verification-failed'; delete entry.media
    }
  }
}
function result(manifest: Manifest, task: TaskPaths, cancelled: boolean): SeriesResult {
  const numbers = [...manifest.selection.actualEpisodeNumbers].sort((a, b) => a - b)
  const episodes = currentEpisodes(manifest)
  const completed = episodes.filter(entry => entry.state === 'complete').map(entry => entry.episodeNo)
  const missing = Array.from({ length: manifest.selection.episodeCount }, (_, index) => index + 1).filter(number => !numbers.includes(number))
  const complete = manifest.selection.catalogComplete && missing.length === 0 && completed.length === manifest.selection.episodeCount
  return { ...task, status: cancelled ? 'cancelled' : complete ? 'complete' : 'partial', episodeCount: manifest.selection.episodeCount,
    catalogComplete: manifest.selection.catalogComplete, actualEpisodeNumbers: numbers, completedEpisodeNumbers: completed,
    pendingEpisodeNumbers: episodes.filter(entry => entry.state === 'pending').map(entry => entry.episodeNo),
    inProgressEpisodeNumbers: episodes.filter(entry => entry.state === 'downloading').map(entry => entry.episodeNo),
    failedEpisodeNumbers: episodes.filter(entry => entry.state === 'failed').map(entry => entry.episodeNo),
    deniedEpisodeNumbers: episodes.filter(entry => entry.state === 'denied').map(entry => entry.episodeNo),
    unknownEpisodeNumbers: episodes.filter(entry => entry.state === 'unknown').map(entry => entry.episodeNo),
    missingEpisodeNumbers: missing,
    episodes: episodes.map(entry => ({ episodeNo: entry.episodeNo, state: entry.state, attempts: entry.attempts,
      ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }), ...(entry.media === undefined ? {} : { media: entry.media }) })) }
}
function cleanupUnconfirmed(error: unknown): boolean {
  return error instanceof BridgeError && (error.code.includes('cleanup-unconfirmed') || error.code === 'cancel-unconfirmed' || error.code === 'remote-exit-failed')
}

/**
 * Read existing progress and verify completed files without creating directories or contacting the helper.
 * @param options - Exact source selection and currently authorized output.
 * @param signal - Optional cancellation for local hashing.
 * @returns Current progress; absent tasks report pending actual episodes.
 */
export async function readSeriesStatus(options: SeriesOptions, signal: AbortSignal = new AbortController().signal): Promise<SeriesResult> {
  validateOptions(options); const task = paths(options)
  if (signal.aborted) return result(initial(options, task), task, true)
  await options.output.check()
  try {
    const info = await lstat(task.taskDirectory)
    if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(task.taskDirectory)) !== task.taskDirectory) throw new BridgeError('series-output-replaced')
  } catch (error) { if (!absent(error)) throw error; return result(initial(options, task), task, false) }
  const manifest = await load(options, task) ?? initial(options, task)
  try { await checkCompleted(manifest, options, task, signal, false) }
  catch (error) { if (!signal.aborted) throw error; return result(manifest, task, true) }
  await options.output.check()
  return result(manifest, task, false)
}

/**
 * Look up an existing selected source using its saved catalog without creating output or contacting native.
 * @param options - Source identity, current output authorization and deployment bounds.
 * @param signal - Optional cancellation for local verification.
 * @returns Verified saved progress; an absent task reports series-task-not-found.
 */
export async function readStoredSeriesStatus(options: StoredSeriesOptions, signal: AbortSignal = new AbortController().signal): Promise<SeriesResult> {
  const probe: SeriesOptions = { ...options, selection: { srcAppId: options.srcAppId, dramaId: options.dramaId,
    episodeCount: 1, actualEpisodeNumbers: [], catalogComplete: false } }
  validateOptions(probe); signal.throwIfAborted()
  const task = paths(probe)
  await options.output.check()
  try {
    const info = await lstat(task.taskDirectory)
    if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(task.taskDirectory)) !== task.taskDirectory) throw new BridgeError('series-output-replaced')
  } catch (error) { if (!absent(error)) throw error; throw new BridgeError('series-task-not-found') }
  const value = await readManifestValue(task)
  if (value === undefined) throw new BridgeError('series-task-not-found')
  if (!record(value) || value.schemaVersion !== 1 || value.taskId !== task.taskId || !record(value.selection)) throw new BridgeError('series-manifest-invalid')
  const selected = value.selection
  if (Object.keys(selected).some(key => !['srcAppId', 'dramaId', 'title', 'episodeCount', 'actualEpisodeNumbers', 'catalogComplete'].includes(key))
    || selected.srcAppId !== options.srcAppId || selected.dramaId !== options.dramaId || typeof selected.episodeCount !== 'number'
    || typeof selected.catalogComplete !== 'boolean' || !Array.isArray(selected.actualEpisodeNumbers)
    || !selected.actualEpisodeNumbers.every((number: unknown): number is number => typeof number === 'number')
    || selected.title !== undefined && typeof selected.title !== 'string') throw new BridgeError('series-manifest-invalid')
  const selection: SeriesSelection = { srcAppId: options.srcAppId, dramaId: options.dramaId,
    episodeCount: selected.episodeCount, actualEpisodeNumbers: selected.actualEpisodeNumbers, catalogComplete: selected.catalogComplete,
    ...(selected.title === undefined ? {} : { title: selected.title }) }
  const resolved = { ...probe, selection }
  try { validateOptions(resolved) }
  catch (error) { void error; throw new BridgeError('series-manifest-invalid') }
  return await readSeriesStatus(resolved, signal)
}

/**
 * Download current catalog entries while retaining historical keys across temporary catalog omissions.
 * @param options - Authorized output, fresh catalog and explicit invocation bounds.
 * @param dependencies - Native acquisition, original-key reconciliation and transport error classification.
 * @param signal - Cancellation; the active callback settles before progress is committed and returned.
 * @returns Verified progress; missing, denied or unresolved episodes keep the task partial.
 */
export async function runSeries(options: SeriesOptions, dependencies: SeriesDependencies, signal: AbortSignal): Promise<SeriesResult> {
  validateOptions(options); const task = paths(options)
  if (signal.aborted) return result(initial(options, task), task, true)
  await options.output.create(); await options.output.check()
  try { await mkdir(task.taskDirectory, { mode: 0o700 }) }
  catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error }
  const identities = new Map<string, { dev: number; ino: number }>()
  const inspect = async (path: string): Promise<void> => {
    const info = await lstat(path), identity = identities.get(path)
    if (!info.isDirectory() || info.isSymbolicLink() || identity !== undefined && (info.dev !== identity.dev || info.ino !== identity.ino)
      || resolve(await realpath(path)) !== path) throw new BridgeError('series-output-replaced')
    identities.set(path, { dev: info.dev, ino: info.ino })
  }
  await inspect(task.taskDirectory)
  const check = async (): Promise<void> => {
    await options.output.check()
    for (const path of identities.keys()) await inspect(path)
  }
  const createEpisodeDirectory = async (episodeNo: number): Promise<void> => {
    for (const path of [join(task.taskDirectory, 'episodes'), episodeDirectory(task, episodeNo)]) {
      await check()
      try { await mkdir(path, { mode: 0o700 }) }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error }
      await inspect(path)
    }
  }
  await check()
  const lock = await privateLock(options, task)
  return await withFileLock(lock, async () => {
    await check()
    const manifest = await load(options, task) ?? initial(options, task)
    const save = async (): Promise<void> => { await check(); await writeFileAtomic(task.manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 }) }
    if (signal.aborted) return result(manifest, task, true)
    try { await checkCompleted(manifest, options, task, signal, true) }
    catch (error) { if (!signal.aborted) throw error; await save(); return result(manifest, task, true) }
    await save()
    for (const entry of currentEpisodes(manifest)) {
      if (signal.aborted) break
      if (entry.state === 'complete' || entry.state === 'denied') continue
      await createEpisodeDirectory(entry.episodeNo)
      if (signal.aborted) break
      const request = (): EpisodeRequest => ({ episodeNo: entry.episodeNo, requestKey: entry.requestKey,
        episodeDirectory: episodeDirectory(task, entry.episodeNo), attempt: entry.attempts })
      if (entry.state === 'unknown' || entry.retry === 'unknown') {
        try {
          await check()
          const reconciled = await dependencies.reconcile(request(), signal)
          await check()
          if (reconciled.kind === 'verified') {
            if (!await verifiedMedia(reconciled.media, options, request().episodeDirectory, signal)) throw new BridgeError('series-local-verification-failed')
            entry.state = 'complete'; entry.media = reconciled.media; delete entry.lastError; delete entry.retry
          } else if (reconciled.kind === 'retry') { entry.state = 'pending'; entry.retry = 'safe'; delete entry.lastError }
          else { entry.state = 'unknown'; entry.lastError = safeCode(reconciled.code ?? 'series-reconciliation-required') }
          await save()
        } catch (error) {
          entry.state = 'unknown'; entry.retry = 'unknown'; entry.lastError = safeCode(dependencies.classify(error).code); await save()
          if (cleanupUnconfirmed(error)) throw error
        }
        if (signal.aborted || entry.state === 'unknown') break
        if (entry.state === 'complete') continue
      }
      for (let attempt = 0; attempt < options.maxAttempts && !signal.aborted; attempt++) {
        entry.state = 'downloading'; entry.attempts++; delete entry.lastError; delete entry.retry
        await save()
        try {
          await check()
          const media = await dependencies.download(request(), signal)
          await check()
          if (!await verifiedMedia(media, options, request().episodeDirectory, signal)) throw new BridgeError('series-local-verification-failed')
          entry.media = media; entry.state = 'complete'; delete entry.lastError; delete entry.retry
          await save(); break
        } catch (error) {
          const failure = dependencies.classify(error)
          entry.state = failure.retry === 'safe' ? 'failed' : failure.retry === 'denied' ? 'denied' : 'unknown'
          entry.retry = failure.retry; entry.lastError = safeCode(failure.code); delete entry.media
          await save()
          if (cleanupUnconfirmed(error)) throw error
          if (signal.aborted || failure.retry !== 'safe' || attempt + 1 >= options.maxAttempts) break
          try { await delay(options.retryDelayMs, undefined, { signal }) }
          catch (failure) { if (!signal.aborted) throw failure; break }
        }
      }
      if (entry.state === 'unknown') break
    }
    await save()
    return result(manifest, task, signal.aborted)
  }, { waitMs: options.lockWaitMs })
}
