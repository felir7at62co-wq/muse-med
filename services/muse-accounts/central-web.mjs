/** Owner-only gateway for the existing Central Muse Web host. */
import { createServer, request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { pathToFileURL } from 'node:url'

const mount = '/central'
const cookieName = '__Host-muse'
const loginPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>中央 Muse</title><style>body{color-scheme:light dark;font:16px system-ui;max-width:26rem;margin:12vh auto;padding:0 1.25rem}form,label{display:grid;gap:.5rem}form{gap:1rem;margin-top:2rem}input,button{font:inherit;padding:.55rem}</style><h1>中央 Muse</h1><p><a href="/login" target="_blank" rel="noopener">用飞书登录</a>，完成后<a href="/central/">返回中央 Muse</a>。</p><form method="post" action="/central/login"><label>管理员账号<input name="username" required autocomplete="username"></label><label>密码<input name="password" type="password" required autocomplete="current-password"></label><button>登录中央 Muse</button></form></html>`

function respond(res, status, text = '', headers = {}) {
  if (res.destroyed) return
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(text)
}

function accountCookie(req) {
  const tokens = (req.headers.cookie ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(cookieName + '='))
  return tokens.length === 1 && /^__Host-muse=[a-zA-Z0-9_-]+$/.test(tokens[0]) ? tokens[0] : ''
}

function forwardHeaders(req, target, cookie, origin, upgrade = false) {
  const headers = { ...req.headers }
  const connectionFields = (headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())
  for (const key of Object.keys(headers)) {
    if (connectionFields.includes(key) || /^(?:authorization|connection|cookie|forwarded|host|keep-alive|origin|proxy-.*|referer|te|trailer|transfer-encoding|upgrade|x-forwarded-.*|x-real-ip|x-muse-.*|x-account-id)$/.test(key)) {
      delete headers[key]
    }
  }
  headers.host = target.host
  if (cookie) headers.cookie = cookie
  if (req.headers.origin || upgrade) headers.origin = origin
  if (upgrade) {
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'
  }
  return headers
}

function responseHeaders(headers, backend, path) {
  const result = { ...headers }
  for (const key of Object.keys(result)) {
    if (/^(?:access-control-.*|clear-site-data|connection|keep-alive|proxy-.*|set-cookie|transfer-encoding|upgrade)$/.test(key)) {
      delete result[key]
    }
  }
  if (typeof result.location === 'string') {
    const location = URL.parse(result.location, new URL(path, backend))
    if (!location || !['http:', 'https:'].includes(location.protocol)) delete result.location
    else if (location.origin === backend.origin) result.location = mount + location.pathname + location.search + location.hash
  }
  if (result['service-worker-allowed']) result['service-worker-allowed'] = mount + '/'
  result['cache-control'] = 'private, no-store'
  result['referrer-policy'] = 'no-referrer'
  return result
}

function privateOrigin(value, loopbackOnly = false) {
  const url = new URL(value)
  const parts = url.hostname.split('.').map(Number)
  const tailnet = isIPv4(url.hostname) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
  if (url.href !== url.origin + '/' || url.protocol !== 'http:' ||
      (url.hostname !== '127.0.0.1' && (loopbackOnly || !tailnet))) {
    throw new Error('Central Web requires a private HTTP origin')
  }
  return url
}

function upstreamPath(req) {
  const url = req.url ?? ''
  if (!url.startsWith(mount + '/') || url.startsWith(mount + '//') || url.includes('\\')) return null
  if (!new URL(url, 'http://localhost').pathname.startsWith(mount + '/')) return null
  return url.slice(mount.length)
}

function keepAuthorized(authorize, interval, shutdown) {
  let stopped = false
  let timer
  const tick = async () => {
    const status = await authorize()
    if (stopped) return
    if (status !== 200) shutdown()
    else schedule()
  }
  const schedule = () => {
    timer = setTimeout(tick, interval)
    timer.unref()
  }
  schedule()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/**
 * Serve Central Muse under /central/ using the current Muse account session and a private Host cookie.
 * @param {object} config Trusted deployment settings and native authentication reader.
 * @returns {import('node:http').Server} A server ready to listen on loopback.
 */
export function createCentralServer({
  publicOrigin, accountsOrigin, backendOrigin, ownerAccountId, allowedAccountIds, getBackendCookie, authorizationIntervalMs = 5000,
}) {
  const account = privateOrigin(accountsOrigin, true)
  const backend = privateOrigin(backendOrigin)
  const origin = new URL(publicOrigin)
  if (origin.protocol !== 'https:' || origin.href !== origin.origin + '/' ||
      !/^[a-f0-9]{16}$/.test(ownerAccountId) || typeof getBackendCookie !== 'function' ||
      (allowedAccountIds !== undefined && (!Array.isArray(allowedAccountIds) || allowedAccountIds.length === 0 ||
        allowedAccountIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) ||
        !allowedAccountIds.includes(ownerAccountId))) ||
      !Number.isSafeInteger(authorizationIntervalMs) || authorizationIntervalMs <= 0) {
    throw new Error('Invalid Central Web configuration')
  }

  async function authorize(cookie) {
    if (!cookie) return 401
    try {
      const reply = await fetch(new URL('/api/muse.account', account), {
        headers: { cookie, accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(2500),
      })
      if (reply.status === 303 || reply.status === 401 || reply.status === 403) {
        await reply.body?.cancel()
        return reply.status === 403 ? 403 : 401
      }
      if (reply.status !== 200 || !reply.headers.get('content-type')?.startsWith('application/json')) {
        await reply.body?.cancel()
        return 503
      }
      const profile = await reply.json()
      const allowed = allowedAccountIds === undefined
        ? profile?.accountId === ownerAccountId && profile.admin === true
        : allowedAccountIds.includes(profile?.accountId)
      return allowed && profile.environment === 'production' ? 200 : 403
    } catch {
      return 503
    }
  }

  function passwordLogin(req, res) {
    const headers = forwardHeaders(req, account, '', origin.origin)
    const proxy = request(new URL('/login', account), { method: 'POST', headers }, async reply => {
      const cookies = (reply.headers['set-cookie'] ?? []).filter(value => value.startsWith(cookieName + '='))
      reply.resume()
      if (reply.statusCode === 303 && cookies.length === 1) {
        const status = await authorize(cookies[0].split(';', 1)[0])
        if (status === 200) respond(res, 303, '', { location: mount + '/', 'set-cookie': cookies })
        else respond(res, status, '此账号无法登录中央 Muse。')
      } else {
        respond(res, reply.statusCode === 429 ? 429 : 401, '登录失败，请返回中央 Muse 重试。')
      }
    })
    proxy.setTimeout(10_000, () => proxy.destroy())
    proxy.on('error', () => respond(res, 503, '登录服务暂时不可用。'))
    res.once('close', () => proxy.destroy())
    req.pipe(proxy)
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.url === mount) {
        respond(res, 308, '', { location: mount + '/' })
        return
      }
      const path = upstreamPath(req)
      if (!path) { respond(res, 404); return }
      if ((!['GET', 'HEAD'].includes(req.method) || req.headers.origin) && req.headers.origin !== origin.origin) {
        respond(res, 403)
        return
      }
      if (req.method === 'POST' && path === '/login') { passwordLogin(req, res); return }
      const authorizeRequest = () => authorize(accountCookie(req))
      const status = await authorizeRequest()
      if (status === 401 && path === '/' && ['GET', 'HEAD'].includes(req.method)) {
        respond(res, 200, loginPage, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        })
        return
      }
      if (status === 401) { respond(res, 303, '', { location: '/login' }); return }
      if (status !== 200) { respond(res, status, status === 403 ? '此账号没有中央 Muse 的访问权限。' : '登录服务暂时不可用。'); return }
      const cookie = await getBackendCookie()
      if (!cookie) { respond(res, 503, '中央 Muse 正在准备，请稍后刷新。'); return }
      if (res.destroyed) return
      const proxy = request(backend, {
        method: req.method, path, headers: forwardHeaders(req, backend, cookie, backend.origin),
      }, reply => {
        reply.once('error', () => res.destroy())
        res.writeHead(reply.statusCode, responseHeaders(reply.headers, backend, path))
        reply.pipe(res)
      })
      const stop = keepAuthorized(authorizeRequest, authorizationIntervalMs, () => {
        proxy.destroy()
        res.destroy()
      })
      res.once('close', () => { stop(); proxy.destroy() })
      proxy.on('error', () => {
        if (res.headersSent) res.destroy()
        else respond(res, 503, '中央 Muse 暂时不可用。')
      })
      req.pipe(proxy)
    } catch {
      if (res.headersSent) res.destroy()
      else respond(res, 503, '中央 Muse 暂时不可用。')
    }
  })

  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => socket.destroy())
    const reject = status => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    try {
      const path = upstreamPath(req)
      if (!path || req.headers.upgrade?.toLowerCase() !== 'websocket') { reject(404); return }
      if (req.headers.origin !== origin.origin) { reject(403); return }
      const authorizeRequest = () => authorize(accountCookie(req))
      const status = await authorizeRequest()
      if (status !== 200) { reject(status); return }
      const cookie = await getBackendCookie()
      if (!cookie) { reject(503); return }
      if (socket.destroyed) return
      const proxy = request(backend, { path, headers: forwardHeaders(req, backend, cookie, backend.origin, true) })
      const stop = keepAuthorized(authorizeRequest, authorizationIntervalMs, () => socket.destroy())
      socket.once('close', () => { stop(); proxy.destroy() })
      proxy.setTimeout(15_000, () => proxy.destroy())
      proxy.once('error', () => reject(503))
      proxy.once('response', reply => { reply.resume(); reject(503) })
      proxy.once('upgrade', (reply, upstream, upstreamHead) => {
        if (socket.destroyed) { upstream.destroy(); return }
        upstream.setTimeout(0)
        upstream.on('error', () => socket.destroy())
        upstream.once('close', () => socket.destroy())
        socket.once('close', () => upstream.destroy())
        const handshake = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade']
        for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
          if (reply.headers[name]) handshake.push(name + ': ' + reply.headers[name])
        }
        socket.write(handshake.join('\r\n') + '\r\n\r\n')
        if (upstreamHead.length) socket.write(upstreamHead)
        if (head.length) upstream.write(head)
        socket.pipe(upstream).pipe(socket)
      })
      proxy.end()
    } catch {
      reject(503)
    }
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(process.env.MUSE_CENTRAL_CONFIG, 'utf8'))
  const { backendCookieFile, port, ...settings } = config
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || typeof backendCookieFile !== 'string') {
    throw new Error('Invalid Central Web port or cookie location')
  }
  createCentralServer({
    ...settings,
    getBackendCookie: async () => (await readFile(backendCookieFile, 'utf8')).trim(),
  }).listen(port, '127.0.0.1')
}
