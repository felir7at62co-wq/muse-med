/** Transport and typed calls for the Jubian drama resource site. */
import { prepareDownloadTarget, saveDownload } from './workspace-download.js'

// The observed browser entry is display-only. An operator must configure the secure API root.
const BROWSER_ORIGIN = 'http://drama-web.jubianai.net'
const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 600_000

function httpsUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 16_384 || !value.isWellFormed() || /[\\\s#]/u.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url : null
  } catch { return null }
}

/** Convert an explicitly configured, credential-free HTTPS API root to its canonical form. */
export function secureApiRoot(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const url = httpsUrl(text)
  if (!url || text.includes('?') || (url.pathname !== '/api/v1' && url.pathname !== '/api/v1/')) return null
  return url.origin + '/api/v1'
}

function mediaOrigins(input, baseUrl) {
  if (input !== undefined && !Array.isArray(input)) return null
  const origins = new Set(baseUrl === null ? [] : [new URL(baseUrl).origin])
  for (const value of input ?? []) {
    const url = httpsUrl(value)
    if (!url || value.includes('?') || url.pathname !== '/') return null
    origins.add(url.origin)
  }
  return origins
}

function callSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function readJson(response, path) {
  const reader = response.body?.getReader()
  if (!reader) return null
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_JSON_BYTES) throw new DramaWebError('Drama Web response exceeded the JSON byte limit', { path })
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (!text.trim()) return null
  try { return JSON.parse(text) }
  catch { throw new DramaWebError('Drama Web returned an invalid JSON response', { path }) }
}

/** Paths the read tools may reach. Anything else is refused before a request leaves. */
export const READ_PREFIXES = [
  '/dramas',
  '/files/',
  '/users',
  '/languages',
  '/pan/',
  '/subtitle-erase/',
  '/dashboard/',
  '/cost-board/',
  '/auth/me',
]

/** Resource categories the drama file endpoint accepts, as published by the web client. */
export const RESOURCE_TYPES = [
  'final',
  'final_watermark',
  'final_subtitled',
  'final_no_subtitle',
  'subtitle',
  'lead',
  'poster',
  'asset',
  'highlight',
  'highlight_moment',
  'script',
  'ai_project',
  'edit_project',
  'rights_letter',
  'jimeng_agreement',
]

/** One rejected call; `status` keeps the upstream HTTP code and never invents a reason. */
export class DramaWebError extends Error {
  /**
   * @param {string} message - Operator-facing text.
   * @param {{status?: number, path?: string}} detail - Upstream facts.
   */
  constructor(message, detail = {}) {
    super(message)
    this.name = 'DramaWebError'
    this.status = detail.status ?? null
    this.path = detail.path ?? null
  }
}

/**
 * Remove the paste artifacts a token may carry without rewriting the token itself.
 * @param {unknown} raw - Stored or pasted value.
 * @returns {string} The repaired value, possibly empty.
 */
export function normalizeBearer(raw) {
  let value = String(raw ?? '').trim()
  if (value.endsWith(';') || value.endsWith('&')) value = value.slice(0, -1).trim()
  const first = value[0]
  if (value.length >= 2 && (first === '"' || first === '\'') && value.at(-1) === first) value = value.slice(1, -1).trim()
  return /\s/.test(value) ? '' : value
}

/**
 * Decode a JWT payload without verifying it; only used to report role/team/expiry.
 * @param {string} token - Compact JWS.
 * @returns {Record<string, unknown> | null} Claims, or null when the shape is unexpected.
 */
export function readTokenClaims(token) {
  const segment = String(token ?? '').split('.')[1]
  if (!segment) return null
  try {
    const json = Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? parsed : null
  }
  catch {
    return null
  }
}

/** Client bound to one deployment; holds the session token in memory only. */
export class DramaWebClient {
  #allowedMediaOrigins

  /**
   * @param {Record<string, any>} config - Plugin config (`baseUrl`, `tokenEnv`, `timeoutMs`).
   * @param {{fetch?: typeof fetch}} deps - Test transport seam.
   */
  constructor(config = {}, deps = {}) {
    const baseUrl = secureApiRoot(config.baseUrl)
    this.config = {
      baseUrl,
      tokenEnv: typeof config.tokenEnv === 'string' && config.tokenEnv ? config.tokenEnv : 'DRAMA_WEB_TOKEN',
      usernameEnv: typeof config.usernameEnv === 'string' && config.usernameEnv ? config.usernameEnv : 'DRAMA_WEB_USERNAME',
      passwordEnv: typeof config.passwordEnv === 'string' && config.passwordEnv ? config.passwordEnv : 'DRAMA_WEB_PASSWORD',
      timeoutMs: Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0 && config.timeoutMs <= DOWNLOAD_TIMEOUT_MS
        ? config.timeoutMs : 30_000,
    }
    this.#allowedMediaOrigins = mediaOrigins(config.allowedMediaOrigins, baseUrl)
    this.fetch = deps.fetch ?? globalThis.fetch
    this.session = { token: '' }
  }

  /** The token this client will send: the in-memory session first, then the configured variable. */
  token() {
    return this.session.token || normalizeBearer(process.env[this.config.tokenEnv])
  }

  /** The observed browser origin is never used as an API transport. */
  get siteRoot() { return BROWSER_ORIGIN }

  /**
   * One bounded JSON call through the shared envelope.
   * @param {string} path - Absolute API path beginning with `/`.
   * @param {{method?: string, query?: Record<string, unknown>, body?: unknown, form?: Record<string, string>, signal?: AbortSignal, timeoutMs?: number, noAuth?: boolean}} [options]
   * @returns {Promise<any>} Parsed JSON body.
   */
  async request(path, options = {}) {
    const method = options.method ?? (options.form || options.body !== undefined ? 'POST' : 'GET')
    const baseUrl = secureApiRoot(this.config.baseUrl)
    if (!baseUrl) throw new DramaWebError('Configure an approved HTTPS Drama Web API root ending in /api/v1')
    if (typeof path !== 'string' || !path.startsWith('/') || /[\\\s?#]/u.test(path)) {
      throw new DramaWebError('Invalid Drama Web API path')
    }
    const url = new URL(baseUrl + path)
    if (url.pathname !== '/api/v1' + path) throw new DramaWebError('Invalid Drama Web API path')
    if (method === 'GET') this.assertReadable(path)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    const headers = { accept: 'application/json' }
    if (!options.noAuth) {
      const token = this.token()
      if (!token) throw new DramaWebError('Drama Web credentials are missing')
      headers.authorization = 'Bearer ' + token
    }
    let body
    if (options.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(options.form).toString()
    }
    else if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
    const signal = callSignal(options.signal, options.timeoutMs ?? this.config.timeoutMs)
    let response
    try { response = await this.fetch(url, { method, headers, body, credentials: 'omit', redirect: 'error', signal }) }
    catch {
      signal.throwIfAborted()
      throw new DramaWebError('Drama Web HTTPS request failed', { path })
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new DramaWebError('Drama Web rejected ' + path + ': HTTP ' + response.status, { status: response.status, path })
    }
    return await readJson(response, path)
  }

  /** Refuse a read outside the documented surface. */
  assertReadable(path) {
    if (!READ_PREFIXES.some(prefix => path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/') || path === prefix)) {
      throw new DramaWebError('Path is outside the Drama Web read allowlist')
    }
  }

  /**
   * Exchange credentials for a bearer token and keep it in memory.
   * @param {{username: string, password: string}} credentials - Operator credentials.
   * @param {AbortSignal} [signal] - Caller cancellation.
   * @returns {Promise<{token: string, mustChangePassword: boolean, claims: Record<string, unknown> | null}>}
   */
  async login({ username, password }, signal) {
    const body = await this.request('/auth/login', { form: { username, password }, noAuth: true, signal })
    const token = normalizeBearer(body?.access_token ?? body?.accessToken ?? '')
    if (!token) throw new DramaWebError('Drama Web login answered without an access token')
    this.session.token = token
    return {
      token,
      mustChangePassword: body?.must_change_password === true || body?.mustChangePassword === true,
      claims: readTokenClaims(token),
    }
  }

  /** Read the signed-in account. */
  async me(signal) {
    this.assertReadable('/auth/me')
    return this.request('/auth/me', { signal })
  }

  /**
   * Search the drama library.
   * @param {Record<string, unknown>} params - `keyword,status,market,push_status,created_from,created_to,only_group,leader_id,page,page_size`.
   * @param {AbortSignal} [signal] - Caller cancellation.
   */
  async listDramas(params = {}, signal) {
    this.assertReadable('/dramas')
    return this.request('/dramas', { query: params, signal })
  }

  /** Read one drama profile. */
  async getDrama(dramaId, signal) {
    this.assertReadable(`/dramas/${dramaId}`)
    return this.request(`/dramas/${dramaId}`, { signal })
  }

  /** Read the sibling dramas that share this production. */
  async siblings(dramaId, signal) {
    this.assertReadable(`/dramas/${dramaId}/siblings`)
    return this.request(`/dramas/${dramaId}/siblings`, { signal })
  }

  /** List a drama's resources, optionally filtered by category and variant. */
  async listFiles(dramaId, { resourceType, variant } = {}, signal) {
    this.assertReadable(`/dramas/${dramaId}/files`)
    return this.request(`/dramas/${dramaId}/files`, { query: { resource_type: resourceType, variant }, signal })
  }

  /** Ask for a signed download URL for one file id. */
  async fileUrl(fileId, disposition = 'attachment', signal) {
    this.assertReadable(`/files/${fileId}/url`)
    return this.request(`/files/${fileId}/url`, { query: { disposition }, signal })
  }

  /**
   * Resolve the file's signed URL, then publish bounded bytes inside the initiating workspace.
   * @param {number|string} fileId - File id from the resource inventory.
   * @param {string} outputPath - Workspace-relative destination path.
   * @param {{workspaceRoot: string, workspaceCwd: string, signal?: AbortSignal, disposition?: string}} options - Authorized workspace and cancellation.
   * @returns {Promise<{path: string, bytes: number, sha256: string}>} Local receipt without the signed URL.
   */
  async download(fileId, outputPath, { workspaceRoot, workspaceCwd, signal, disposition = 'attachment' } = {}) {
    const deadline = callSignal(signal, DOWNLOAD_TIMEOUT_MS)
    const target = await prepareDownloadTarget(workspaceRoot, workspaceCwd, outputPath, deadline)
    if (!this.#allowedMediaOrigins?.size) throw new DramaWebError('Configure trusted HTTPS Drama Web media origins')
    const signed = await this.fileUrl(fileId, disposition, deadline)
    const url = httpsUrl(signed?.url ?? signed?.download_url ?? signed?.data?.url)
    if (!url || !this.#allowedMediaOrigins.has(url.origin)) {
      throw new DramaWebError('Download address is outside the trusted HTTPS media origins')
    }
    let response
    try {
      response = await this.fetch(url, { headers: { 'accept-encoding': 'identity' },
        credentials: 'omit', redirect: 'error', signal: deadline })
    } catch {
      deadline.throwIfAborted()
      throw new DramaWebError('Drama Web HTTPS media request failed')
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {})
      throw new DramaWebError('Download failed: HTTP ' + response.status, { status: response.status })
    }
    return await saveDownload(response, target, MAX_DOWNLOAD_BYTES, deadline)
  }

  /** Create one pan-share request; the server accepts it and generates asynchronously. */
  async createPanShare(dramaId, body, signal) {
    return this.request(`/dramas/${dramaId}/pan-share`, { body, signal })
  }

  /** List the shares already generated for a drama. */
  async listPanShares(dramaId, signal) {
    this.assertReadable(`/dramas/${dramaId}/pan-share`)
    return this.request(`/dramas/${dramaId}/pan-share`, { signal })
  }

  /** List pan-share generation tasks. */
  async panShareTasks(dramaId, signal) {
    this.assertReadable(`/dramas/${dramaId}/pan-share/tasks`)
    return this.request(`/dramas/${dramaId}/pan-share/tasks`, { signal })
  }

  /** List subtitle-erasure tasks for a drama. */
  async subtitleEraseTasks(dramaId, signal) {
    this.assertReadable(`/dramas/${dramaId}/subtitle-erase-tasks`)
    return this.request(`/dramas/${dramaId}/subtitle-erase-tasks`, { signal })
  }

  /** Whether the deployment has subtitle erasure switched on. */
  async subtitleEraseEnabled(signal) {
    return this.request('/subtitle-erase/enabled', { signal })
  }

  /** Submit one subtitle-erasure task with an explicit picture region. */
  async createSubtitleEraseTask(dramaId, body, signal) {
    return this.request(`/dramas/${dramaId}/subtitle-erase-tasks`, { body, signal, timeoutMs: 60_000 })
  }

  /** Ask the server-side model for a drama title; the web client allows 320s for this. */
  async generateTitle(dramaId, signal) {
    return this.request(`/dramas/${dramaId}/generate-title`, { method: 'POST', signal, timeoutMs: 330_000 })
  }

  /** Ask the server-side model to analyse the drama script; same 320s budget upstream. */
  async analyzeScript(dramaId, signal) {
    return this.request(`/dramas/${dramaId}/analyze-script`, { method: 'POST', signal, timeoutMs: 330_000 })
  }

  /** Build the browser URL for a drama so results can be checked by a person. */
  mintUrl(dramaId) {
    return this.siteRoot + '/#/dramas/' + encodeURIComponent(dramaId)
  }
}
