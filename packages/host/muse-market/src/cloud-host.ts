/** Dedicated loopback API provider; only the account gateway can assert an actor. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import Schema from '@deepseek-ai/schemastery'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { marketRecord } from './format.ts'
import { MarketCloudError, parseMarketActor } from './cloud-protocol.ts'
import type { MarketActor } from './cloud-protocol.ts'
import { handleMarket, MuseMarketCatalog } from './server.ts'
import type { MarketServerConfig } from './server.ts'

/** Administrator-owned policy file for the separate cloud profile. */
export interface Config { readonly policyFile: string }
/** Require an explicit policy path; cloud hosting is never enabled by a local import. */
export const Config = Schema.object({ policyFile: Schema.string().required() })
/** Cordis plugin name. */
export const name = 'muse-market-cloud-host'
/** Loopback HTTP carrier owned by the dedicated profile. */
export const inject = ['webServer']

function bounded(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MarketCloudError('invalid-policy', 400)
  }
  return value
}
async function policy(file: string): Promise<{ catalog: MarketServerConfig; secret: string }> {
  if (!isAbsolute(file)) throw new MarketCloudError('invalid-policy', 400)
  const metadata = await lstat(file)
  if (!metadata.isFile() || metadata.size > 65536 || process.platform !== 'win32' && (metadata.mode & 0o022) !== 0) {
    throw new MarketCloudError('unsafe-policy', 400)
  }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file)))
  const keys = ['root', 'secretFile', 'maxReleases', 'maxActiveUploads', 'jsonRequestBytes', 'jsonResponseBytes', 'catalogLimit', 'limits']
  if (!marketRecord(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))
    || typeof value.root !== 'string' || !isAbsolute(value.root) || typeof value.secretFile !== 'string'
    || !isAbsolute(value.secretFile) || !marketRecord(value.limits)
    || Object.keys(value.limits).length !== 4) throw new MarketCloudError('invalid-policy', 400)
  const limits = value.limits
  const catalog: MarketServerConfig = { root: value.root,
    maxReleases: bounded(value.maxReleases, 1, 100000), maxActiveUploads: bounded(value.maxActiveUploads, 1, 32),
    jsonRequestBytes: bounded(value.jsonRequestBytes, 1024, 16 * 1024 * 1024),
    jsonResponseBytes: bounded(value.jsonResponseBytes, 1024, 64 * 1024 * 1024),
    catalogLimit: bounded(value.catalogLimit, 1, 100),
    limits: { archiveBytes: bounded(limits.archiveBytes, 1024, 64 * 1024 * 1024),
      expandedBytes: bounded(limits.expandedBytes, 1024, 256 * 1024 * 1024),
      fileCount: bounded(limits.fileCount, 2, 4096), recordBytes: bounded(limits.recordBytes, 1024, 16 * 1024 * 1024) } }
  const secretMetadata = await lstat(value.secretFile)
  if (!secretMetadata.isFile() || secretMetadata.size > 1024
    || process.platform !== 'win32' && (secretMetadata.mode & 0o077) !== 0) throw new MarketCloudError('unsafe-secret', 400)
  const secret = (await readFile(value.secretFile, 'utf8')).trim()
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(secret)) throw new MarketCloudError('invalid-secret', 400)
  return { catalog, secret }
}
function actor(value: string | string[] | undefined): MarketActor | null {
  if (value === undefined) return null
  try {
    if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Invalid actor encoding')
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) throw new Error('Invalid actor encoding')
    return parseMarketActor(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch (error) { throw new MarketCloudError('invalid-actor', 400, { cause: error }) }
}
function reject(response: ServerResponse, status: number, error: string): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ error }))
}

/** Open the private cloud store and own all accepted HTTP work through shutdown.
 * @param ctx - Dedicated profile with a loopback HTTP carrier.
 * @param config - Explicit administrator policy location.
 * @returns Completion after the effect has acquired its catalog and route.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (ctx.webServer.host !== '127.0.0.1') throw new MarketCloudError('loopback-required', 400)
  await ctx.effect(async () => {
    const resolved = await policy(config.policyFile), catalog = await MuseMarketCatalog.open(resolved.catalog)
    const expected = Buffer.from(`Bearer ${resolved.secret}`)
    const requests = new Set<IncomingMessage>(), pending = new Set<Promise<void>>()
    let route: (() => void)
    try {
      route = ctx.webServer.register({ kind: 'prefix', path: '/api/market/v1', handler: async (request, response) => {
        const authorization = Buffer.from(request.headers.authorization ?? '')
        if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
          request.resume(); reject(response, 401, 'gateway-required'); return
        }
        let assertion: MarketActor | null
        try { assertion = actor(request.headers['x-muse-market-actor']) }
        catch (_error) { request.resume(); reject(response, 400, 'invalid-actor'); return }
        requests.add(request)
        const work = handleMarket(catalog, request, response, assertion, resolved.catalog)
        pending.add(work)
        try { await work } finally { pending.delete(work); requests.delete(request) }
      } })
    } catch (error) { await catalog.close(); throw error }
    return async () => {
      route()
      for (const request of requests) request.destroy()
      await Promise.allSettled([...pending])
      await catalog.close()
    }
  }, 'museMarket.cloud-http')
}
