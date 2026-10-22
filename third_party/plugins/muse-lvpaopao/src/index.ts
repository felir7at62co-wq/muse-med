/** Agent-scoped Lvpaopao catalog and resumable local series downloads. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './bridge.ts'
import { BridgeError, type Parameters, type RequestPort } from './port.ts'
import { errorResult, outputSchema, projectResult, seriesResult, type Result, type ToolAction } from './result.ts'
import { DownloadRequestPort, localDownload } from './download.ts'
import { EpisodeDownloadRequestPort } from './episode-download.ts'
import { authorizeOutput } from './output.ts'
import { resolveSeriesCatalog } from './catalog.ts'
import { runSeries, readStoredSeriesStatus, type EpisodeRequest, type SeriesFailure, type SeriesOptions } from './series.ts'

/** Agent-scoped metadata bounds; connection coordinates belong to the shared bridge. */
export interface ToolLimits { readonly maxQueryChars: number; readonly maxEpisodeCount: number; readonly maxResultItems: number }
/** Configurable orchestration bounds, without host paths or credentials. */
export interface PluginConfig extends ToolLimits {
  readonly maxSeriesEpisodes: number
  readonly maxAttempts: number
  readonly retryDelayMs: number
  readonly seriesLockWaitMs: number
  readonly copyChunkBytes: number
}
/** Resolve all operation bounds before registering tools. */
export const Config: Schema<PluginConfig> = Schema.object({
  maxQueryChars: Schema.number().step(1).min(1).max(80).default(80),
  maxEpisodeCount: Schema.number().step(1).min(1).max(20).default(20),
  maxResultItems: Schema.number().step(1).min(1).max(50).default(50),
  maxSeriesEpisodes: Schema.number().step(1).min(1).max(10000).default(400),
  maxAttempts: Schema.number().step(1).min(1).max(20).default(3),
  retryDelayMs: Schema.number().step(1).min(0).max(60000).default(1000),
  seriesLockWaitMs: Schema.number().step(1).min(0).max(60000).default(5000),
  copyChunkBytes: Schema.number().step(1).min(1).max(8388608).default(1048576),
})
/** Loader identity; the model-visible name is lvpaopao. */
export const name = 'muse-lvpaopao'
/** Agent identity, local subprocess owner and shared native connection. */
export const inject = ['tools', 'agents', 'subprocess', 'lvpaopaoBridge']

function parameters(action: ToolAction, args: Parameters, limits: ToolLimits): Parameters {
  const allowed = action === 'status' ? [] : action === 'search' ? ['query']
    : action === 'rankings' ? ['boardType', 'pageIndex', 'count', 'coldStartTime']
    : action === 'episodes' ? ['srcAppId', 'dramaId', 'start', 'count']
      : action === 'download_series' ? ['query', 'srcAppId', 'dramaId']
        : action === 'download_episode' || action === 'download_status' ? ['srcAppId', 'dramaId', 'episodeNo', 'idempotencyKey'] : ['srcAppId', 'dramaId']
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new BridgeError('invalid-arguments')
  if (action === 'status') return {}
  if (action === 'rankings') {
    const boardType = args.boardType ?? 6, pageIndex = args.pageIndex ?? 0, count = args.count ?? 20
    const coldStartTime = args.coldStartTime ?? Math.floor(Date.now() / 1000)
    if (!Number.isSafeInteger(boardType) || boardType < 1 || boardType > 2147483647
      || !Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex > 10000
      || !Number.isSafeInteger(count) || count < 1 || count > limits.maxEpisodeCount
      || !Number.isSafeInteger(coldStartTime) || coldStartTime < 1 || coldStartTime > 2147483647) throw new BridgeError('invalid-arguments')
    return { boardType, pageIndex, count, coldStartTime }
  }
  if (action === 'search' || action === 'download_series' && args.query !== undefined) {
    if (args.srcAppId !== undefined || args.dramaId !== undefined || typeof args.query !== 'string' || !args.query.trim()
      || Array.from(args.query).length > limits.maxQueryChars || /[\x00\r\n]/.test(args.query)) throw new BridgeError('invalid-arguments')
    return { query: args.query }
  }
  if (typeof args.srcAppId !== 'string' || !/^wx[0-9a-f]{16}$/.test(args.srcAppId)
    || typeof args.dramaId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(args.dramaId)) throw new BridgeError('invalid-arguments')
  if (action === 'episodes') {
    if (!Number.isSafeInteger(args.start) || Number(args.start) < 1 || !Number.isSafeInteger(args.count)
      || Number(args.count) < 1 || Number(args.count) > limits.maxEpisodeCount) throw new BridgeError('invalid-arguments')
    return { srcAppId: args.srcAppId, dramaId: args.dramaId, start: Number(args.start), count: Number(args.count) }
  }
  if (action !== 'detail' && !/^[A-Za-z0-9_-]{1,64}$/.test(args.dramaId)) throw new BridgeError('invalid-arguments')
  if (action === 'download_episode' || action === 'download_status') {
    if (!Number.isSafeInteger(args.episodeNo) || Number(args.episodeNo) < 1 || Number(args.episodeNo) > 10000
      || typeof args.idempotencyKey !== 'string' || !/^[a-f0-9]{64}$/.test(args.idempotencyKey)) throw new BridgeError('invalid-arguments')
    return { srcAppId: args.srcAppId, dramaId: args.dramaId, episodeNo: Number(args.episodeNo), idempotencyKey: args.idempotencyKey }
  }
  return { srcAppId: args.srcAppId, dramaId: args.dramaId }
}
/** Session-owned extension for series orchestration and exact per-episode copies. */
export type ToolOperation = (action: 'download_episode' | 'download_status' | 'download_series' | 'series_status', params: Parameters,
  signal: AbortSignal, outputDir?: string) => Promise<Result>

/**
 * Register the real tool with an injected high-level transport for composition tests.
 * @param ctx - Owning tool scope.
 * @param port - Borrowed helper requests with owned tool-scope disposal.
 * @param config - Resolved request and result limits.
 * @param download - Legacy first-episode compatibility lane.
 * @param operation - Session-authorized episode and whole-series orchestration.
 */
export function registerLvpaopao(ctx: Context, port: RequestPort, config: ToolLimits,
  download?: (params: Parameters, signal: AbortSignal, outputDir?: string) => Promise<unknown>, operation?: ToolOperation): void {
  const lifetime = new AbortController(), operations = new Set<Promise<unknown>>()
  ctx.effect(() => async () => { lifetime.abort(); await Promise.allSettled([...operations]); await port.dispose() })
  ctx.tools.register(defineTool({
    name: 'lvpaopao',
    description: 'Read Lvpaopao rankings, search titles and inspect actual catalogs in a qualified local WeChat runtime. rankings returns current board labels, source positions and identities; page with the same boardType, count and returned coldStartTime. download_series accepts a title (asks for selection when ambiguous) or selected source IDs, persists each actual episode and resumes the same task. Only account-playable episodes are downloaded; no purchases, ads or unlocks. series_status reads local task progress by source IDs without a native connection. Completion requires every catalog episode and verified local files. Unknown outcomes require original-key download_status, never a fresh acquisition key. Open/reopen Lvpaopao when status reports waiting-target. Results do not grant reuse rights.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'search', 'detail', 'episodes', 'download_first_episode', 'download_episode', 'download_status', 'download_series', 'series_status', 'rankings'] },
      boardType: { type: 'integer', description: 'rankings: board type from returned boards; defaults to the app reputation board (6).' },
      pageIndex: { type: 'integer', description: 'rankings: zero-based page; defaults to 0.' },
      coldStartTime: { type: 'integer', description: 'rankings: reuse the returned timestamp with the same board and count for subsequent pages.' },
      query: { type: 'string', description: 'search/download_series: title. download_series selects only one exact match; otherwise use returned candidates.' },
      srcAppId: { type: 'string', description: 'Source AppID returned by search; required with dramaId except title lookup.' },
      dramaId: { type: 'string', description: 'Source drama ID, kept as a string. series_status uses this identity to read saved progress.' },
      start: { type: 'integer', description: 'episodes: first positive requested number.' },
      count: { type: 'integer', description: 'episodes/rankings: bounded page width, at most 20. Keep the same width when paging a ranking.' },
      episodeNo: { type: 'integer', description: 'download_episode/download_status: actual episode number from the catalog.' },
      idempotencyKey: { type: 'string', description: 'download_episode/download_status: original durable 64-character lowercase hex key; reuse it for all retries and reconciliation.' },
      outputDir: { type: 'string', description: 'Downloads/series_status: defaults to downloads/lvpaopao in this Session workspace. Relative paths stay inside it; external paths require full file access. Reuse the same destination when resuming.' },
    },
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const { action, outputDir, ...rest } = args, active = AbortSignal.any([exec.signal, lifetime.signal])
      try {
        active.throwIfAborted()
        const extended = action === 'download_episode' || action === 'download_status' || action === 'download_series' || action === 'series_status'
        if (outputDir !== undefined && action !== 'download_first_episode' && !extended) throw new BridgeError('invalid-arguments')
        const input = parameters(action, rest, config)
        if (extended) {
          if (operation === undefined) throw new BridgeError('capability-not-ready')
          const work = operation(action, input, active, outputDir)
          operations.add(work)
          // Persist series progress before ToolRuntime emits its outer cancellation result.
          try { return await work } finally { operations.delete(work) }
        }
        const work = action === 'download_first_episode' && download !== undefined ? download(input, active, outputDir) : port.request(action, input, active)
        operations.add(work)
        let value: unknown
        try { value = await work } finally { operations.delete(work) }
        active.throwIfAborted()
        const result = projectResult(action, value, config)
        if (result.ok && (action === 'detail' || action === 'episodes')
          && (result.data.srcAppId !== input.srcAppId || result.data.dramaId !== input.dramaId)) throw new BridgeError('response-identity-mismatch')
        if (result.ok && action === 'rankings' && (result.data.boardType !== input.boardType
          || result.data.pageIndex !== input.pageIndex || result.data.pageSize !== input.count
          || result.data.coldStartTime !== input.coldStartTime)) throw new BridgeError('response-identity-mismatch')
        return result
      } catch (error) {
        const unconfirmed = error instanceof BridgeError && (error.code.includes('cleanup-unconfirmed') || ['remote-exit-failed', 'cancel-unconfirmed'].includes(error.code))
        return errorResult(action, active.aborted && !unconfirmed ? new BridgeError('cancelled') : error)
      }
    },
    presentCall: args => ({ card: 'generic', title: `Lvpaopao: ${args.action}`, kind: args.action.startsWith('download') ? 'fetch' : 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Lvpaopao', content: result.content }),
  }))
}
function failure(error: unknown): SeriesFailure {
  const code = error instanceof BridgeError ? error.code : 'transport-error'
  const denied = ['straight-playback-unconfirmed', 'playable-episode-unconfirmed']
  // Only a bound saved receipt makes transfer retries safe; native reuses that original key.
  const safe = ['transfer-failed', 'download-copy-timeout', 'download-copy-failed', 'download-local-hash-mismatch', 'download-source-changed']
  return { code, retry: denied.includes(code) ? 'denied' : safe.includes(code) ? 'safe' : 'unknown' }
}

/**
 * Register one Agent's tools while borrowing the Host-owned native connection.
 * @param ctx - Scoped tools, exact initiator, local subprocess and shared bridge.
 * @param config - Resolved catalog, retry and copy bounds.
 */
export function apply(ctx: Context, config: PluginConfig): void {
  const bridge = ctx.lvpaopaoBridge, copies = new Set<RequestPort>()
  const borrowed: RequestPort = { request: (action, params, signal) => bridge.request(action, params, signal),
    async dispose() { /* The Host bridge outlives Agent-scoped requests. */ } }
  const owned: RequestPort = { request: borrowed.request, async dispose() {
    const settled = await Promise.allSettled([...copies].map(copy => copy.dispose()))
    if (settled.some(result => result.status === 'rejected')) throw new BridgeError('download-copy-cleanup-unconfirmed')
    copies.clear()
  } }
  const withCopy = async (copy: RequestPort, action: 'download_first_episode' | 'download_episode' | 'download_status', params: Parameters, signal: AbortSignal): Promise<unknown> => {
    copies.add(copy)
    try { return await copy.request(action, params, signal) }
    finally {
      try { await copy.dispose(); copies.delete(copy) }
      catch (error) { void error; throw new BridgeError('download-copy-cleanup-unconfirmed') }
    }
  }
  const outputFor = async (outputDir: string | undefined, read = false) => {
    const { session } = ctx.agents.requireInitiator(), policy = ctx.get('sandboxPolicy')?.resolve({ session })
    return await authorizeOutput(session, outputDir, policy, read ? 'read' : 'write')
  }
  registerLvpaopao(ctx, owned, config, async (params, signal, outputDir) => {
    const output = await outputFor(outputDir)
    const transport = await bridge.resolveConfiguration(signal)
    if (!transport.downloadEnabled) throw new BridgeError('capability-not-ready')
    if (transport.transport === 'local') {
      const idempotencyKey = createHash('sha256').update(JSON.stringify(['first-episode', params.srcAppId, params.dramaId, output.path])).digest('hex')
      const request = { ...params, episodeNo: 1, idempotencyKey }
      const copy = new EpisodeDownloadRequestPort(borrowed, ctx.subprocess, transport, { output,
        directory: join(output.path, `episode-${idempotencyKey}`), chunkBytes: config.copyChunkBytes,
        maxMediaBytes: transport.maxMediaBytes, copyTimeoutMs: transport.copyTimeoutMs })
      const existing = await withCopy(copy, 'download_status', request, signal)
      if (localDownload(existing) !== undefined) return existing
      if (existing === null || typeof existing !== 'object' || !('status' in existing)
        || !['request-not-found', 'resume-available'].includes(String(existing.status))) throw new BridgeError('outcome-unconfirmed')
      return await withCopy(new EpisodeDownloadRequestPort(borrowed, ctx.subprocess, transport, { output,
        directory: join(output.path, `episode-${idempotencyKey}`), chunkBytes: config.copyChunkBytes,
        maxMediaBytes: transport.maxMediaBytes, copyTimeoutMs: transport.copyTimeoutMs }), 'download_episode', request, signal)
    }
    const copy = new DownloadRequestPort(borrowed, ctx.subprocess, transport, { enabled: true, outputDir: output.path, output,
      scpExecutable: transport.scpExecutable, copyTimeoutMs: transport.copyTimeoutMs, copyPollIntervalMs: transport.copyPollIntervalMs, maxMediaBytes: transport.maxMediaBytes })
    return await withCopy(copy, 'download_first_episode', params, signal)
  }, async (action, params, signal, outputDir) => {
    const output = await outputFor(outputDir, action === 'series_status')
    const bounds = { output, lockDirectory: dshHomePath('lvpaopao', 'locks'), maxAttempts: config.maxAttempts,
      retryDelayMs: config.retryDelayMs, lockWaitMs: config.seriesLockWaitMs, maxEpisodes: config.maxSeriesEpisodes }
    if (action === 'series_status') return seriesResult(action, await readStoredSeriesStatus({ ...bounds, maxMediaBytes: 2147483648,
      srcAppId: String(params.srcAppId), dramaId: String(params.dramaId) }, signal))
    const selected = action === 'download_series' ? await resolveSeriesCatalog(borrowed, params, config, signal) : undefined
    if (selected?.kind === 'selection-required') return { action, ok: false, status: 'selection-required', data: { candidates: [...selected.candidates] }, warnings: ['Select one returned source before downloading; no media request or output directory was created.'] }
    const transport = await bridge.resolveConfiguration(signal)
    if (!transport.downloadEnabled) throw new BridgeError('capability-not-ready')
    const episode = (nativeAction: 'download_episode' | 'download_status', request: Parameters, directory: string, active: AbortSignal) => withCopy(
      new EpisodeDownloadRequestPort(borrowed, ctx.subprocess, transport, { output, directory, chunkBytes: config.copyChunkBytes,
        maxMediaBytes: transport.maxMediaBytes, copyTimeoutMs: transport.copyTimeoutMs }), nativeAction, request, active)
    if (action !== 'download_series') return projectResult(action, await episode(action, params, join(output.path, `episode-${params.idempotencyKey}`), signal), config)
    if (selected?.kind !== 'selected') throw new BridgeError('catalog-count-unconfirmed')
    const options: SeriesOptions = { ...bounds, selection: selected.selection, maxMediaBytes: transport.maxMediaBytes }
    const source = { srcAppId: selected.selection.srcAppId, dramaId: selected.selection.dramaId }
    const nativeParams = (request: EpisodeRequest): Parameters => ({ ...source, episodeNo: request.episodeNo, idempotencyKey: request.requestKey })
    return seriesResult(action, await runSeries(options, {
      async download(request, active) {
        const result = localDownload(await episode('download_episode', nativeParams(request), request.episodeDirectory, active))
        if (result === undefined) throw new BridgeError('download-local-verification-failed')
        return result.media
      },
      async reconcile(request, active) {
        const result = await episode('download_status', nativeParams(request), request.episodeDirectory, active), local = localDownload(result)
        if (local !== undefined) return { kind: 'verified', media: local.media }
        if (result !== null && typeof result === 'object' && 'status' in result && ['request-not-found', 'resume-available'].includes(String(result.status))) return { kind: 'retry' }
        return { kind: 'unknown', code: 'series-reconciliation-required' }
      }, classify: failure,
    }, signal))
  })
}
