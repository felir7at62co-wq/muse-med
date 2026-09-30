/** MUSE knowledge-base bridge using a fresh account-derived bearer per call. */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { readMuseSession } from './session.ts'

/** Fixed failure categories; neither gateway bodies nor bearer values are exposed. */
export type MuseKbFailure = 'sign-in-required' | 'access-denied' | 'kb-unavailable' | 'kb-rejected'
  | 'wiki-revision-conflict' | 'wiki-write-busy' | 'wiki-invalid-citation' | 'wiki-unresolved-link'

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

/** Remote knowledge-base operations available to the signed-in desktop account. */
export type MuseKbToolName = 'search' | 'read' | 'read_opening' | 'ingest_script'
  | 'wiki_capture_source' | 'wiki_directory' | 'wiki_search' | 'wiki_read' | 'wiki_write_page'
  | 'wiki_history' | 'wiki_links' | 'wiki_status' | 'wiki_migration_preview'

/** Wiki selection; project scope requires an account-local project_id. */
export interface MuseWikiScopeRequest {
  readonly scope?: 'private' | 'project' | 'shared' | undefined
  readonly project_id?: string | undefined
}

/** Immutable original capture, separate from knowledge-page synthesis. */
export interface MuseWikiCaptureRequest extends MuseWikiScopeRequest {
  readonly title: string
  readonly text: string
  readonly source: string
}

/** Bounded Wiki directory traversal with optional page-folder selection. */
export interface MuseWikiDirectoryRequest extends MuseWikiScopeRequest {
  readonly folder?: string | undefined
  readonly start?: number | undefined
  readonly limit?: number | undefined
}

/** Full-text keyword retrieval in the selected knowledge scope. */
export interface MuseWikiSearchRequest extends MuseWikiScopeRequest {
  readonly query: string
  readonly limit?: number | undefined
}

/** Scoped source or page identifier returned by Wiki navigation. */
export interface MuseWikiIdRequest extends MuseWikiScopeRequest {
  readonly id: string
}

/** Character-page read with an optional historical page revision. */
export interface MuseWikiReadRequest extends MuseWikiIdRequest {
  readonly start?: number | undefined
  readonly revision?: number | undefined
}

/** Original-source citation with an exclusive Unicode character-range end. */
export interface MuseWikiCitation {
  readonly id: string
  readonly start: number
  readonly end: number
}

/** Cited page write using the current revision, or zero for a new page. */
export interface MuseWikiWriteRequest extends MuseWikiScopeRequest {
  readonly page_id: string
  readonly title: string
  readonly text: string
  readonly expected_revision: number
  readonly citations: readonly MuseWikiCitation[]
}

/** Revision-history pagination for a scoped Wiki page. */
export interface MuseWikiHistoryRequest extends MuseWikiIdRequest {
  readonly start?: number | undefined
  readonly limit?: number | undefined
}

/** Account-authorized Wiki capture, synthesis, and navigation. */
export interface MuseWikiOperations {
  /**
   * Capture an immutable original and create its pending source page.
   * @param args - Scope, title, original Markdown, and relative source ID.
   * @returns Original ID, digest, duplicate status, and pending page metadata.
   */
  wikiCaptureSource(args: MuseWikiCaptureRequest): Promise<MuseKbResult>
  /**
   * Browse the selected Wiki directory.
   * @param args - Scope, folder, and list pagination.
   * @returns Source and page IDs, revisions, and continuation offset.
   */
  wikiDirectory(args?: MuseWikiDirectoryRequest): Promise<MuseKbResult>
  /**
   * Search full authorized text in one Wiki scope.
   * @param args - Scope, keyword query, and result limit.
   * @returns Matching excerpts and readable IDs.
   */
  wikiSearch(args: MuseWikiSearchRequest): Promise<MuseKbResult>
  /**
   * Read a source or page, including an authorized historical revision.
   * @param args - Scope, ID, character offset, and optional revision.
   * @returns A bounded text page, citations, and next character offset.
   */
  wikiRead(args: MuseWikiReadRequest): Promise<MuseKbResult>
  /**
   * Save synthesized Markdown with original citations and revision comparison.
   * @param args - Scope, page content, expected revision, and original character ranges.
   * @returns Committed page metadata or a fixed failure category.
   */
  wikiWritePage(args: MuseWikiWriteRequest): Promise<MuseKbResult>
  /**
   * List a page's authorized immutable revisions.
   * @param args - Scope, page ID, and history pagination.
   * @returns Revision metadata and continuation offset.
   */
  wikiHistory(args: MuseWikiHistoryRequest): Promise<MuseKbResult>
  /**
   * Inspect a page's links, backlinks, and original citations.
   * @param args - Scope and page ID.
   * @returns Bounded navigation metadata, including unresolved links.
   */
  wikiLinks(args: MuseWikiIdRequest): Promise<MuseKbResult>
  /**
   * Read account Wiki counts and the active retrieval method.
   * @param args - Optional project scope for project-specific counts.
   * @returns Private, project, and authorized shared inventory status.
   */
  wikiStatus(args?: MuseWikiScopeRequest): Promise<MuseKbResult>
  /**
   * Preview existing originals and pages without modifying data or grants.
   * @param args - Knowledge scope to inspect.
   * @returns Legacy and missing-source-page counts with bounded source IDs.
   */
  wikiMigrationPreview(args?: MuseWikiScopeRequest): Promise<MuseKbResult>
}

/** One authorized remote MCP call; the token exists only for this invocation. */
export type MuseKbToolCaller = (
  url: string,
  token: string,
  name: MuseKbToolName,
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
const MAX_WIKI_TEXT_BYTES = 4 * 1024 * 1024

/** One reviewed episode or chapter of a transcription-derived Markdown script. */
export interface MuseKbScriptSection {
  readonly title: string
  readonly text: string
  readonly source: string
  readonly reviewed: true
}

/** Classify only bounded Wiki domain errors; upstream text is never returned. */
function wikiFailure(text: string, token: string): MuseKbFailure {
  if (Buffer.byteLength(text, 'utf8') > 2048 || text.includes(token)) return 'kb-rejected'
  if (/^Revision conflict: expected \d{1,16}, current \d{1,16}; read the page and merge before retrying\.$/u.test(text)) {
    return 'wiki-revision-conflict'
  }
  if (text === 'Wiki is busy; reload the page before retrying. An abandoned lock requires administrator inspection.') {
    return 'wiki-write-busy'
  }
  if (text === 'Invalid source citation'
    || text === 'Citation must reference a readable original and valid character range.'
    || text === 'Source pages must cite their own immutable packet.') return 'wiki-invalid-citation'
  if (/^Wiki link is (?:missing|ambiguous|invalid): [^\r\n]+; use a directory-qualified existing page ID\.$/u.test(text)) {
    return 'wiki-unresolved-link'
  }
  if (text === 'Shared Wiki writes require an administrator account.'
    || text === 'Existing shared page updates require a current full-read grant.'
    || text === 'Shared page updates require an existing full-read administrator grant.'
    || text === 'Document does not exist or is not authorized.'
    || text === 'Revision does not exist or is not authorized.') return 'access-denied'
  if (text === 'Account login is required for private and project Wiki.') return 'sign-in-required'
  if (text === 'Account Wiki is not configured.') return 'kb-unavailable'
  return 'kb-rejected'
}

/**
 * Call one remote MCP tool, closing the connection after the result.
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
    if (result.isError === true) {
      const block = result.content.length === 1 ? result.content[0] : undefined
      throw new MuseKbError(name.startsWith('wiki_') && block?.type === 'text'
        ? wikiFailure(block.text, token) : 'kb-rejected')
    }
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
 * @returns Legacy source operations and all nine scoped Wiki operations.
 */
export function createMuseKbReader(options: MuseKbReaderOptions): {
  search(query: string, limit?: number): Promise<MuseKbResult>
  read(id: string, start?: number): Promise<MuseKbResult>
  readOpening(id: string, start?: number): Promise<MuseKbResult>
  ingestScript(items: readonly MuseKbScriptSection[]): Promise<MuseKbResult>
} & MuseWikiOperations {
  const fetcher = options.fetcher ?? fetch
  const callTool = options.callTool ?? callMuseKbTool

  async function invoke(name: MuseKbToolName, args: Record<string, unknown>): Promise<MuseKbResult> {
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
    if (result.isError === true) throw new MuseKbError('kb-rejected')
    const text = result.content.map(block => block.text).join('')
    const maxBytes = name.startsWith('wiki_') ? MAX_WIKI_TEXT_BYTES : MAX_TEXT_BYTES
    if (Buffer.byteLength(text, 'utf8') > maxBytes || text.includes(fields.token)) throw new MuseKbError('kb-rejected')
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
    async ingestScript(items) {
      if (items.length < 1 || items.length > 12
        || Buffer.byteLength(JSON.stringify({ items }), 'utf8') > 2_000_000) throw new MuseKbError('kb-rejected')
      return await invoke('ingest_script', { items })
    },
    async wikiCaptureSource(args) { return await invoke('wiki_capture_source', { ...args }) },
    async wikiDirectory(args = {}) { return await invoke('wiki_directory', { ...args }) },
    async wikiSearch(args) { return await invoke('wiki_search', { ...args }) },
    async wikiRead(args) { return await invoke('wiki_read', { ...args }) },
    async wikiWritePage(args) { return await invoke('wiki_write_page', { ...args }) },
    async wikiHistory(args) { return await invoke('wiki_history', { ...args }) },
    async wikiLinks(args) { return await invoke('wiki_links', { ...args }) },
    async wikiStatus(args = {}) { return await invoke('wiki_status', { ...args }) },
    async wikiMigrationPreview(args = {}) { return await invoke('wiki_migration_preview', { ...args }) },
  }
}
