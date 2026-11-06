/** Loopback-only market API provider for a dedicated dsh profile. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import Schema from '@deepseek-ai/schemastery'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { MuseMarketCatalog, handleMarket } from './server.ts'
import type { MarketActor } from './types.ts'

/** Deployment policy path, outside the immutable release directory. */
export interface Config { readonly policyFile: string }
/** Validate the explicit administrator-maintained policy location. */
export const Config = Schema.object({ policyFile: Schema.string().required() })
/** Require the profile's loopback HTTP carrier before API registration. */
export const inject = ['webServer']

/** Open the cloud catalog and authenticate gateway-supplied actor assertions.
 * @param ctx Dedicated market profile with its HTTP carrier.
 * @param config Policy file containing resource limits, storage root and shared secret path.
 * @returns Teardown that stops admission, cancels body readers and closes SQLite.
 */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  if (ctx.webServer.host !== '127.0.0.1' || !isAbsolute(config.policyFile)) throw new Error('Market requires loopback and an absolute policy path')
  const metadata = await lstat(config.policyFile)
  if (!metadata.isFile() || (metadata.mode & 0o022) !== 0 && process.platform !== 'win32') throw new Error('Market policy must be administrator-owned')
  const input: unknown = JSON.parse(await readFile(config.policyFile, 'utf8'))
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid market policy')
  const value = input as Record<string, unknown>
  if (typeof value.root !== 'string' || typeof value.secretFile !== 'string' || !isAbsolute(value.secretFile)
    || !Array.isArray(value.allowedPlugins) || !value.allowedPlugins.every((name: unknown) => typeof name === 'string' && /^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(name))
    || !value.limits || typeof value.limits !== 'object' || Array.isArray(value.limits)) throw new Error('Invalid market policy')
  const limits = value.limits as Record<string, unknown>
  const bounded = (number: unknown, minimum: number, maximum: number): number => {
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error('Invalid market resource limit')
    return number
  }
  const resolved = { root: value.root, allowedPlugins: value.allowedPlugins as string[],
    maxReleases: bounded(value.maxReleases, 1, 100000), maxActiveUploads: bounded(value.maxActiveUploads, 1, 32),
    limits: {
      archiveBytes: bounded(limits.archiveBytes, 1024, 64 * 1024 * 1024),
      expandedBytes: bounded(limits.expandedBytes, 1024, 256 * 1024 * 1024),
      fileCount: bounded(limits.fileCount, 1, 4096),
    } }
  const secretMetadata = await lstat(value.secretFile)
  if (!secretMetadata.isFile() || (secretMetadata.mode & 0o077) !== 0 && process.platform !== 'win32') throw new Error('Market secret file must be private')
  const secret = (await readFile(value.secretFile, 'utf8')).trim()
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error('Invalid market gateway secret')
  const expected = Buffer.from(`Bearer ${secret}`), catalog = await MuseMarketCatalog.open(resolved)
  const requests = new Set<IncomingMessage>(), pending = new Set<Promise<void>>()
  const route = ctx.webServer.register({ kind: 'prefix', path: '/api/market/v1', handler: async (request, response) => {
    const authorization = Buffer.from(request.headers.authorization ?? '')
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      response.writeHead(401); response.end(); return
    }
    let actor: MarketActor | null = null
    const header = request.headers['x-muse-market-actor']
    if (header !== undefined) {
      if (typeof header !== 'string' || header.length > 1024) { response.writeHead(400); response.end(); return }
      let parsed: unknown
      try { parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) } catch { response.writeHead(400); response.end(); return }
      if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || typeof parsed.id !== 'string' || !/^[a-f0-9]{16}$/.test(parsed.id)
        || !('username' in parsed) || typeof parsed.username !== 'string' || parsed.username.length < 1 || parsed.username.length > 32
        || !('admin' in parsed) || typeof parsed.admin !== 'boolean') { response.writeHead(400); response.end(); return }
      actor = { id: parsed.id, username: parsed.username, admin: parsed.admin }
    }
    requests.add(request)
    const work = handleMarket(catalog, request, response, actor, resolved.limits); pending.add(work)
    try { await work } finally { pending.delete(work); requests.delete(request) }
  } })
  return async () => {
    route()
    for (const request of requests) request.destroy()
    await Promise.allSettled([...pending]); await catalog.close()
  }
}
