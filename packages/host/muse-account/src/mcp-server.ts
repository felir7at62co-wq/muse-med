/** Bundled stdio MCP process for account status and authorized KB reading. */

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MuseAccountController } from './account.ts'
import { createMuseAccountGateway, museGatewayOrigin } from './gateway.ts'
import { createMuseKbReader, MuseKbError, type MuseKbResult } from './kb.ts'

/** Startup data injected by the Host; no password, cookie, or bearer belongs here. */
interface LaunchConfig {
  readonly baseUrl: string
  readonly accountHome: string
  readonly requestTimeoutMs: number
}

/**
 * Validate the Host-supplied, credential-free child configuration.
 * @param raw - JSON environment value.
 * @returns Gateway origin and absolute account directory.
 */
export function parseMuseAccountLaunch(raw: string | undefined): LaunchConfig {
  if (raw === undefined) throw new Error('muse-account MCP: missing MUSE_ACCOUNT_CONFIG')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('muse-account MCP: invalid MUSE_ACCOUNT_CONFIG')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('muse-account MCP: config must be an object')
  }
  const fields = value as Record<string, unknown>
  const requestTimeoutMs = fields.requestTimeoutMs
  if (typeof fields.baseUrl !== 'string' || typeof fields.accountHome !== 'string' || !isAbsolute(fields.accountHome)
    || typeof requestTimeoutMs !== 'number' || !Number.isSafeInteger(requestTimeoutMs)
    || requestTimeoutMs < 1_000 || requestTimeoutMs > 120_000) {
    throw new Error('muse-account MCP: baseUrl, absolute accountHome and requestTimeoutMs are required')
  }
  return {
    baseUrl: museGatewayOrigin(fields.baseUrl),
    accountHome: fields.accountHome,
    requestTimeoutMs,
  }
}

/** Only operations safe to expose to a model. */
export type MuseKbOperations = Pick<ReturnType<typeof createMuseKbReader>, 'search' | 'read' | 'readOpening'>

/** Keep tool failures independent of upstream response bodies and bearer values. */
async function kbResult(operation: () => Promise<MuseKbResult>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const result = await operation()
    return { content: result.content.map(block => ({ type: 'text', text: block.text })) }
  } catch (error) {
    const code = error instanceof MuseKbError ? error.code : 'kb-unavailable'
    return { content: [{ type: 'text', text: 'MUSE knowledge base: ' + code }], isError: true }
  }
}

/**
 * Register account status and authorized knowledge-base reads.
 * @param controller - Account identity reader shared with the Host service.
 * @param kb - Account-scoped KB operations that exchange a fresh bearer per call.
 * @returns A server with no credential-taking tool.
 */
export function createMuseAccountMcpServer(controller: Pick<MuseAccountController, 'status'>, kb: MuseKbOperations): McpServer {
  const server = new McpServer({ name: 'muse-account', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.registerTool('muse_account_status', {
    title: 'MUSE account status',
    description: 'Read the current MUSE account identity. Set verify=true to confirm the saved session with the gateway. No password or cookie is returned.',
    inputSchema: z.object({ verify: z.boolean().optional() }),
  }, async ({ verify }) => {
    try {
      const status = await controller.status(verify === undefined ? {} : { verify })
      const text = status.state === 'signed-out'
        ? 'No MUSE account is signed in.'
        : 'MUSE account: ' + status.username + '; ' + (status.verified ? 'gateway verified' : 'saved locally, not yet verified') + '.'
      return { content: [{ type: 'text', text }] }
    } catch {
      return { content: [{ type: 'text', text: 'MUSE account status is unavailable.' }], isError: true }
    }
  })
  server.registerTool('muse_kb_search', {
    title: 'Search MUSE knowledge base',
    description: 'Search account-authorized script sources and Wiki pages. Results show 类型 and 标定 plus an ID; use muse_kb_read for granted full text or muse_kb_read_opening for a 标定: viral-script opening. Search excerpts are not complete documents.',
    inputSchema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).optional() }),
  }, async ({ query, limit }) => await kbResult(() => kb.search(query, limit)))
  server.registerTool('muse_kb_read', {
    title: 'Read an authorized MUSE source or Wiki page',
    description: 'Read a 6000-character page of an account-authorized source or Wiki page by search result ID. Continue with the numeric 下一段起点 offset reported in the previous page until 后续正文未读 is 否.',
    inputSchema: z.object({ id: z.string().min(1).max(512), start: z.number().int().min(0).max(4194000).multipleOf(6000).optional() }),
  }, async ({ id, start }) => await kbResult(() => kb.read(id, start)))
  server.registerTool('muse_kb_read_opening', {
    title: 'Read an authorized blockbuster script opening',
    description: 'Read a 6000-character opening page of an account-authorized SRC source marked 标定: viral-script. Start may be 0, 6000, 12000, or 18000; read these pages before drafting in editing mode.',
    inputSchema: z.object({
      id: z.string().min(1).max(256),
      start: z.union([z.literal(0), z.literal(6000), z.literal(12000), z.literal(18000)]).optional(),
    }),
  }, async ({ id, start }) => await kbResult(() => kb.readOpening(id, start)))
  return server
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const config = parseMuseAccountLaunch(process.env.MUSE_ACCOUNT_CONFIG)
  const sessionFile = join(config.accountHome, 'session.json')
  const controller = new MuseAccountController({
    baseUrl: config.baseUrl,
    sessionFile,
    gateway: createMuseAccountGateway(config.baseUrl, config.requestTimeoutMs),
  })
  const kb = createMuseKbReader({ baseUrl: config.baseUrl, sessionFile, requestTimeoutMs: config.requestTimeoutMs })
  serveStdio(() => createMuseAccountMcpServer(controller, kb), {
    onerror: () => console.error('[muse-account] MCP request failed'),
  })
}
