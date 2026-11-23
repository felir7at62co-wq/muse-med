import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROUTE = '/api/bot/central-members'

const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

function sessionCookie(session, origin) {
  if (session?.baseUrl !== origin || typeof session.cookie !== 'string' || !/^__Host-muse=[^;\s]+$/u.test(session.cookie)) return null
  return session.cookie
}

function account(row, username) {
  if (!/^[a-f0-9]{16}$/u.test(row?.id) || typeof row.username !== 'string' || typeof row.disabled !== 'boolean') return null
  return {
    id: row.id, name: row.username, disabled: row.disabled, admin: row.admin === true, own: row.username === username,
    revision: row.revision,
    groups: Array.isArray(row.groups) ? row.groups.flatMap(group =>
      typeof group?.name === 'string' ? [{ name: group.name, description: typeof group.description === 'string' ? group.description : '' }] : []) : [],
  }
}

// Central is available only in the private cloud profile. Use the existing signed-in Muse
// administrator and the normal account actions, keeping the cookie and identity records on the Host.
export function centralMembersHandler({ origin, webOrigins, getSession, requestGateway = fetch }) {
  return async request => {
    if (!webOrigins.includes(request.headers.get('origin'))) return reply({ code: 'forbidden' }, 403)
    let input
    try { input = await request.json() } catch (error) { void error; return reply({ code: 'invalid' }, 400) }
    if (!['list', 'groups', 'disabled'].includes(input?.action)) return reply({ code: 'invalid' }, 400)
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
    try {
      const session = await getSession()
      const cookie = sessionCookie(session, origin)
      if (!cookie) return reply({ code: 'sign-in' }, 401)
      const call = (path, options) => requestGateway(new URL(path, origin), {
        ...options, signal, redirect: 'manual', headers: { cookie, origin },
      })
      const getMembers = async () => {
        const response = await call('/api/admin/accounts')
        if (!response.ok) return response
        const body = await response.json()
        if (!Array.isArray(body.items)) throw new Error('Unexpected roster data')
        return body.items.map(row => account(row, session.username)).filter(Boolean)
      }
      const members = await getMembers()
      if (members instanceof Response) return reply({ code: members.status === 401 ? 'sign-in' : 'forbidden' }, members.status)
      if (input.action === 'list') return reply({ members })
      const member = members.find(row => row.id === input.id)
      if (!member || member.own && input.action === 'disabled') return reply({ code: 'forbidden' }, 403)
      if (member.revision !== input.revision) return reply({ code: 'changed' }, 409)
      const latest = await getSession()
      if (latest?.revision !== session.revision || sessionCookie(latest, origin) !== cookie) return reply({ code: 'sign-in' }, 401)
      const form = new URLSearchParams({ id: member.id })
      if (input.action === 'groups') {
        if (!Array.isArray(input.groups) || input.groups.length > 50 || input.groups.some(group =>
          typeof group?.name !== 'string' || !group.name.trim() || group.name.length > 100 ||
          typeof group.description !== 'string' || group.description.length > 400)) return reply({ code: 'invalid' }, 400)
        for (const { name, description } of input.groups) {
          form.append('groupName', name)
          form.append('groupDescription', description)
        }
      } else {
        if (typeof input.disabled !== 'boolean') return reply({ code: 'invalid' }, 400)
        form.set('disabled', String(input.disabled))
      }
      const result = await call(input.action === 'groups' ? '/admin/groups' : '/admin/disable', { method: 'POST', body: form })
      await result.body?.cancel()
      if (result.status === 303 && result.headers.get('location') === '/admin') return reply({ saved: true })
      if (result.status === 401 || result.headers.get('location') === '/login') return reply({ code: 'sign-in' }, 401)
      return reply({ code: 'refused' }, 409)
    } catch (error) {
      void error
      return reply({ code: input.action === 'list' ? 'unavailable' : 'unconfirmed' }, 502)
    }
  }
}

export function installCentralMembers(rt) {
  if (process.env.MUSE_CENTRAL_MEMBERS !== '1') return false
  const origin = new URL(process.env.MUSE_BASE_URL).origin
  if (!origin.startsWith('https://') || origin !== process.env.MUSE_BASE_URL) throw new Error('Central requires a fixed HTTPS Muse account origin')
  const webOrigin = new URL(process.env.MUSE_CENTRAL_ORIGIN).origin
  if (webOrigin !== process.env.MUSE_CENTRAL_ORIGIN) throw new Error('Central requires its exact Web origin')
  const webOrigins = [webOrigin]
  const configuredLoopback = process.env.MUSE_CENTRAL_LOOPBACK_ORIGIN
  if (configuredLoopback !== undefined) {
    const url = new URL(configuredLoopback)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== configuredLoopback) {
      throw new Error('Central requires an exact HTTP loopback origin')
    }
    webOrigins.push(url.origin)
  }
  const sessionPath = join(process.env.MUSE_HOME ?? rt.dshHome, 'muse-account', 'session.json')
  const getSession = async () => {
    try { return JSON.parse(await readFile(sessionPath, 'utf8')) }
    catch (error) { if (error?.code !== 'ENOENT') throw error; return null }
  }
  const handle = centralMembersHandler({ origin, webOrigins, getSession })
  rt.ctx.effect(() => rt.ctx.connection.fetch.register({
    path: ROUTE, methods: ['POST'], requestBody: 'buffered',
    fetch: request => rt.readOnly() === undefined ? handle(request) : reply({ code: 'forbidden' }, 403),
  }), 'ds-bot: central members')
  return origin
}
