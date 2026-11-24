/**
 * Transport and typed calls for the Jubian drama resource site ("剧壳资源管理系统").
 *
 * Verified against the shipped SPA bundle (`/assets/index-BhA9aCLQ.js` and its 21
 * chunks): axios `baseURL: "/api/v1"`, bearer token from `localStorage.drama_token`,
 * `POST /auth/login` is form-urlencoded, unauthenticated calls answer HTTP 401 with an
 * empty body, and no request signing exists.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Default API root; the host may override it for a staging or mirrored deployment. */
export const DEFAULT_BASE_URL = 'http://drama-web.jubianai.net/api/v1'

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
   * @param {{status?: number, body?: unknown, path?: string}} detail - Upstream facts.
   */
  constructor(message, detail = {}) {
    super(message)
    this.name = 'DramaWebError'
    this.status = detail.status ?? null
    this.body = detail.body ?? null
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
  /**
   * @param {Record<string, any>} config - Plugin config (`baseUrl`, `tokenEnv`, `timeoutMs`).
   * @param {{fetch?: typeof fetch, now?: () => number}} deps - Test seams.
   */
  constructor(config = {}, deps = {}) {
    this.config = {
      baseUrl: typeof config.baseUrl === 'string' && config.baseUrl ? config.baseUrl.replace(/\/+$/, '') : DEFAULT_BASE_URL,
      tokenEnv: typeof config.tokenEnv === 'string' && config.tokenEnv ? config.tokenEnv : 'DRAMA_WEB_TOKEN',
      usernameEnv: typeof config.usernameEnv === 'string' && config.usernameEnv ? config.usernameEnv : 'DRAMA_WEB_USERNAME',
      passwordEnv: typeof config.passwordEnv === 'string' && config.passwordEnv ? config.passwordEnv : 'DRAMA_WEB_PASSWORD',
      timeoutMs: Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 30_000,
    }
    this.fetch = deps.fetch ?? globalThis.fetch
    this.now = deps.now ?? Date.now
    this.session = { token: '' }
  }

  /** The token this client will send: the in-memory session first, then the configured variable. */
  token() {
    return this.session.token || normalizeBearer(process.env[this.config.tokenEnv])
  }

  /** Operator-facing deployment root, used when rendering links back to the user. */
  get siteRoot() {
    return this.config.baseUrl.replace(/\/api\/v1\/?$/, '')
  }

  /**
   * One bounded JSON call through the shared envelope.
   * @param {string} path - Absolute API path beginning with `/`.
   * @param {{method?: string, query?: Record<string, unknown>, body?: unknown, form?: Record<string, string>, signal?: AbortSignal, timeoutMs?: number, noAuth?: boolean}} [options]
   * @returns {Promise<any>} Parsed JSON body.
   */
  async request(path, options = {}) {
    const method = options.method ?? (options.form || options.body !== undefined ? 'POST' : 'GET')
    if (method === 'GET' && !options.noGuard) this.assertReadable(path)
    const url = new URL(`${this.config.baseUrl}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    const headers = { accept: 'application/json' }
    const token = options.noAuth ? '' : this.token()
    if (token) headers.authorization = `Bearer ${token}`
    let body
    if (options.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(options.form).toString()
    }
    else if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs)
    const response = await this.fetch(url, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers, body, redirect: 'error', signal })
    const text = await response.text()
    let parsed = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      }
      catch {
        parsed = text
      }
    }
    if (!response.ok) {
      const detail = text ? ` ${text.slice(0, 200)}` : ' (empty body)'
      throw new DramaWebError(`drama-web rejected ${path}: HTTP ${response.status}${detail}`, { status: response.status, body: parsed, path })
    }
    return parsed
  }

  /** Refuse a read outside the documented surface. */
  assertReadable(path) {
    if (!READ_PREFIXES.some(prefix => path.startsWith(prefix))) {
      throw new DramaWebError(`path is outside the read allowlist: ${path}`, { path })
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
    if (!token) throw new DramaWebError('login answered without an access token', { body })
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
   * Resolve one file's signed URL, download it and prove the bytes on disk.
   * @param {number|string} fileId - File id from {@link listFiles}.
   * @param {string} targetPath - Absolute destination path.
   * @param {{signal?: AbortSignal, disposition?: string}} [options] - Cancellation and content disposition.
   * @returns {Promise<{path: string, bytes: number, sha256: string, url: string}>}
   */
  async download(fileId, targetPath, { signal, disposition = 'attachment' } = {}) {
    const signed = await this.fileUrl(fileId, disposition, signal)
    const url = signed?.url ?? signed?.download_url ?? signed?.data?.url
    if (!url) throw new DramaWebError('file url response carried no download address', { body: signed })
    const response = await this.fetch(url, { signal, redirect: 'error' })
    if (!response.ok) throw new DramaWebError(`download failed: HTTP ${response.status}`, { status: response.status })
    const buffer = Buffer.from(await response.arrayBuffer())
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, buffer)
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    return { path: targetPath, bytes: buffer.length, sha256, url }
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
    return `${this.siteRoot}/#/dramas/${dramaId}`
  }
}
