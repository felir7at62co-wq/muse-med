/** Same-host workbench access for a Muse installation under the Jingliu path. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'

const noStore = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

function reply(res, status, body = '', headers = {}) {
  res.writeHead(status, { ...noStore, ...headers })
  res.end(body)
}

/** Verify every request with the live Muse gateway. Retain only its digest in the native-session cache. */
export function createEdge(config, transport = fetch) {
  const cache = new Map()
  const service = http.createServer(async (req, res) => {
    const match = /^\/(check|enter|session)\/(jingliu)$/.exec(req.url || '')
    if (!match) return reply(res, 404)
    const [, kind, mount] = match
    const app = mount
    const name = '镜流'
    if (kind === 'enter') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405)
      const page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + name + ' · Muse</title><style>body{font:16px system-ui;display:grid;min-height:90vh;place-items:center;color-scheme:light dark}main{max-width:30rem}a,button{font:inherit;margin-right:1rem}p{line-height:1.6}</style><main><h1>' + name + '</h1><p id="status" role="status">正在验证 Muse 账号…</p><a href="/login" target="_blank" rel="noopener" hidden>登录 Muse</a><button hidden>进入工作台</button></main><script src="/' + mount + '/_store.js"></script><script src="/' + mount + '/_entry.js" defer></script></html>'
      return reply(res, 200, page, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self' dsh-app://app" })
    }
    if (kind === 'session' && (req.method !== 'POST' || req.headers.origin !== config.origin)) return reply(res, 403)
    const verb = kind === 'check' ? req.headers['x-workbench-method'] : req.method
    if (kind === 'check' && !['GET', 'HEAD', 'OPTIONS'].includes(verb) && req.headers['x-workbench-origin'] !== config.origin) return reply(res, 403)
    const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(config.cookieName + '='))
    if (cookie.length !== 1) return reply(res, 401)
    try {
      const response = await transport(config.gateway + '/api/muse/identity', { headers: { cookie: cookie[0], accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(6000) })
      if (!response.ok) { await response.body?.cancel(); return reply(res, response.status === 401 || response.status === 403 ? response.status : 503) }
      const user = await response.json()
      if (!user || typeof user.accountId !== 'string' || !user.accountId) return reply(res, 503)
      const client = config.apps[app]
      const bindings = JSON.parse(await readFile(client.bindings, 'utf8'))
      const owner = Object.hasOwn(bindings.users, user.accountId) ? bindings.users[user.accountId] : null
      if (bindings.issuer !== config.origin || !Number.isSafeInteger(owner) || owner < 1) return reply(res, 403)
      const key = createHash('sha256').update(JSON.stringify([app, cookie[0], user.accountId, owner])).digest('hex')
      const now = Date.now()
      for (const [id, value] of cache) if (value.deadline <= now) cache.delete(id)
      let entry = cache.get(key)
      if (!entry) {
        if (cache.size >= 512) return reply(res, 503)
        const result = (async () => {
          const r = await transport(client.nativeLogin, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + client.secret }, body: JSON.stringify({ sub: user.accountId }) })
          if (!r.ok) { await r.body?.cancel(); throw Object.assign(Error('Native login rejected'), { status: r.status === 403 ? 403 : 503 }) }
          const value = await r.json()
          const token = value?.token
          if (value?.user?.id !== owner || typeof token !== 'string' || !token || /[\s\x00-\x1f]/.test(token)) throw Error('Invalid native session')
          return { token, value }
        })()
        entry = { deadline: now + 5 * 60_000, result }
        cache.set(key, entry)
      }
      let session
      try { session = await entry.result } catch (e) { if (cache.get(key) === entry) cache.delete(key); throw e }
      if (kind === 'check' && verb === 'POST') {
        const path = String(req.headers['x-workbench-path'] || '').split('?')[0]
        if (path === '/jingliu/fwp/v2/auth/logout') cache.delete(key)
      }
      if (kind === 'check') return reply(res, 204, '', { 'x-workbench-authorization': 'Bearer ' + session.token })
      return reply(res, 200, JSON.stringify(session.value), { 'content-type': 'application/json' })
    } catch (error) { return reply(res, error.status === 403 ? 403 : 503) }
  })
  return service
}

if (import.meta.main) {
  const config = JSON.parse(await readFile(process.env.MUSE_WORKBENCH_EDGE_CONFIG, 'utf8'))
  createEdge(config).listen(config.port, '127.0.0.1')
}
