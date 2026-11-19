/** Authenticated, read-only access to videos selected in the Muse renderer. */
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-jingliu-connection'
import type {} from '@deepseek-ai/dsh-muse-account'
import { cutImportLimits, cutImportRoute } from './cut-import-protocol.ts'
import { cutProjectDetail, cutProjects } from './cut-import-source.ts'

interface Ticket { identity: string; urls: URL[]; expires: number }
const lifetimeMs = 20 * 60_000

/** Only the studio's own media handler may redirect to a signed Volcengine object. */
function storageRedirect(location: string | null): URL | undefined {
  if (!location) return
  let u: URL
  try { u = new URL(location) } catch { return }
  if (u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash &&
    /^[a-z0-9-]+\.tos-[a-z0-9-]+\.volces\.com$/u.test(u.hostname) && u.searchParams.has('X-Tos-Signature')) return u
  return
}

/** Stream one selected clip from the trusted media mount or its signed storage URL.
 * @param url - Server-selected video resource.
 * @param signal - Ends the upstream request on logout, timeout, or client disconnect.
 * @returns A bounded video byte stream and its MIME type.
 */
export async function fetchCutVideo(url: URL, signal: AbortSignal): Promise<{ mime: string; chunks: AsyncIterable<Uint8Array> }> {
  const init: RequestInit = { redirect: 'manual', signal, credentials: 'omit' }
  let response = await fetch(url, init)
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const target = storageRedirect(response.headers.get('location'))
    await response.body?.cancel()
    if (!target) throw Error('media')
    response = await fetch(target, { ...init, redirect: 'error' })
  }
  const mime = response.headers.get('content-type')?.split(';')[0]?.toLowerCase()
  const fallback = url.pathname.endsWith('.webm') ? 'video/webm' : url.pathname.endsWith('.mov') ? 'video/quicktime' : 'video/mp4'
  if (!response.ok || !response.body || (mime && !['video/mp4', 'video/webm', 'video/quicktime', 'application/octet-stream'].includes(mime)) ||
    Number(response.headers.get('content-length')) > cutImportLimits.clipBytes) {
    await response.body?.cancel()
    throw Error('media')
  }
  const reader = response.body.getReader()
  async function* chunks() {
    let bytes = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > cutImportLimits.clipBytes) throw Error('media')
        yield part.value
      }
      if (!bytes) throw Error('media')
    } finally { await reader.cancel(); reader.releaseLock() }
  }
  return { mime: mime?.startsWith('video/') ? mime : fallback, chunks: chunks() }
}

/** Register the optional import routes for the configured studio's active account.
 * @param ctx - Host containing HTTP trust and Jingliu account services.
 * @param studioOrigin - Validated studio deployment origin.
 */
export function registerCutImport(ctx: Context, studioOrigin: string): void {
  const origin = new URL(studioOrigin).origin
  ctx.inject(['connection', 'webServer', 'jingliuConnection'], (scope) => {
    const trust = Reflect.get(scope, 'connection') as { requestRejection(req: IncomingMessage): number | undefined }
    const tickets = new Map<string, Ticket>()
    let account = new AbortController()
    const reset = () => { tickets.clear(); account.abort(); account = new AbortController() }
    scope.on('muse-account/session-changed', reset)
    scope.effect(() => reset, 'cut import: cancel account transfers')
    scope.effect(() => scope.webServer.register({
      kind: 'prefix', path: cutImportRoute, handler: async (req, res) => {
        const deny = trust.requestRejection(req)
        if (deny || req.method !== 'GET') { res.writeHead(deny ?? 405); res.end(); return }
        res.setHeader('cache-control', 'no-store')
        res.setHeader('x-content-type-options', 'nosniff')
        const url = new URL(req.url ?? '', 'http://localhost')
        const path = url.pathname.slice(cutImportRoute.length)
        const client = new AbortController()
        res.once('close', () => client.abort())
        const signal = AbortSignal.any([client.signal, account.signal, AbortSignal.timeout(lifetimeMs)])
        const json = (value: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
        try {
          const session = await scope.jingliuConnection.connection()
          signal.throwIfAborted()
          if (path === '/projects') { json(cutProjects(await session.request('/projects?trash=false', { signal }))); return }
          const match = /^\/projects\/([A-Za-z0-9_-]{1,80})\/episodes(?:\/(\d{1,6}))?$/u.exec(path)
          if (match?.[1]) {
            const id = match[1]
            if (!cutProjects(await session.request('/projects?trash=false', { signal })).some(p => p.id === id)) {
              res.writeHead(404); res.end(); return
            }
            const detail = cutProjectDetail(await session.request('/projects/' + id + '/detail', { signal }), id, origin)
            if (!match[2]) { json(detail.episodes); return }
            const order = Number(match[2]), clips = detail.select(order)
            const key = randomUUID()
            for (const [entry, ticket] of tickets) if (ticket.expires <= Date.now()) tickets.delete(entry)
            if (tickets.size >= 128) { res.writeHead(429); res.end(); return }
            tickets.set(key, { identity: session.identity, urls: clips.map(s => s.url), expires: Date.now() + lifetimeMs })
            json({ ticket: key, name: detail.title + ' · EP' + order, aspect: detail.aspect, shots: clips.map(s => s.edit) }); return
          }
          const clip = /^\/media\/([a-f\d-]{36})\/(\d{1,3})$/u.exec(path)
          const ticket = clip?.[1] && tickets.get(clip[1])
          const src = ticket && clip && ticket.urls[Number(clip[2])]
          if (!ticket || !src || ticket.identity !== session.identity || ticket.expires <= Date.now()) {
            res.writeHead(404); res.end(); return
          }
          const media = await fetchCutVideo(src, signal)
          res.setHeader('content-type', media.mime)
          await pipeline(media.chunks, res, { signal })
        } catch (error) {
          if (res.destroyed) return
          if (signal.aborted) { res.destroy(); return }
          if (res.headersSent) { res.destroy(); return }
          const auth = error instanceof Error && 'code' in error && /SIGN_IN|ACCOUNT_CHANGED/u.test(String(error.code))
          res.writeHead(auth ? 401 : 502); res.end()
        }
      },
    }), 'cut import: selected Jingliu media')
  })
}
