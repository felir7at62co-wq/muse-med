/** Short-lived, audience-specific sign-in for Jingliu. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const audienceId = 'jingliu'
const token = () => randomBytes(32).toString('base64url')
const digest = value => createHash('sha256').update(value).digest()
const isToken = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(value)
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeUrl = url => url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
const browserPath = '/workbench-login'
const apiPrefix = '/api/workbench-login/'
const pendingMs = 10 * 60 * 1000
const grantMs = 60 * 1000
const capacity = 4096

/** Read confidential client registrations from an owner-only regular file, or leave sign-in disabled.
 * @param {string | undefined} path Absolute local configuration file.
 * @returns {Promise<object | undefined>} Client registrations keyed by audience.
 */
export async function loadWorkbenchClients(path) {
  if (path === undefined) return undefined
  if (!isAbsolute(path)) throw Error('MUSE_WORKBENCH_LOGIN_CONFIG must be an absolute private file')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = await file.stat()
    if (!st.isFile() || st.size > 8192 || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) {
      throw Error('Workbench sign-in configuration must be an owner-only regular file')
    }
    const json = await file.readFile('utf8')
    try { return JSON.parse(json) } catch (error) {
      if (error instanceof SyntaxError) throw Error('Invalid workbench configuration JSON')
      throw error
    }
  } finally {
    await file.close()
  }
}

function register(clients, issuer) {
  const services = new Map()
  if (clients === undefined) return services
  if (!URL.canParse(issuer) || new URL(issuer).origin !== issuer || !safeUrl(new URL(issuer)) || !isRecord(clients) || !Object.hasOwn(clients, audienceId)) {
    throw Error('Invalid workbench sign-in configuration')
  }
  const config = clients[audienceId]
  if (!isRecord(config) || Object.keys(config).some(k => !['callbackUri', 'serverSecret'].includes(k))
    || typeof config.serverSecret !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/.test(config.serverSecret)
    || typeof config.callbackUri !== 'string' || !URL.canParse(config.callbackUri)) throw Error('Invalid workbench client registration')
  const callback = new URL(config.callbackUri)
  if (!safeUrl(callback) || callback.href !== config.callbackUri || callback.username || callback.password
    || config.callbackUri.includes('?') || config.callbackUri.includes('#') || callback.pathname === '/') throw Error('Invalid workbench callback URI')
  services.set(audienceId, { callbackUri: callback.href, secretHash: digest(config.serverSecret) })
  return services
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return { error: 415 }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2048) return { error: 413 }
    chunks.push(chunk)
  }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (error) {
    if (error instanceof SyntaxError) return { error: 400 }
    throw error
  }
  return isRecord(value) ? { value } : { error: 400 }
}

/** Compose per-service workbench login against the account gateway's current account and session stores.
 * @param {object} options Gateway identity, browser UI, registered services and request handling.
 * @returns {Function} HTTP handler, returning true for an owned request.
 */
export function createWorkbenchLogin({ clients, publicOrigin, session, sessionStore, store, now, rate, form, reply, page, escape, cookieName }) {
  const services = register(clients, publicOrigin)
  const attempts = new Map()
  const grants = new Map()
  const returnCookie = cookieName + '-workbench-return'
  const cookie = (value, seconds) => returnCookie + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + seconds
  const authorizePath = id => browserPath + '?attempt=' + id
  function prune() {
    for (const map of [attempts, grants]) for (const [key, record] of map) if (record.expiry <= now()) map.delete(key)
  }
  function issue(s, audience, challenge) {
    if (grants.size >= capacity) return undefined
    const code = token()
    grants.set(digest(code).toString('hex'), { sessionToken: s.token, id: s.id, revision: s.revision, audience, challenge, expiry: now() + grantMs })
    return code
  }
  function json(res, status, data) {
    reply(res, status, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8' })
  }
  function screen(res, title, body, referrerPolicy = 'same-origin') {
    reply(res, 200, page(title, body, true), {
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': referrerPolicy,
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    })
  }
  async function browser(req, res, url) {
    const enrollment = req.method === 'GET'
    if (!enrollment && req.method !== 'POST') return reply(res, 405, '', { allow: 'GET, POST' })
    if (!enrollment && (req.headers.origin !== publicOrigin || url.search)) return reply(res, 403)
    const fields = enrollment ? url.searchParams : await form(req, 1024)
    const id = fields.get('attempt')
    const a = fields.getAll('attempt').length === 1 && attempts.get(id)
    if (!a || a.expiry <= now()) return reply(res, 410, '本次登录已过期，请返回工作台重试。')
    const s = session(req)
    const label = '镜流'
    if (!s) {
      if (!enrollment) return reply(res, 401)
      // A same-site navigation lets the browser present a preexisting Strict Muse cookie.
      if (!fields.has('signin')) {
        return screen(res, '使用 Muse 登录', '<h1>使用 Muse 登录</h1><p>打开' + label + '</p><a href="' + authorizePath(id) + '&amp;signin=1">继续</a>')
      }
      return reply(res, 303, '', { location: '/login', 'set-cookie': cookie(id, Math.ceil((a.expiry - now()) / 1000)) })
    }
    const service = services.get(a.audience)
    if (enrollment) {
      a.nonce = token()
      a.sessionToken = s.token
      const formBody = '<form action="' + browserPath + '" method="post"><input type="hidden" name="attempt" value="' + id +
        '"><input type="hidden" name="nonce" value="' + a.nonce + '"><button name="decision" value="approve">使用此账号登录</button>' +
        '<button name="decision" value="deny">取消</button></form>'
      return screen(res, '使用 Muse 登录', '<h1>登录' + label + '</h1><p>向' + label + '提供当前 Muse 账号标识与用户名 ' +
        escape(s.account.username) + '。</p>' + formBody)
    }
    if (a.sessionToken !== s.token || !isToken(fields.get('nonce')) || fields.get('nonce') !== a.nonce) return reply(res, 403)
    const decision = fields.get('decision')
    if (!['approve', 'deny'].includes(decision) || fields.getAll('decision').length !== 1) return reply(res, 400)
    const callback = new URL(service.callbackUri)
    callback.searchParams.set('state', a.state)
    if (decision === 'approve') {
      const code = issue(s, a.audience, a.challenge)
      if (!code) return reply(res, 429)
      callback.searchParams.set('code', code)
    } else callback.searchParams.set('error', 'access_denied')
    attempts.delete(id)
    // A fresh document lets the callback receive its Lax transaction cookie on a top-level GET.
    const href = escape(callback.href)
    return screen(res, '返回' + label, '<p><a href="' + href + '">返回' + label +
      '</a></p><meta http-equiv="refresh" content="0;url=' + href + '">', 'no-referrer')
  }
  async function api(req, res, url) {
    const op = url.pathname.slice(apiPrefix.length)
    if (!['start','redeem','grant'].includes(op)) return reply(res, 404)
    if (req.method !== 'POST') return reply(res, 405, '', { allow: 'POST' })
    if (url.search) return reply(res, 400)
    if (op === 'grant' ? req.headers.origin !== publicOrigin : req.headers.origin !== undefined) return reply(res, 403)
    if (!rate(req, 'workbench-login-' + op, 120)) return reply(res, 429)
    const { value, error } = await jsonBody(req)
    if (error) return reply(res, error)
    const keys = op === 'grant' ? ['audience', 'challenge'] : op === 'start' ? ['audience', 'challenge', 'state'] : ['audience', 'code', 'verifier']
    if (Object.keys(value).some(key => !keys.includes(key))) return reply(res, 400)
    const { audience, challenge, state, code, verifier } = value
    const service = services.get(audience)
    if (!service) return reply(res, 403)
    if (op !== 'grant') {
      const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9._~-]{32,256})$/)?.[1]
      if (!bearer || !timingSafeEqual(digest(bearer), service.secretHash)) return reply(res, 401)
    }
    if (op === 'redeem') {
      if (!isToken(code) || typeof verifier !== 'string' || !/^[a-zA-Z0-9._~-]{43,128}$/.test(verifier)) return reply(res, 400)
      const key = digest(code).toString('hex')
      const grant = grants.get(key)
      if (!grant || grant.audience !== audience || grant.expiry <= now() || digest(verifier).toString('base64url') !== grant.challenge) return reply(res, 410)
      grants.delete(key)
      const s = sessionStore.get(grant.sessionToken)
      const account = s && store.get(s.id)
      if (!s || s.id !== grant.id || s.expiry <= now() || !account || account.disabled || account.revision !== grant.revision || s.revision !== grant.revision) return reply(res, 410)
      return json(res, 200, { issuer: publicOrigin, sub: account.id, username: account.username })
    }
    if (!isToken(challenge)) return reply(res, 400)
    if (op === 'grant') {
      const s = session(req)
      if (!s) return reply(res, 401)
      const code = issue(s, audience, challenge)
      return code ? json(res, 200, { code, expiresIn: grantMs / 1000 }) : reply(res, 429)
    }
    if (!isToken(state)) return reply(res, 400)
    if (attempts.size >= capacity) return reply(res, 429)
    const id = token()
    attempts.set(id, { audience, challenge, state, expiry: now() + pendingMs })
    return json(res, 200, { authorizeUrl: publicOrigin + authorizePath(id) })
  }
  return async (req, res, path) => {
    if (path === '/' && req.method === 'GET' && services.size && !req.url.includes('?')) {
      const id = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith(returnCookie + '='))?.slice(returnCookie.length + 1)
      if (id && attempts.get(id)?.expiry > now() && session(req)) {
        reply(res, 303, '', { location: authorizePath(id), 'set-cookie': cookie('', 0) })
        return true
      }
      return false
    }
    if (path !== browserPath && !path.startsWith(apiPrefix)) return false
    if (!services.size) { reply(res, 404); return true }
    prune()
    const url = new URL(req.url, publicOrigin)
    if (path === browserPath) await browser(req, res, url)
    else await api(req, res, url)
    return true
  }
}
