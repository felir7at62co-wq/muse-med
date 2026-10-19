/** Muse tool facade for a separately configured, target-bound Windows helper. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './bridge.ts'
import { BridgeError, type Action, type Parameters, type RequestPort } from './port.ts'
import { errorResult, outputSchema, projectResult } from './result.ts'
import { DownloadRequestPort } from './download.ts'
import { authorizeOutput } from './output.ts'

/** Agent-scoped model limits; connection coordinates belong to the shared bridge. */
export interface ToolLimits { readonly maxQueryChars: number; readonly maxEpisodeCount: number; readonly maxResultItems: number }
/** Consumer configuration contains no host paths, credentials, or helper coordinates. */
export const Config: Schema<ToolLimits> = Schema.object({
  maxQueryChars: Schema.number().step(1).min(1).max(80).default(80),
  maxEpisodeCount: Schema.number().step(1).min(1).max(20).default(20),
  maxResultItems: Schema.number().step(1).min(1).max(50).default(50),
})
/** Loader identity; the model-visible name is lvpaopao. */
export const name = 'muse-lvpaopao'
/** Required registries; no direct Node child-process launch is used. */
export const inject = ['tools', 'agents', 'subprocess', 'lvpaopaoBridge']

function parameters(action: Action, args: Parameters, limits: ToolLimits): Parameters {
  const allowed = action === 'status' ? [] : action === 'search' ? ['query']
    : action === 'episodes' ? ['srcAppId', 'dramaId', 'start', 'count'] : ['srcAppId', 'dramaId']
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new BridgeError('invalid-arguments')
  if (action === 'status') return {}
  if (action === 'search') {
    if (typeof args.query !== 'string' || !args.query.trim() || Array.from(args.query).length > limits.maxQueryChars || /[\x00\r\n]/.test(args.query)) throw new BridgeError('invalid-arguments')
    return { query: args.query }
  }
  if (typeof args.srcAppId !== 'string' || !/^wx[0-9a-f]{16}$/.test(args.srcAppId)
    || typeof args.dramaId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(args.dramaId)) throw new BridgeError('invalid-arguments')
  if (action === 'episodes') {
    if (!Number.isSafeInteger(args.start) || Number(args.start) < 1 || !Number.isSafeInteger(args.count)
      || Number(args.count) < 1 || Number(args.count) > limits.maxEpisodeCount) throw new BridgeError('invalid-arguments')
    return { srcAppId: args.srcAppId, dramaId: args.dramaId, start: Number(args.start), count: Number(args.count) }
  }
  if (action === 'download_first_episode' && !/^[A-Za-z0-9_-]{1,64}$/.test(args.dramaId)) throw new BridgeError('invalid-arguments')
  return { srcAppId: args.srcAppId, dramaId: args.dramaId }
}

/**
 * Register the real tool with a replaceable process transport for composition tests.
 * @param ctx - Owning tool scope.
 * @param port - Helper request owner; disposal is registered on the same scope.
 * @param config - Resolved request and result bounds.
 */
export function registerLvpaopao(ctx: Context, port: RequestPort, config: ToolLimits,
  download?: (params: Parameters, signal: AbortSignal, outputDir?: string) => Promise<unknown>): void {
  const lifetime = new AbortController()
  const operations = new Set<Promise<unknown>>()
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...operations])
    await port.dispose()
  })
  ctx.tools.register(defineTool({
    name: 'lvpaopao',
    description: 'Search Lvpaopao dramas, read details and actual episode numbers through the configured Windows WeChat target. status reports readiness. When the trusted local download lane is enabled, download_first_episode copies only an authorized first episode and verifies its bytes and hash. Results do not grant content reuse rights.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'search', 'detail', 'episodes', 'download_first_episode'] },
      query: { type: 'string', description: 'search: title query.' },
      srcAppId: { type: 'string', description: 'detail/episodes/download_first_episode: source AppID returned by search.' },
      dramaId: { type: 'string', description: 'detail/episodes/download_first_episode: source drama identifier, kept as a string.' },
      start: { type: 'integer', description: 'episodes: first requested positive episode number.' },
      count: { type: 'integer', description: 'episodes: bounded requested count. The result reports only actual returned numbers.' },
      outputDir: { type: 'string', description: 'download_first_episode only: defaults to downloads/lvpaopao in this Session workspace. Relative paths stay inside that workspace; an external absolute path requires full file access.' },
    },
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const { action, outputDir, ...rest } = args
      const active = AbortSignal.any([exec.signal, lifetime.signal])
      try {
        active.throwIfAborted()
        if (outputDir !== undefined && action !== 'download_first_episode') throw new BridgeError('invalid-arguments')
        const input = parameters(action, rest, config)
        const work = action === 'download_first_episode' && download !== undefined
          ? download(input, active, outputDir) : port.request(action, input, active)
        operations.add(work)
        let value: unknown
        try { value = await work }
        finally { operations.delete(work) }
        active.throwIfAborted()
        const result = projectResult(action, value, config)
        if (result.ok && (action === 'detail' || action === 'episodes')
          && (result.data.srcAppId !== input.srcAppId || result.data.dramaId !== input.dramaId)) throw new BridgeError('response-identity-mismatch')
        return result
      } catch (error) {
        const cleanupUnconfirmed = error instanceof BridgeError
          && ['download-copy-cleanup-unconfirmed', 'remote-cleanup-unconfirmed', 'remote-exit-failed', 'cancel-unconfirmed'].includes(error.code)
        const result = errorResult(action, active.aborted && !cleanupUnconfirmed ? new BridgeError('cancelled') : error)
        if (result.status === 'unconfigured') {
          result.data.ready = false
          result.warnings.push('Lvpaopao is not configured. Configure the shared Windows bridge before requesting search or downloads; no connection was started.')
        }
        return result
      }
    },
    presentCall: args => ({ card: 'generic', title: `Lvpaopao: ${args.action}`, kind: args.action === 'download_first_episode' ? 'fetch' : 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Lvpaopao', content: result.content }),
  }))
}

/**
 * Register one Agent's tools while borrowing the Host-owned bridge connection.
 * @param ctx - Scoped tools, exact initiator, local subprocess and shared bridge.
 * @param config - Model query and result limits; no transport configuration.
 */
export function apply(ctx: Context, config: ToolLimits): void {
  const bridge = ctx.lvpaopaoBridge
  const copies = new Set<DownloadRequestPort>()
  const borrowed: RequestPort = {
    async request(action, params, signal) {
      if (bridge.configuration === undefined) throw new BridgeError('unconfigured')
      return await bridge.request(action, params, signal)
    },
    async dispose() { /* The Host bridge outlives each Agent's borrowed requests. */ },
  }
  const owned: RequestPort = {
    request: (action, params, signal) => borrowed.request(action, params, signal),
    async dispose() {
      const settled = await Promise.allSettled([...copies].map(copy => copy.dispose()))
      if (settled.some(result => result.status === 'rejected')) throw new BridgeError('download-copy-cleanup-unconfirmed')
      copies.clear()
    },
  }
  registerLvpaopao(ctx, owned, config, async (params, signal, outputDir) => {
    const transport = bridge.configuration
    if (transport === undefined) throw new BridgeError('unconfigured')
    if (!transport.downloadEnabled) throw new BridgeError('capability-not-ready')
    const { session } = ctx.agents.requireInitiator()
    const policy = ctx.get('sandboxPolicy')?.resolve({ session })
    const output = await authorizeOutput(session, outputDir, policy)
    signal.throwIfAborted()
    const copy = new DownloadRequestPort(borrowed, ctx.subprocess, transport, {
      enabled: true, outputDir: output.path, output,
      scpExecutable: transport.scpExecutable, copyTimeoutMs: transport.copyTimeoutMs,
      copyPollIntervalMs: transport.copyPollIntervalMs, maxMediaBytes: transport.maxMediaBytes,
    })
    copies.add(copy)
    try { return await copy.request('download_first_episode', params, signal) }
    finally {
      try { await copy.dispose(); copies.delete(copy) }
      catch (error) {
        // Keep the failed copy owned until scope teardown also reports its unconfirmed range.
        void error
        throw new BridgeError('download-copy-cleanup-unconfirmed')
      }
    }
  })
}
