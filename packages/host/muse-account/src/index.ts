/** Muse Desktop account service, session-authorized models, and bundled knowledge-base MCP server. */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MuseAccountController } from './account.ts'
import { MuseAsrClient } from './asr.ts'
import { MuseModels } from './models.ts'
import { createMuseAccountGateway, museGatewayOrigin } from './gateway.ts'
import { MuseAccountService } from './service.ts'
import { MuseFeedbackClient, feedbackSecrets } from './feedback.ts'
import { MuseDesktopRemote } from './desktop-remote.ts'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

export { MuseAccountService } from './service.ts'
export { MuseAccountController } from './account.ts'
export { MuseAsrClient, MuseAsrError } from './asr.ts'
export type { MuseAsrJob, MuseAsrSegment, MuseAsrPurpose } from './asr.ts'
export { createMuseAccountGateway, museGatewayOrigin } from './gateway.ts'
export type * from './types.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'muse-account'

/** Registries, Session model state and default selection used by account-authorized requests. */
export const inject = ['tools', 'llm', 'sessionProjections', 'agentDefaultModel']

/** Product-configured gateway and optional account storage directory. */
export interface Config {
  /** MUSE website origin serving account and knowledge-base access endpoints. */
  readonly baseUrl: string
  /** Interval for refreshing the account model catalog, in milliseconds. */
  readonly modelRefreshMs: number
  /** Model ID prefixes excluded from the account-supplied catalog. */
  readonly excludedModelPrefixes: string[]
  /** Exact provider IDs excluded from the account-supplied catalog; personal adapters are unaffected. */
  readonly excludedProviderIds: string[]
  /** Product-private account directory; omission selects the active DSH home. */
  readonly accountHome?: string
  /** Timeout for account and knowledge-base gateway requests in milliseconds. */
  readonly requestTimeoutMs: number
  /** Maximum time for one compressed-audio upload and gateway response. */
  readonly asrRequestTimeoutMs: number
  /** Maximum visible characters in each optional related request and answer excerpt. */
  readonly feedbackExcerptChars: number
  /** Enable the product's account-bound desktop connector; requires its three Host providers. */
  readonly remoteAccess: boolean
  /** Largest acknowledged chunk forwarded over the desktop connection, in bytes. */
  readonly remoteChunkBytes: number
  /** Deadline for a handshake or chunk acknowledgement, in milliseconds. */
  readonly remoteAckTimeoutMs: number
  /** Maximum interval between automatic network reconnection attempts, in milliseconds. */
  readonly remoteReconnectMaxIntervalMs: number
}

/** Validate account endpoint configuration at plugin load. */
export const Config: Schema<Pick<Config, 'baseUrl'> & Partial<Omit<Config, 'baseUrl'>>, Config> = Schema.object({
  baseUrl: Schema.string().required(),
  modelRefreshMs: Schema.number().step(1).min(10_000).max(3_600_000).default(60_000),
  excludedModelPrefixes: Schema.array(Schema.string()).default([]),
  excludedProviderIds: Schema.array(Schema.string().pattern(/^[a-z][a-z0-9-]{0,63}$/)).default([]),
  accountHome: Schema.string(),
  requestTimeoutMs: Schema.number().step(1).min(1_000).max(120_000).default(15_000),
  asrRequestTimeoutMs: Schema.number().step(1).min(10_000).max(1_800_000).default(300_000),
  feedbackExcerptChars: Schema.number().step(1).min(100).max(1_200).default(1_000),
  remoteAccess: Schema.boolean().default(false),
  remoteChunkBytes: Schema.number().step(1).min(1024).max(32768).default(32768),
  remoteAckTimeoutMs: Schema.number().step(1).min(1000).max(120_000).default(15_000),
  remoteReconnectMaxIntervalMs: Schema.number().step(1).min(1000).max(300_000).default(60_000),
})

/**
 * Mount the Host account service and await the bundled stdio MCP discovery.
 * The MCP child requires the package's built files, including for source profile launches.
 * @param ctx - Product Host context.
 * @param config - Gateway origin and optional product-home storage directory.
 * @returns Completion after the MCP tools have registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const baseUrl = museGatewayOrigin(config.baseUrl)
  const accountHome = config.accountHome ?? dshHomePath('muse-account')
  if (!isAbsolute(accountHome)) throw new Error('muse-account: accountHome must be absolute')
  const controller = new MuseAccountController({
    baseUrl,
    sessionFile: join(accountHome, 'session.json'),
    gateway: createMuseAccountGateway(baseUrl, config.requestTimeoutMs),
  })
  const asr = new MuseAsrClient({ baseUrl, sessionFile: join(accountHome, 'session.json'), requestTimeoutMs: config.asrRequestTimeoutMs })
  const models = new MuseModels(ctx, { baseUrl, sessionFile: join(accountHome, 'session.json'), requestTimeoutMs: config.requestTimeoutMs,
    excludedModelPrefixes: config.excludedModelPrefixes, excludedProviderIds: config.excludedProviderIds })
  let remote: MuseDesktopRemote | undefined
  if (config.remoteAccess) {
    const bridge = ctx.get('museDesktopBridge')
    const connection = ctx.get('connection')
    const webServer = ctx.get('webServer')
    if (bridge === undefined || connection === undefined || webServer === undefined) {
      throw Error('muse-account: remoteAccess requires museDesktopBridge, connection and webServer providers')
    }
    remote = new MuseDesktopRemote({
      baseUrl, sessionFile: join(accountHome, 'session.json'), deviceFile: join(accountHome, 'desktop-device.json'), bridge,
      chunkBytes: config.remoteChunkBytes, ackTimeoutMs: config.remoteAckTimeoutMs,
      reconnectMaxIntervalMs: config.remoteReconnectMaxIntervalMs,
      localAuthorization: async () => {
        const port = webServer.port
        const bootstrap = connection.authenticatedUrl(`http://127.0.0.1:${port}`)
        const response = await fetch(bootstrap, { redirect: 'manual', signal: AbortSignal.timeout(config.requestTimeoutMs) })
        const cookie = response.headers.getSetCookie().map(header => header.split(';', 1)[0]).join('; ')
        await response.body?.cancel()
        if (response.status >= 400 || cookie.length === 0) throw Error('muse-account: local Host authorization failed')
        return { port, cookie }
      },
      onState: (state) => {
        if (state === 'rejected') ctx.logger.warn('Muse desktop connection was rejected; verify your account and connected computer.')
      },
    })
    const owned = remote
    ctx.effect(() => () => owned.dispose(), 'muse-account: desktop connection')
  }
  ctx.effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    const refresh = async (): Promise<void> => {
      try { await models.refresh() } catch (_error) { ctx.logger.warn('Muse model catalog is unavailable; open account settings to retry.') }
      try { await remote?.refresh() } catch (_error) { ctx.logger.warn('Muse desktop connection is unavailable; open account settings to retry.') }
      if (!closed) { timer = setTimeout(() => { void refresh() }, config.modelRefreshMs); timer.unref() }
    }
    void refresh()
    return async () => { closed = true; clearTimeout(timer); await models.dispose() }
  })
  const feedback = new MuseFeedbackClient({ baseUrl, sessionFile: join(accountHome, 'session.json'),
    requestTimeoutMs: config.requestTimeoutMs, excerptChars: config.feedbackExcerptChars,
    readMessages: request => ctx.get('sessions')?.get(request.sessionId)?.deriveMessages(),
    secrets: () => feedbackSecrets(ctx) })
  const service = ctx.plugin(MuseAccountService, { controller, asr, models, feedback, ...(remote === undefined ? {} : { remote }) })
  await service.await()

  const server = fileURLToPath(new URL('./lib/types/mcp-server.js', import.meta.resolve('@deepseek-ai/dsh-muse-account/package.json')))
  const child = ctx.plugin(McpClient, McpClient.Config({
    serverName: 'muse-account',
    transport: 'stdio',
    command: process.execPath,
    args: [server],
    env: { MUSE_ACCOUNT_CONFIG: JSON.stringify({ baseUrl, accountHome, requestTimeoutMs: config.requestTimeoutMs }) },
    failOnStartupError: true,
  }))
  await child.await()
}
