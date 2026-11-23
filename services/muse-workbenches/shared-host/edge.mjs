/** Same-host workbench access for a Muse installation with two path mounts. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'

const mounts = { jubengongfang: 'script-workshop', jingliu: 'jingliu' }
const noStore = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

function workshopApiPath(path) {
  return /^\/jubengongfang\/(?:api\/)?v1\//.test(path) && !/\\|%(?:2e|2f|5c|25)|(?:^|\/)\.{1,2}(?:\/|$)/i.test(path)
}

// A Workshop library reader reaches only its profile, sign-out and the finalized-script library. The patterns admit
// no dots, escapes or repeated slashes, so nginx forwards exactly the matched route. Workshop checks the pick and
// finalize permissions itself.
const readerRoutes = [
  ['GET', /^\/jubengongfang\/(?:api\/)?v1\/(?:auth\/me|script-library(?:\/[1-9]\d{0,9})?)$/],
  ['POST', /^\/jubengongfang\/(?:api\/)?v1\/(?:auth\/logout|script-library(?:\/[1-9]\d{0,9}\/(?:pick|production))?)$/],
]

function readerRoute(verb, path) {
  return readerRoutes.some(([method, route]) => (verb === 'HEAD' ? 'GET' : verb) === method && route.test(path))
}

/** Read an app's optional company tenants for Muse accounts outside its bindings file. */
function companyTenants(app, autoAccounts) {
  if (autoAccounts === undefined) return undefined
  const tenants = autoAccounts?.feishuTenants
  if (Object.keys(autoAccounts ?? {}).some(key => key !== 'feishuTenants') || !Array.isArray(tenants) || !tenants.length ||
    tenants.some(tenant => typeof tenant !== 'string' || !tenant.trim() || tenant.length > 256)) {
    throw new TypeError(app + ' autoAccounts must be { feishuTenants: [tenant keys] }')
  }
  return new Set(tenants)
}

/** Whether the signed-in account's own Muse profile lists a Feishu identity of one of the company tenants. */
async function companyMember(config, transport, cookie, accountId, tenants) {
  const response = await transport(config.gateway + '/api/muse/profile', { headers: { cookie, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(6000) })
  if (!response.ok) {
    await response.body?.cancel()
    throw Object.assign(Error('Muse profile unavailable'), { status: response.status === 401 || response.status === 403 ? 403 : 503 })
  }
  const profile = await response.json()
  const identities = profile?.account?.id === accountId ? profile.account.feishuIdentities : undefined
  return Array.isArray(identities) && identities.some(identity => tenants.has(identity?.tenantKey))
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
  const companies = Object.fromEntries(Object.entries(config.apps).map(([app, client]) => [app, companyTenants(app, client.autoAccounts)]))
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
      // A listed subject must come back as exactly its listed owner. A subject outside the bindings file reaches the
      // workbench only when its entry lists company tenants, and a Workshop library reader only on `readerRoutes`.
      const owner = Object.hasOwn(bindings.users, user.accountId) ? bindings.users[user.accountId] : null
      if (bindings.issuer !== config.origin || (owner !== null && (!Number.isSafeInteger(owner) || owner < 1))) return reply(res, 403)
      const tenants = companies[app]
      if (owner === null && (!tenants || (workshop && !(kind === 'check' && readerRoute(verb, path))))) return reply(res, 403)
      const native = owner === null
        ? { sub: user.accountId, username: typeof user.username === 'string' ? user.username : undefined, company: true }
        : { sub: user.accountId }
      const key = createHash('sha256').update(JSON.stringify([app, cookie[0], user.accountId, owner])).digest('hex')
      const now = Date.now()
      for (const [id, value] of cache) if (value.deadline <= now) cache.delete(id)
      let entry = cache.get(key)
      if (!entry) {
        if (cache.size >= 512) return reply(res, 503)
        const result = (async () => {
          if (owner === null && !await companyMember(config, transport, cookie[0], user.accountId, tenants)) {
            throw Object.assign(Error('Not a company account'), { status: 403 })
          }
          const r = await transport(client.nativeLogin, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + client.secret }, body: JSON.stringify(native) })
          if (!r.ok) { await r.body?.cancel(); throw Object.assign(Error('Native login rejected'), { status: r.status === 403 ? 403 : 503 }) }
          const value = await r.json()
          const token = app === 'jingliu' ? value?.token : value?.access_token
          const id = value?.user?.id
          const opened = Number.isSafeInteger(id) && id > 0 && !Object.values(bindings.users).includes(id)
          if ((owner === null ? !opened : id !== owner) || typeof token !== 'string' || !token || /[\s\x00-\x1f]/.test(token)) throw Error('Invalid native session')
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
