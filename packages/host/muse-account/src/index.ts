/** Muse Desktop account Remote service and bundled read-only MCP server. */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MuseAccountController } from './account.ts'
import { MuseAsrClient } from './asr.ts'
import { createMuseAccountGateway, museGatewayOrigin } from './gateway.ts'
import { MuseAccountService } from './service.ts'
import type {} from '@deepseek-ai/dsh-tools'

export { MuseAccountService } from './service.ts'
export { MuseAccountController } from './account.ts'
export { MuseAsrClient, MuseAsrError } from './asr.ts'
export type { MuseAsrJob } from './asr.ts'
export { createMuseAccountGateway, museGatewayOrigin } from './gateway.ts'
export type * from './types.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'muse-account'

/** Tool registry required to publish the bundled MCP tools. */
export const inject = ['tools']

/** Product-configured gateway and optional account storage directory. */
export interface Config {
  /** MUSE website origin serving account and knowledge-base access endpoints. */
  readonly baseUrl: string
  /** Product-private account directory; omission selects the active DSH home. */
  readonly accountHome?: string
  /** Timeout for account and knowledge-base gateway requests in milliseconds. */
  readonly requestTimeoutMs: number
  /** Maximum time for one compressed-audio upload and gateway response. */
  readonly asrRequestTimeoutMs: number
}

/** Validate account endpoint configuration at plugin load. */
export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string().required(),
  accountHome: Schema.string(),
  requestTimeoutMs: Schema.number().step(1).min(1_000).max(120_000).default(15_000),
  asrRequestTimeoutMs: Schema.number().step(1).min(10_000).max(1_800_000).default(300_000),
})

/**
 * Mount the Host account service and await the bundled stdio MCP discovery.
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
  const service = ctx.plugin(MuseAccountService, { controller, asr })
  await service.await()

  const server = fileURLToPath(new URL('./mcp-server.js', import.meta.url))
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
