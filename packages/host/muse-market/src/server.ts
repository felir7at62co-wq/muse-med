/** Durable invitation-only release catalog behind the Muse account gateway. */
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MarketError, marketDigest, marketManifest, readMarketPackage } from './package.ts'
import type { MarketActor, MarketLimits, MarketPublisherId, MarketRelease, MarketReleaseId } from './types.ts'

const SCHEMA_VERSION = 1
const releasePrefix = '/releases/'

/** Explicit cloud storage and upload policy. */
export interface MarketServerConfig {
  readonly root: string
  readonly limits: MarketLimits
  readonly allowedPlugins: readonly string[]
  readonly maxReleases: number
  readonly maxActiveUploads: number
}

function identity(value: string): void {
  if (!/^[a-f0-9]{16,64}$/.test(value)) throw new MarketError('not-found', 404)
}
function rowRelease(value: Record<string, unknown>, allowed: readonly string[]): MarketRelease {
  const manifest: unknown = JSON.parse(String(value.manifest))
  return {
    id: String(value.id) as MarketReleaseId, publisherId: String(value.publisherId) as MarketPublisherId,
    publisher: String(value.publisher), manifest: marketManifest(manifest, allowed),
    sha256: String(value.sha256), bytes: Number(value.bytes), status: value.status as MarketRelease['status'],
    reviewNote: String(value.reviewNote), revision: Number(value.revision), createdAt: String(value.createdAt),
  }
}

/** Cloud release store; callers own gateway authentication and lifecycle. */
export class MuseMarketCatalog {
  private readonly database: DatabaseSync
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private closing: Promise<void> | undefined
  private readonly uploading = new Set<string>()

  private constructor(private readonly config: MarketServerConfig) {
    this.database = new DatabaseSync(join(config.root, 'market.sqlite'))
    const version = this.database.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 0 && version !== SCHEMA_VERSION) { this.database.close(); throw new Error('Unsupported market schema version') }
    this.database.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS publishers(id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members(publisherId TEXT NOT NULL, accountId TEXT NOT NULL, PRIMARY KEY(publisherId,accountId));
      CREATE TABLE IF NOT EXISTS releases(
        id TEXT PRIMARY KEY, publisherId TEXT NOT NULL, manifest TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
        sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, status TEXT NOT NULL, reviewNote TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, actorId TEXT NOT NULL, requestId TEXT NOT NULL,
        UNIQUE(publisherId,name,version), UNIQUE(actorId,requestId));
      CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, releaseId TEXT NOT NULL, actorId TEXT NOT NULL,
        status TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL);
      PRAGMA user_version=${SCHEMA_VERSION};`)
  }

  /** Open an explicitly configured release store without executing uploaded code.
   * @param config Cloud root, upload bounds and accepted plugins.
   * @returns A catalog whose close method must be awaited on shutdown.
   */
  static async open(config: MarketServerConfig): Promise<MuseMarketCatalog> {
    if (!isAbsolute(config.root) || !Number.isSafeInteger(config.maxReleases) || config.maxReleases < 1
      || !Number.isSafeInteger(config.maxActiveUploads) || config.maxActiveUploads < 1
      || Object.values(config.limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid market configuration')
    await mkdir(config.root, { recursive: true, mode: 0o700 })
    if ((await lstat(config.root)).isSymbolicLink()) throw new Error('Market root cannot be a link')
    await mkdir(join(config.root, 'blobs'), { recursive: true, mode: 0o700 })
    if ((await lstat(join(config.root, 'blobs'))).isSymbolicLink()) throw new Error('Market blobs cannot be a link')
    return new MuseMarketCatalog(config)
  }

  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new MarketError('closed', 503))
    const result = this.tail.then(operation)
    this.tail = result.catch(() => undefined)
    return result
  }

  /** Persist an administrator invitation to a creator or production team.
   * @param actor Authenticated administrator.
   * @param title Team display name.
   * @param accountId Account admitted as a publisher member.
   * @returns The team identifier.
   */
  invite(actor: MarketActor, title: string, accountId: string): Promise<string> {
    return this.serial(() => {
      if (!actor.admin) throw new MarketError('admin-required', 403)
      identity(accountId)
      if (!title.trim() || title.length > 100) throw new MarketError('invalid-publisher')
      const id = randomBytes(16).toString('hex')
      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.prepare('INSERT INTO publishers VALUES(?,?)').run(id, title.trim())
        this.database.prepare('INSERT INTO members VALUES(?,?)').run(id, accountId)
        this.database.exec('COMMIT')
      } catch (error) { this.database.exec('ROLLBACK'); throw error }
      return id
    })
  }

  /** List teams the current account can publish for.
   * @param actor Authenticated account.
   * @returns Team identifiers and display names.
   */
  publishers(actor: MarketActor): { id: string; title: string }[] {
    const rows = actor.admin ? this.database.prepare('SELECT id,title FROM publishers ORDER BY title').all()
      : this.database.prepare('SELECT p.id,p.title FROM publishers p JOIN members m ON m.publisherId=p.id WHERE m.accountId=? ORDER BY p.title').all(actor.id)
    return rows.map(row => ({ id: String(row.id), title: String(row.title) }))
  }

  private owns(actor: MarketActor, publisherId: string): boolean {
    return actor.admin || !!this.database.prepare('SELECT 1 FROM members WHERE publisherId=? AND accountId=?').get(publisherId, actor.id)
  }

  /** Read a release after visibility checks.
   * @param id Release identifier.
   * @param actor Authenticated account, or null for public browsing.
   * @returns Published metadata or the caller's private release.
   */
  get(id: string, actor: MarketActor | null): MarketRelease {
    identity(id)
    const row = this.database.prepare('SELECT r.*,p.title AS publisher FROM releases r JOIN publishers p ON p.id=r.publisherId WHERE r.id=?').get(id)
    if (!row || row.status !== 'published' && (!actor || !this.owns(actor, String(row.publisherId)))) throw new MarketError('not-found', 404)
    const release = rowRelease(row, this.config.allowedPlugins)
    if (release.manifest.kind !== 'skill') throw new MarketError('not-found', 404)
    return release
  }

  /** Search the public directory or the signed-in creator's releases.
   * @param actor Account used only when mine is true.
   * @param query Search text, content kind and creator-view switch.
   * @returns At most 100 matching releases; private drafts never enter public results.
   */
  list(actor: MarketActor | null, query: { q?: string; kind?: string; mine?: boolean }): MarketRelease[] {
    if (query.mine && !actor) throw new MarketError('login-required', 401)
    if ((query.q?.length ?? 0) > 200 || query.kind && query.kind !== 'skill') throw new MarketError('invalid-query')
    const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const conditions = ["json_extract(r.manifest,'$.kind')='skill'", query.mine ? actor?.admin ? '1' : 'EXISTS(SELECT 1 FROM members m WHERE m.publisherId=r.publisherId AND m.accountId=?)' : "r.status='published'"]
    const parameters: string[] = query.mine && actor && !actor.admin ? [actor.id] : []
    for (const word of words) {
      conditions.push("instr(lower(json_extract(r.manifest,'$.title')||' '||json_extract(r.manifest,'$.description')||' '||json_extract(r.manifest,'$.category')||' '||p.title),?)>0")
      parameters.push(word)
    }
    return this.database.prepare(`SELECT r.*,p.title AS publisher FROM releases r JOIN publishers p ON p.id=r.publisherId WHERE ${conditions.join(' AND ')} ORDER BY r.createdAt DESC,r.id LIMIT 100`)
      .all(...parameters).map(row => rowRelease(row, this.config.allowedPlugins))
  }

  /** Reserve bounded HTTP upload capacity before reading request bytes.
   * @param actor Authenticated creator.
   * @param publisherId Selected team from the request headers.
   * @returns Idempotent reservation release for response completion or failure.
   */
  reserveUpload(actor: MarketActor, publisherId: string): () => void {
    if (this.closed) throw new MarketError('closed', 503)
    identity(publisherId)
    if (!this.owns(actor, publisherId)) throw new MarketError('publisher-required', 403)
    if (this.uploading.has(actor.id) || this.uploading.size >= this.config.maxActiveUploads) throw new MarketError('upload-busy', 429)
    this.uploading.add(actor.id)
    let active = true
    return () => { if (active) { active = false; this.uploading.delete(actor.id) } }
  }

  /** Validate and store an immutable draft using an account-scoped idempotency key.
   * @param actor Authenticated creator.
   * @param publisherId Team that owns the release.
   * @param requestId Stable client upload request identifier.
   * @param archive Complete bounded archive bytes.
   * @returns Existing identical upload or the new draft.
   */
  upload(actor: MarketActor, publisherId: string, requestId: string, archive: Uint8Array): Promise<MarketRelease> {
    return this.serial(async () => {
      identity(publisherId)
      if (!this.owns(actor, publisherId)) throw new MarketError('publisher-required', 403)
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new MarketError('invalid-request-id')
      const sha256 = marketDigest(archive)
      const previous = this.database.prepare('SELECT id,sha256,publisherId FROM releases WHERE actorId=? AND requestId=?').get(actor.id, requestId)
      if (previous) {
        if (previous.sha256 !== sha256 || previous.publisherId !== publisherId) throw new MarketError('idempotency-conflict', 409)
        return this.get(String(previous.id), actor)
      }
      const { manifest } = readMarketPackage(archive, this.config.limits, this.config.allowedPlugins)
      if (manifest.kind !== 'skill') throw new MarketError('skill-only')
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM releases').get()?.count
      if (Number(count) >= this.config.maxReleases) throw new MarketError('catalog-full', 507)
      if (this.database.prepare('SELECT 1 FROM releases WHERE publisherId=? AND name=? AND version=?').get(publisherId, manifest.name, manifest.version)) throw new MarketError('version-exists', 409)
      const file = join(this.config.root, 'blobs', `${sha256}.zip`)
      try { await writeFile(file, archive, { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (marketDigest(await readFile(file)) !== sha256) throw new MarketError('corrupt-storage', 500)
      }
      const id = randomBytes(16).toString('hex')
      this.database.prepare(`INSERT INTO releases(id,publisherId,manifest,name,version,sha256,bytes,status,createdAt,actorId,requestId)
        VALUES(?,?,?,?,?,?,?,'draft',?,?,?)`).run(id, publisherId, JSON.stringify(manifest), manifest.name, manifest.version,
        sha256, archive.byteLength, new Date().toISOString(), actor.id, requestId)
      return this.get(id, actor)
    })
  }

  /** Submit, review or withdraw a release with revision fencing.
   * @param actor Authenticated creator or administrator.
   * @param id Release identifier.
   * @param revision Revision the caller reviewed.
   * @param action Requested state transition.
   * @param note Administrator's review reason.
   * @returns The committed release metadata.
   */
  transition(actor: MarketActor, id: string, revision: number, action: string, note: string): Promise<MarketRelease> {
    return this.serial(async () => {
      const release = this.get(id, actor)
      if (release.revision !== revision) throw new MarketError('revision-conflict', 409)
      if (typeof note !== 'string' || note.length > 2000) throw new MarketError('invalid-review')
      let status: MarketRelease['status']
      if (action === 'submit' && ['draft', 'rejected'].includes(release.status) && this.owns(actor, release.publisherId)) status = 'pending'
      else if (actor.admin && action === 'approve' && release.status === 'pending') status = 'published'
      else if (actor.admin && action === 'reject' && release.status === 'pending' && note.trim()) status = 'rejected'
      else if (action === 'withdraw' && release.status === 'published' && this.owns(actor, release.publisherId)) status = 'withdrawn'
      else throw new MarketError('invalid-transition', 409)
      if (status === 'published') await this.download(id, actor)
      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.prepare('UPDATE releases SET status=?,reviewNote=?,revision=revision+1 WHERE id=?').run(status, note, id)
        this.database.prepare('INSERT INTO reviews(releaseId,actorId,status,note,at) VALUES(?,?,?,?,?)').run(id, actor.id, status, note, new Date().toISOString())
        this.database.exec('COMMIT')
      } catch (error) { this.database.exec('ROLLBACK'); throw error }
      return this.get(id, actor)
    })
  }

  /** Download a visible release after checking its exact content digest.
   * @param id Release identifier.
   * @param actor Authenticated downloader or creator.
   * @returns Verified publication archive bytes.
   */
  async download(id: string, actor: MarketActor): Promise<Uint8Array> {
    const release = this.get(id, actor)
    const file = join(this.config.root, 'blobs', `${release.sha256}.zip`)
    if ((await lstat(file)).isSymbolicLink()) throw new MarketError('corrupt-storage', 500)
    const bytes = await readFile(file)
    if (marketDigest(bytes) !== release.sha256) throw new MarketError('corrupt-storage', 500)
    return bytes
  }

  /** Stop admission and await outstanding writes before closing SQLite. */
  async close(): Promise<void> {
    this.closed = true
    this.closing ??= this.tail.then(() => { this.database.close() })
    await this.closing
  }
}

/** Serve market APIs after gateway session and Origin validation.
 * @param catalog Open cloud catalog.
 * @param request Incoming gateway request with an undecoded body.
 * @param response Owned HTTP response.
 * @param actor Gateway-authenticated identity, never request JSON.
 * @param limits Request byte limits.
 * @returns Completion after the response has been written.
 */
export async function handleMarket(catalog: MuseMarketCatalog, request: IncomingMessage, response: ServerResponse,
  actor: MarketActor | null, limits: MarketLimits): Promise<void> {
  let releaseUpload: (() => void) | undefined
  const reply = (status: number, value: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    response.end(JSON.stringify(value))
  }
  try {
    const url = new URL(String(request.url), 'http://localhost')
    const path = url.pathname.replace(/^\/api\/market\/v1/, '')
    if (request.method === 'GET' && path === '/catalog') {
      reply(200, { items: catalog.list(actor, { q: url.searchParams.get('q') ?? '', kind: url.searchParams.get('kind') ?? '', mine: url.searchParams.get('mine') === 'true' }) }); return
    }
    if (request.method === 'GET' && /^\/releases\/[a-f0-9]+$/.test(path)) { reply(200, catalog.get(path.slice(releasePrefix.length), actor)); return }
    if (!actor) throw new MarketError('login-required', 401)
    if (request.method === 'GET' && path === '/me') { reply(200, { publishers: catalog.publishers(actor), admin: actor.admin }); return }
    if (request.method === 'GET' && /^\/releases\/[a-f0-9]+\/download$/.test(path)) {
      const id = path.slice(releasePrefix.length, -'/download'.length)
      const release = catalog.get(id, actor), bytes = await catalog.download(id, actor)
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': bytes.byteLength,
        'content-disposition': `attachment; filename="${release.manifest.name}-${release.manifest.version}.zip"`,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-content-sha256': release.sha256 })
      response.end(bytes); return
    }
    if (request.method !== 'POST') throw new MarketError('not-found', 404)
    const publisher = String(request.headers['x-market-publisher'] ?? '')
    if (path === '/uploads') releaseUpload = catalog.reserveUpload(actor, publisher)
    const maximum = path === '/uploads' ? limits.archiveBytes : 16384
    const chunks: Uint8Array[] = []; let size = 0
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const bytes = chunk as Uint8Array
      size += bytes.byteLength
      if (size > maximum) { request.resume(); throw new MarketError('request-too-large', 413) }
      chunks.push(bytes)
    }
    if (path === '/uploads') {
      const requestId = String(request.headers['idempotency-key'] ?? '')
      reply(201, await catalog.upload(actor, publisher, requestId, Buffer.concat(chunks))); return
    }
    let body: unknown
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new MarketError('invalid-json') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MarketError('invalid-json')
    const input = body as Record<string, unknown>
    if (path === '/publishers' && typeof input.title === 'string' && typeof input.accountId === 'string') {
      reply(201, { id: await catalog.invite(actor, input.title, input.accountId) }); return
    }
    if (/^\/releases\/[a-f0-9]+\/review$/.test(path) && Number.isSafeInteger(input.revision) && typeof input.action === 'string') {
      reply(200, await catalog.transition(actor, path.slice(releasePrefix.length, -'/review'.length), Number(input.revision), input.action, typeof input.note === 'string' ? input.note : '')); return
    }
    throw new MarketError('invalid-request')
  } catch (error) {
    reply(error instanceof MarketError ? error.status : 500, { error: error instanceof MarketError ? error.code : 'market-unavailable' })
  } finally { releaseUpload?.() }
}
