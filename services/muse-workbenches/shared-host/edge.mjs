/** Same-host workbench access for a Muse installation with two path mounts. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'

const mounts = { jubengongfang: 'script-workshop', jingliu: 'jingliu' }
const noStore = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

function workshopApiPath(path) {
  return /^\/jubengongfang\/(?:api\/)?v1\//.test(path) && !/\\|%(?:2e|2f|5c|25)|(?:^|\/)\.{1,2}(?:\/|$)/i.test(path)
}

function reply(res, status, body = '', headers = {}) {
  res.writeHead(status, { ...noStore, ...headers })
  res.end(body)
}

/** Verify every request with the live Muse gateway. Retain only its digest in the native-session cache. */
export function createEdge(config, transport = fetch) {
  if (config.archiveWorkshopWeb !== undefined && typeof config.archiveWorkshopWeb !== 'boolean') {
    throw new TypeError('archiveWorkshopWeb must be a boolean')
  }
  const cache = new Map()
  const service = http.createServer(async (req, res) => {
    const match = /^\/(check|check-web|enter|archive|session)\/(jubengongfang|jingliu)$/.exec(req.url || '')
    if (!match) return reply(res, 404)
    const [, kind, mount] = match
    const app = mounts[mount]
    const workshop = app === 'script-workshop'
    const archived = workshop && config.archiveWorkshopWeb === true
    const checking = kind === 'check' || kind === 'check-web'
    const entering = kind === 'enter' || kind === 'archive'
    const path = String(req.headers['x-workbench-path'] || '').split('?')[0]
    // Older nginx locations use the same auth subrequest for the browser and API.
    const adminOnly = archived && (kind !== 'check' || !workshopApiPath(path))
    if (kind === 'archive' && !archived) return reply(res, 404)
    const name = workshop ? archived ? '旧版剧本工坊' : '剧本工坊' : '镜流'
    const entryPage = () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405)
      const page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + name + ' · Muse</title><style>body{font:16px system-ui;display:grid;min-height:90vh;place-items:center;color-scheme:light dark}main{max-width:30rem}a,button{font:inherit;margin-right:1rem}p{line-height:1.6}</style><main><h1>' + name + '</h1><p id="status" role="status">正在验证 Muse 账号…</p><a href="/login" target="_blank" rel="noopener" hidden>登录 Muse</a><button hidden>进入工作台</button></main><script src="/' + mount + '/_store.js"></script><script src="/' + mount + '/_entry.js" defer></script></html>'
      return reply(res, 200, page, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self' dsh-app://app" })
    }
    if (entering && !adminOnly) return entryPage()
    if (kind === 'session' && (req.method !== 'POST' || req.headers.origin !== config.origin)) return reply(res, 403)
    const verb = checking ? req.headers['x-workbench-method'] : req.method
    if (checking && !['GET', 'HEAD', 'OPTIONS'].includes(verb) && req.headers['x-workbench-origin'] !== config.origin) return reply(res, 403)
    const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(config.cookieName + '='))
    if (cookie.length !== 1) return reply(res, 401)
    try {
      const identityPath = adminOnly ? '/api/muse.account' : '/api/muse/identity'
      const response = await transport(config.gateway + identityPath, { headers: { cookie: cookie[0], accept: 'application/json' }, redirect: adminOnly ? 'manual' : 'error', signal: AbortSignal.timeout(6000) })
      if (adminOnly && response.status === 303 && response.headers.get('location') === '/login') {
        await response.body?.cancel()
        return reply(res, 401)
      }
      if (!response.ok) { await response.body?.cancel(); return reply(res, response.status === 401 || response.status === 403 ? response.status : 503) }
      const user = await response.json()
      if (!user || typeof user.accountId !== 'string' || !user.accountId) return reply(res, 503)
      if (adminOnly && user.admin !== true) return reply(res, 403)
      if (entering) return entryPage()
      const client = config.apps[app]
      const bindings = JSON.parse(await readFile(client.bindings, 'utf8'))
      // A subject outside the bindings file is still offered to the workbench: Jingliu opens an account on
      // first sign-in, Workshop refuses it. A listed subject must come back as exactly its listed owner.
      const owner = Object.hasOwn(bindings.users, user.accountId) ? bindings.users[user.accountId] : null
      if (bindings.issuer !== config.origin || (owner !== null && (!Number.isSafeInteger(owner) || owner < 1))) return reply(res, 403)
      const username = typeof user.username === 'string' ? user.username : undefined
      const key = createHash('sha256').update(JSON.stringify([app, cookie[0], user.accountId, owner])).digest('hex')
      const now = Date.now()
      for (const [id, value] of cache) if (value.deadline <= now) cache.delete(id)
      let entry = cache.get(key)
      if (!entry) {
        if (cache.size >= 512) return reply(res, 503)
        const result = (async () => {
          const r = await transport(client.nativeLogin, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + client.secret }, body: JSON.stringify({ sub: user.accountId, username }) })
          if (!r.ok) { await r.body?.cancel(); throw Object.assign(Error('Native login rejected'), { status: r.status === 403 ? 403 : 503 }) }
          const value = await r.json()
          const token = app === 'jingliu' ? value?.token : value?.access_token
          const id = value?.user?.id
          if ((owner === null ? !(Number.isSafeInteger(id) && id > 0) : id !== owner) || typeof token !== 'string' || !token || /[\s\x00-\x1f]/.test(token)) throw Error('Invalid native session')
          return { token, value }
        })()
        entry = { deadline: now + 5 * 60_000, result }
        cache.set(key, entry)
      }
      let session
      try { session = await entry.result } catch (e) { if (cache.get(key) === entry) cache.delete(key); throw e }
      if (kind === 'check' && verb === 'POST') {
        if (path === '/jingliu/fwp/v2/auth/logout' || path === '/jubengongfang/v1/auth/logout' || path === '/jubengongfang/api/v1/auth/logout') cache.delete(key)
      }
      if (checking) return reply(res, 204, '', { 'x-workbench-authorization': 'Bearer ' + session.token })
      return reply(res, 200, JSON.stringify(session.value), { 'content-type': 'application/json' })
    } catch (error) { return reply(res, error.status === 403 ? 403 : 503) }
  })
  return service
}

if (import.meta.main) {
  const config = JSON.parse(await readFile(process.env.MUSE_WORKBENCH_EDGE_CONFIG, 'utf8'))
  createEdge(config).listen(config.port, '127.0.0.1')
}
