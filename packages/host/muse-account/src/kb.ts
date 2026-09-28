/** Read-only MUSE knowledge-base bridge using a fresh account-derived bearer per call. */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { readMuseSession } from './session.ts'

/** Fixed failure categories; neither gateway bodies nor bearer values are exposed. */
export type MuseKbFailure = 'sign-in-required' | 'access-denied' | 'kb-unavailable' | 'kb-rejected'

/** Knowledge-base failure without credential-bearing cause text. */
export class MuseKbError extends Error {
  constructor(readonly code: MuseKbFailure) {
    super(`MUSE knowledge base: ${code}`)
    this.name = 'MuseKbError'
  }
}

/** Text-only MCP result admitted to the model through the local server. */
export interface MuseKbResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly isError?: boolean
}

/** One authorized remote MCP call; the token exists only for this invocation. */
export type MuseKbToolCaller = (
  url: string,
  token: string,
  name: 'search' | 'read' | 'read_opening',
  args: Record<string, unknown>,
  requestTimeoutMs: number,
) => Promise<MuseKbResult>

/** Product-home session and injectable network adapters. */
export interface MuseKbReaderOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly requestTimeoutMs: number
  readonly fetcher?: typeof fetch
  readonly callTool?: MuseKbToolCaller
}

/** Only opening-page offsets the knowledge base permits. */
const OPENING_STARTS = new Set([0, 6_000, 12_000, 18_000])
const MAX_TEXT_BYTES = 131_072

/**
 * Call one read-only remote MCP tool, closing the connection after the result.
 * @param url - Access endpoint's validated MCP URL.
 * @param token - Short-lived bearer issued for the current account session.
 * @param name - Allowed remote tool.
 * @param args - Tool arguments.
 * @param requestTimeoutMs - Validated product request timeout.
 * @returns Text blocks from the remote response.
 */
export const callMuseKbTool: MuseKbToolCaller = async (url, token, name, args, requestTimeoutMs) => {
  const signal = AbortSignal.timeout(requestTimeoutMs)
  const client = new Client({ name: 'muse-account-kb', version: '0.1.0' }, {
    capabilities: {},
    versionNegotiation: { mode: 'auto' },
  })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
    }), { signal })
    const result = await client.callTool({ name, arguments: args }, { signal })
    if (result.isError === true) throw new MuseKbError('kb-rejected')
    if (!Array.isArray(result.content)) {
      throw new MuseKbError('kb-rejected')
    }
    return { content: result.content.map((block) => {
      if (block.type !== 'text') throw new MuseKbError('kb-rejected')
      return { type: 'text', text: block.text }
    }) }
  } catch (error) {
    if (error instanceof MuseKbError) throw error
    throw new MuseKbError('kb-unavailable')
  } finally {
    await client.close().catch(() => {})
  }
}

/**
 * Accept only an HTTPS MCP endpoint with the server's specified path.
 * Local HTTP is permitted solely for an explicit loopback gateway fixture.
 * @param raw - URL returned by account-bound access exchange.
 * @returns Validated URL string.
 */
function kbMcpUrl(raw: string, gatewayOrigin: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new MuseKbError('kb-rejected')
  }
  if (url.origin !== gatewayOrigin
    || url.username !== '' || url.password !== '' || url.pathname !== '/api/kb/mcp'
    || url.search !== '' || url.hash !== '') {
    throw new MuseKbError('kb-rejected')
  }
  return url.toString()
}

/**
 * Create account-scoped knowledge-base reads. Every call exchanges the current
 * cookie for a short-lived bearer and discards it after the remote MCP call.
 * @param options - Gateway, session and network adapters.
 * @returns Search, authorized full-text pages, and opening-page operations.
 */
export function createMuseKbReader(options: MuseKbReaderOptions): {
  search(query: string, limit?: number): Promise<MuseKbResult>
  read(id: string, start?: number): Promise<MuseKbResult>
  readOpening(id: string, start?: number): Promise<MuseKbResult>
} {
  const fetcher = options.fetcher ?? fetch
  const callTool = options.callTool ?? callMuseKbTool

  async function invoke(name: 'search' | 'read' | 'read_opening', args: Record<string, unknown>): Promise<MuseKbResult> {
    const session = await readMuseSession(options.sessionFile, options.baseUrl)
    if (session === null) throw new MuseKbError('sign-in-required')
    let response: Response
    try {
      response = await fetcher(new URL('/api/kb/access', options.baseUrl), {
        method: 'POST',
        headers: { cookie: session.cookie, origin: options.baseUrl },
        redirect: 'manual',
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      })
    } catch {
      throw new MuseKbError('kb-unavailable')
    }
    if (response.status === 401) throw new MuseKbError('sign-in-required')
    if (response.status === 403) throw new MuseKbError('access-denied')
    if (response.status === 503) throw new MuseKbError('kb-unavailable')
    if (!response.ok) throw new MuseKbError('kb-rejected')
    let access: unknown
    try {
      access = await response.json()
    } catch {
      throw new MuseKbError('kb-rejected')
    }
    if (typeof access !== 'object' || access === null || Array.isArray(access)) throw new MuseKbError('kb-rejected')
    const fields = access as Record<string, unknown>
    if (typeof fields.url !== 'string' || typeof fields.token !== 'string' || fields.token.length === 0
      || fields.token.length > 4096 || typeof fields.expiresAt !== 'number'
      || !Number.isSafeInteger(fields.expiresAt) || fields.expiresAt <= Date.now()) {
      throw new MuseKbError('kb-rejected')
    }
    const url = kbMcpUrl(fields.url, options.baseUrl)
    const result = await callTool(url, fields.token, name, args, options.requestTimeoutMs)
    if (result.isError === true || result.content.some(block => block.type !== 'text')) throw new MuseKbError('kb-rejected')
    const text = result.content.map(block => block.text).join('')
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES || text.includes(fields.token)) throw new MuseKbError('kb-rejected')
    return { content: result.content.map(block => ({ type: 'text', text: block.text })) }
  }

  return {
    async search(query, limit) {
      if (typeof query !== 'string' || query.trim().length === 0 || query.length > 200
        || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 20))) {
        throw new MuseKbError('kb-rejected')
      }
      return await invoke('search', { query, ...(limit === undefined ? {} : { limit }) })
    },
    async read(id, start) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 512
        || (start !== undefined && (!Number.isSafeInteger(start) || start < 0 || start > 4_194_000 || start % 6_000 !== 0))) {
        throw new MuseKbError('kb-rejected')
      }
      return await invoke('read', { id, ...(start === undefined ? {} : { start }) })
    },
    async readOpening(id, start) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 256
        || (start !== undefined && !OPENING_STARTS.has(start))) throw new MuseKbError('kb-rejected')
      return await invoke('read_opening', { id, ...(start === undefined ? {} : { start }) })
    },
  }
}
