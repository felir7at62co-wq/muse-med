/** Invitation-only immutable Skill archives and revision-fenced cloud moderation. */
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, unlink, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MarketError, marketRecord } from './format.ts'
import { marketDigest, readMarketPackage } from './package.ts'
import { MarketCloudError, parseMarketAccountId, parseMarketPublication, parseMarketPublicationId,
  parseMarketPublisherId, parseMarketUploadRequestId } from './cloud-protocol.ts'
import type { MarketActor, MarketAccountId, MarketIdentity, MarketPublication, MarketPublicationId,
  MarketPublisherId, MarketReviewAction, MarketUploadRequestId } from './cloud-protocol.ts'
import type { MarketLimits, MarketManifest } from './types.ts'

const SCHEMA_VERSION = 1
const prefix = '/api/market/v1'

/** Resolved server storage, admission and carrier budgets. */
export interface MarketServerConfig {
  readonly root: string
  readonly limits: MarketLimits
  readonly maxReleases: number
  readonly maxActiveUploads: number
  readonly jsonRequestBytes: number
  readonly jsonResponseBytes: number
  readonly catalogLimit: number
}

function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0 }
function unchanged(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}
function failure(code: string, status = 500): never { throw new MarketCloudError(code, status) }
function rawManifest(row: Record<string, unknown>, limits: MarketLimits): unknown {
  if (typeof row.manifest !== 'string' || Buffer.byteLength(row.manifest) > limits.recordBytes) failure('corrupt-storage')
  try { return JSON.parse(row.manifest) }
  catch (error) { throw new MarketCloudError('corrupt-storage', 500, { cause: error }) }
}

/** Cloud catalog; the owning profile authenticates actor assertions and disposes admission. */
export class MuseMarketCatalog {
  private readonly database: DatabaseSync
  private tail: Promise<unknown> = Promise.resolve()
  private readonly readers = new Set<Promise<Uint8Array>>()
  private readonly uploading = new Set<MarketAccountId>()
  private closed = false
  private closing: Promise<void> | undefined

  private constructor(private readonly config: MarketServerConfig) {
    this.database = new DatabaseSync(join(config.root, 'market.sqlite'))
    try {
      const version = this.database.prepare('PRAGMA user_version').get()?.user_version
      if (version !== 0 && version !== SCHEMA_VERSION) throw new MarketCloudError('unsupported-schema', 500)
      this.database.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS publishers(id TEXT PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS members(publisherId TEXT NOT NULL, accountId TEXT NOT NULL, PRIMARY KEY(publisherId,accountId));
        CREATE TABLE IF NOT EXISTS releases(
          id TEXT PRIMARY KEY,publisherId TEXT NOT NULL,manifest TEXT NOT NULL,name TEXT NOT NULL,version TEXT NOT NULL,
          sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,status TEXT NOT NULL,reviewNote TEXT NOT NULL DEFAULT '',
          revision INTEGER NOT NULL DEFAULT 1,createdAt TEXT NOT NULL,actorId TEXT NOT NULL,requestId TEXT NOT NULL,
          UNIQUE(publisherId,name,version),UNIQUE(actorId,requestId));
        CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY,releaseId TEXT NOT NULL,actorId TEXT NOT NULL,
          status TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);
        PRAGMA user_version=${SCHEMA_VERSION};`)
    } catch (error) { this.database.close(); throw error }
  }

  /** Open private storage without executing uploaded resources.
   * @param config - Resolved deployment paths and budgets.
   * @returns A catalog whose close operation is awaited by its owner.
   */
  static async open(config: MarketServerConfig): Promise<MuseMarketCatalog> {
    if (!isAbsolute(config.root) || !positive(config.maxReleases) || !positive(config.maxActiveUploads)
      || !positive(config.jsonRequestBytes) || !positive(config.jsonResponseBytes)
      || !positive(config.catalogLimit) || config.catalogLimit > 100
      || [config.limits.archiveBytes, config.limits.expandedBytes, config.limits.fileCount, config.limits.recordBytes]
        .some(value => !positive(value))) failure('invalid-policy', 400)
    await mkdir(config.root, { recursive: true, mode: 0o700 })
    if (!(await lstat(config.root)).isDirectory() || (await lstat(config.root)).isSymbolicLink()) failure('unsafe-storage')
    const blobs = join(config.root, 'blobs')
    await mkdir(blobs, { recursive: true, mode: 0o700 })
    if (!(await lstat(blobs)).isDirectory() || (await lstat(blobs)).isSymbolicLink()) failure('unsafe-storage')
    for (const suffix of ['', '-wal', '-shm']) {
      try { if (!(await lstat(join(config.root, 'market.sqlite' + suffix))).isFile()) failure('unsafe-storage') }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    }
    return new MuseMarketCatalog(config)
  }

  private admit(): void { if (this.closed) failure('closed', 503) }
  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new MarketCloudError('closed', 503))
    const result = this.tail.then(operation)
    this.tail = result.catch(() => undefined)
    return result
  }
  private owns(actor: MarketActor, publisherId: MarketPublisherId): boolean {
    if (this.database.prepare('SELECT 1 FROM publishers WHERE id=?').get(publisherId) === undefined) return false
    return actor.admin || this.database.prepare('SELECT 1 FROM members WHERE publisherId=? AND accountId=?').get(publisherId, actor.id) !== undefined
  }
  private publication(row: Record<string, unknown>): MarketPublication | undefined {
    const manifest = rawManifest(row, this.config.limits)
    if (marketRecord(manifest) && manifest.kind === 'bot') return undefined
    try {
      parseMarketAccountId(row.actorId); parseMarketUploadRequestId(row.requestId)
      const publication = parseMarketPublication({ id: row.id, publisherId: row.publisherId, publisher: row.publisher, manifest,
        sha256: row.sha256, bytes: row.bytes, status: row.status, reviewNote: row.reviewNote,
        revision: row.revision, createdAt: row.createdAt }, this.config.limits)
      if (row.name !== publication.manifest.name || row.version !== publication.manifest.version) failure('corrupt-storage')
      return publication
    } catch (error) { throw new MarketCloudError('corrupt-storage', 500, { cause: error }) }
  }
  private read(id: MarketPublicationId, actor: MarketActor | null): MarketPublication {
    const row = this.database.prepare('SELECT r.*,p.title AS publisher FROM releases r LEFT JOIN publishers p ON p.id=r.publisherId WHERE r.id=?').get(id)
    if (row === undefined) failure('not-found', 404)
    if (row.status !== 'published' && (actor === null || !actor.admin
      && (typeof row.publisherId !== 'string' || !/^[a-f0-9]{32}$/u.test(row.publisherId)
        || !this.owns(actor, parseMarketPublisherId(row.publisherId))))) failure('not-found', 404)
    const publication = this.publication(row)
    if (publication === undefined) failure('not-found', 404)
    return publication
  }

  private nextStatus(actor: MarketActor, publication: MarketPublication, revision: number,
    action: MarketReviewAction, note: string): MarketPublication['status'] {
    if (publication.revision !== revision) failure('revision-conflict', 409)
    if ((action === 'approve' || action === 'reject') && !actor.admin) failure('admin-required', 403)
    if (action === 'submit' && (publication.status === 'draft' || publication.status === 'rejected') && this.owns(actor, publication.publisherId)) return 'pending'
    if (actor.admin && action === 'approve' && publication.status === 'pending') return 'published'
    if (actor.admin && action === 'reject' && publication.status === 'pending' && note.trim().length > 0) return 'rejected'
    if (action === 'withdraw' && publication.status === 'published' && this.owns(actor, publication.publisherId)) return 'withdrawn'
    return failure('invalid-transition', 409)
  }

  /** Invite an account already admitted by the account gateway.
   * @param actor - Current administrator assertion.
   * @param title - Team display name.
   * @param accountId - Existing enabled account selected by the gateway.
   * @returns The new publishing-team identity.
   */
  invite(actor: MarketActor, title: string, accountId: MarketAccountId): Promise<MarketPublisherId> {
    return this.serial(() => {
      if (!actor.admin) failure('admin-required', 403)
      if (title.trim().length === 0 || title.length > 100) failure('invalid-publisher', 400)
      const id = parseMarketPublisherId(randomBytes(16).toString('hex'))
      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.prepare('INSERT INTO publishers VALUES(?,?)').run(id, title.trim())
        this.database.prepare('INSERT INTO members VALUES(?,?)').run(id, accountId)
        this.database.exec('COMMIT')
      } catch (error) { this.database.exec('ROLLBACK'); throw error }
      return id
    })
  }

  /** Read the caller's current publishing memberships.
   * @param actor - Current account assertion.
   * @returns Team metadata and administrator status.
   */
  identity(actor: MarketActor): MarketIdentity {
    this.admit()
    const rows = actor.admin ? this.database.prepare('SELECT id,title FROM publishers ORDER BY title,id').all()
      : this.database.prepare('SELECT p.id,p.title FROM publishers p JOIN members m ON m.publisherId=p.id WHERE m.accountId=? ORDER BY p.title,p.id').all(actor.id)
    return { publishers: rows.map((row) => {
      if (typeof row.title !== 'string' || row.title.trim().length === 0 || row.title.length > 100) failure('corrupt-storage')
      return { id: parseMarketPublisherId(row.id), title: row.title }
    }), admin: actor.admin }
  }

  /** Read visible metadata, refusing retired Bot rows before strict Skill parsing.
   * @param id - Cloud publication identity.
   * @param actor - Current account assertion, or null for public browsing.
   * @returns A published record or the owner's private publication.
   */
  get(id: MarketPublicationId, actor: MarketActor | null): MarketPublication { this.admit(); return this.read(id, actor) }

  /** Search a bounded directory; this array does not claim complete enumeration.
   * @param actor - Current assertion, required for the private creator view.
   * @param query - Search text and whether to include owned private publications.
   * @returns At most the configured catalogLimit after retired rows are excluded.
   */
  list(actor: MarketActor | null, query: { readonly q: string; readonly mine: boolean }): MarketPublication[] {
    this.admit()
    if (query.mine && actor === null) failure('login-required', 401)
    if (query.q.length > 200) failure('invalid-query', 400)
    const words = query.q.toLowerCase().split(/\s+/u).filter(Boolean)
    const condition = query.mine ? actor?.admin ? '1' : 'EXISTS(SELECT 1 FROM members m WHERE m.publisherId=r.publisherId AND m.accountId=?)'
      : "r.status='published'"
    const parameters = query.mine && actor !== null && !actor.admin ? [actor.id] : []
    const rows = this.database.prepare(`SELECT r.*,p.title AS publisher FROM releases r LEFT JOIN publishers p ON p.id=r.publisherId WHERE ${condition} ORDER BY r.createdAt DESC,r.id`)
      .iterate(...parameters)
    const publications: MarketPublication[] = []
    for (const row of rows) {
      const publication = this.publication(row)
      if (publication === undefined) continue
      const text = [publication.id, publication.manifest.name, publication.manifest.title,
        ...publication.manifest.skills.map(skill => skill.name), publication.manifest.description,
        publication.manifest.category, publication.publisher].join(' ').toLowerCase()
      if (!words.every(word => text.includes(word))) continue
      publications.push(publication)
      if (publications.length === this.config.catalogLimit) break
    }
    return publications
  }

  /** Reserve upload-body capacity before consuming bytes.
   * @param actor - Current invited publisher assertion.
   * @param publisherId - Team selected by the request.
   * @returns An idempotent release owned by the complete HTTP operation.
   */
  reserveUpload(actor: MarketActor, publisherId: MarketPublisherId): () => void {
    this.admit()
    if (!this.owns(actor, publisherId)) failure('publisher-required', 403)
    if (this.uploading.has(actor.id) || this.uploading.size >= this.config.maxActiveUploads) failure('upload-busy', 429)
    this.uploading.add(actor.id)
    let active = true
    return () => { if (active) { active = false; this.uploading.delete(actor.id) } }
  }

  private async archive(publication: Pick<MarketPublication, 'sha256' | 'bytes' | 'manifest'>): Promise<Uint8Array> {
    const file = join(this.config.root, 'blobs', publication.sha256 + '.zip')
    try {
      const before = await lstat(file)
      if (!before.isFile() || before.size !== publication.bytes || before.size > this.config.limits.archiveBytes) failure('corrupt-storage')
      const handle = await open(file, 'r')
      let bytes: Uint8Array
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || !unchanged(before, opened)) failure('corrupt-storage')
        const buffer = Buffer.alloc(publication.bytes + 1)
        let length = 0
        while (length < buffer.byteLength) {
          const part = await handle.read(buffer, length, buffer.byteLength - length, null)
          if (part.bytesRead === 0) break
          length += part.bytesRead
        }
        if (length !== publication.bytes || !unchanged(opened, await handle.stat())) failure('corrupt-storage')
        bytes = buffer.subarray(0, length)
      } finally { await handle.close() }
      const after = await lstat(file)
      if (!after.isFile() || !unchanged(before, after) || marketDigest(bytes) !== publication.sha256) failure('corrupt-storage')
      if (!isDeepStrictEqual(readMarketPackage(bytes, this.config.limits).manifest, publication.manifest)) failure('corrupt-storage')
      return bytes
    } catch (error) {
      if (error instanceof MarketCloudError) throw error
      throw new MarketCloudError('corrupt-storage', 500, { cause: error })
    }
  }

  private async retain(archive: Uint8Array, sha256: string, manifest: MarketManifest): Promise<void> {
    const temporary = join(this.config.root, 'blobs', `.upload-${randomBytes(16).toString('hex')}.tmp`)
    await writeFile(temporary, archive, { flag: 'wx', mode: 0o600, flush: true })
    try {
      try { await link(temporary, join(this.config.root, 'blobs', sha256 + '.zip')) }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
    } finally { await unlink(temporary) }
    await this.archive({ sha256, bytes: archive.byteLength, manifest })
  }

  /** Retain the original archive as a private draft using an account-scoped key.
   * @param actor - Current publisher assertion.
   * @param publisherId - Team owning the publication.
   * @param requestId - Unchanged original attempt key.
   * @param archive - Complete explicitly uploaded bytes.
   * @returns The same existing publication or a newly committed private draft.
   */
  upload(actor: MarketActor, publisherId: MarketPublisherId,
    requestId: MarketUploadRequestId, archive: Uint8Array): Promise<MarketPublication> {
    return this.serial(async () => {
      if (!this.owns(actor, publisherId)) failure('publisher-required', 403)
      const sha256 = marketDigest(archive)
      const prior = this.database.prepare('SELECT id,sha256,publisherId FROM releases WHERE actorId=? AND requestId=?').get(actor.id, requestId)
      if (prior !== undefined) {
        if (prior.sha256 !== sha256 || prior.publisherId !== publisherId) failure('idempotency-conflict', 409)
        const publication = this.read(parseMarketPublicationId(prior.id), actor)
        await this.archive(publication)
        return publication
      }
      const { manifest } = readMarketPackage(archive, this.config.limits)
      const countBefore = this.database.prepare('SELECT COUNT(*) AS count FROM releases').get()?.count
      if (typeof countBefore !== 'number' || countBefore >= this.config.maxReleases) failure('catalog-full', 507)
      if (this.database.prepare('SELECT 1 FROM releases WHERE publisherId=? AND name=? AND version=?')
        .get(publisherId, manifest.name, manifest.version) !== undefined) failure('version-exists', 409)
      await this.retain(archive, sha256, manifest)
      this.database.exec('BEGIN IMMEDIATE')
      let committedId: MarketPublicationId
      try {
        const raced = this.database.prepare('SELECT id,sha256,publisherId FROM releases WHERE actorId=? AND requestId=?').get(actor.id, requestId)
        if (raced !== undefined) {
          if (raced.sha256 !== sha256 || raced.publisherId !== publisherId) failure('idempotency-conflict', 409)
          committedId = parseMarketPublicationId(raced.id)
        } else {
          const count = this.database.prepare('SELECT COUNT(*) AS count FROM releases').get()?.count
          if (typeof count !== 'number' || count >= this.config.maxReleases) failure('catalog-full', 507)
          if (this.database.prepare('SELECT 1 FROM releases WHERE publisherId=? AND name=? AND version=?')
            .get(publisherId, manifest.name, manifest.version) !== undefined) failure('version-exists', 409)
          committedId = parseMarketPublicationId(randomBytes(16).toString('hex'))
          this.database.prepare(`INSERT INTO releases(id,publisherId,manifest,name,version,sha256,bytes,status,createdAt,actorId,requestId)
            VALUES(?,?,?,?,?,?,?,'draft',?,?,?)`).run(committedId, publisherId, JSON.stringify(manifest), manifest.name, manifest.version,
            sha256, archive.byteLength, new Date().toISOString(), actor.id, requestId)
        }
        this.database.exec('COMMIT')
      } catch (error) { this.database.exec('ROLLBACK'); throw error }
      return this.read(committedId, actor)
    })
  }

  /** Commit one explicitly reviewed moderation transition with cross-connection revision fencing.
   * @param actor - Current owner or administrator assertion.
   * @param id - Original cloud publication identity.
   * @param revision - Exact revision inspected by the caller.
   * @param action - Explicit state transition.
   * @param note - Review note; rejection requires a nonblank reason.
   * @returns The committed publication without any automatic resubmission.
   */
  transition(actor: MarketActor, id: MarketPublicationId,
    revision: number, action: MarketReviewAction, note: string): Promise<MarketPublication> {
    return this.serial(async () => {
      if (!positive(revision) || note.length > 2000) failure('invalid-review', 400)
      const inspected = this.read(id, actor)
      this.nextStatus(actor, inspected, revision, action, note)
      if (action === 'approve') await this.archive(inspected)
      this.database.exec('BEGIN IMMEDIATE')
      try {
        const publication = this.read(id, actor)
        const status = this.nextStatus(actor, publication, revision, action, note)
        const changed = this.database.prepare('UPDATE releases SET status=?,reviewNote=?,revision=revision+1 WHERE id=? AND revision=?')
          .run(status, note, id, revision)
        if (changed.changes !== 1) failure('revision-conflict', 409)
        this.database.prepare('INSERT INTO reviews(releaseId,actorId,status,note,at) VALUES(?,?,?,?,?)')
          .run(id, actor.id, status, note, new Date().toISOString())
        this.database.exec('COMMIT')
      } catch (error) { this.database.exec('ROLLBACK'); throw error }
      return this.read(id, actor)
    })
  }

  /** Read exact visible archive bytes, including its advertised manifest and length.
   * @param id - Cloud publication identity.
   * @param actor - Current authenticated downloader assertion.
   * @returns Verified complete original ZIP bytes.
   */
  async download(id: MarketPublicationId, actor: MarketActor): Promise<Uint8Array> {
    this.admit()
    const work = this.archive(this.read(id, actor))
    this.readers.add(work)
    try { return await work } finally { this.readers.delete(work) }
  }

  /** Stop new admission and await accepted writes and archive readers before closing SQLite. */
  async close(): Promise<void> {
    this.closed = true
    this.closing ??= Promise.allSettled([this.tail, ...this.readers]).then(() => { this.database.close() })
    await this.closing
  }
}

/** Serve APIs only after the carrier validates the shared secret and actor assertion.
 * @param catalog - Open cloud catalog.
 * @param request - Owned undecoded HTTP request.
 * @param response - Owned HTTP response.
 * @param actor - Gateway assertion or null for public reads.
 * @param config - Explicit request and response budgets.
 * @returns Completion after response or disconnected-body cleanup.
 */
export async function handleMarket(catalog: MuseMarketCatalog, request: IncomingMessage, response: ServerResponse,
  actor: MarketActor | null, config: MarketServerConfig): Promise<void> {
  let release: (() => void) | undefined
  const reply = (status: number, value: unknown): void => {
    if (response.destroyed || response.writableEnded) return
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > config.jsonResponseBytes) failure('response-too-large', 507)
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    response.end(text)
  }
  try {
    const target = request.url
    if (target === undefined || !target.startsWith(prefix + '/') || /[\\#\r\n\0]/u.test(target)) failure('invalid-request', 400)
    const url = new URL(target, 'http://127.0.0.1')
    if (!url.pathname.startsWith(prefix + '/')) failure('invalid-request', 400)
    const path = url.pathname.slice(prefix.length)
    if (request.method === 'GET' && path === '/catalog') {
      const kind = url.searchParams.get('kind')
      if (kind !== null && kind !== '' && kind !== 'skill') failure('skill-only', 400)
      const mine = url.searchParams.get('mine')
      if (mine !== null && mine !== 'true' && mine !== 'false') failure('invalid-query', 400)
      reply(200, { items: catalog.list(actor, { q: url.searchParams.get('q') ?? '', mine: mine === 'true' }) }); return
    }
    const match = /^\/releases\/([a-f0-9]{32})(\/download|\/review)?$/u.exec(path)
    const id = match === null ? undefined : parseMarketPublicationId(match[1])
    if (request.method === 'GET' && id !== undefined && match?.[2] === undefined) { reply(200, catalog.get(id, actor)); return }
    if (actor === null) failure('login-required', 401)
    if (request.method === 'GET' && path === '/me') { reply(200, catalog.identity(actor)); return }
    if (request.method === 'GET' && id !== undefined && match?.[2] === '/download') {
      const publication = catalog.get(id, actor), bytes = await catalog.download(id, actor)
      if (response.destroyed || response.writableEnded) return
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': bytes.byteLength,
        'content-disposition': `attachment; filename="${publication.manifest.name}-${publication.manifest.version}.zip"`,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-content-sha256': publication.sha256 })
      response.end(bytes); return
    }
    if (request.method !== 'POST') failure('not-found', 404)
    const publisher = path === '/uploads' ? parseMarketPublisherId(request.headers['x-market-publisher']) : undefined
    if (publisher !== undefined) release = catalog.reserveUpload(actor, publisher)
    const maximum = path === '/uploads' ? config.limits.archiveBytes : config.jsonRequestBytes
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const input: unknown = chunk
      const bytes = Buffer.isBuffer(input) ? input : typeof input === 'string' ? Buffer.from(input)
        : input instanceof Uint8Array ? Buffer.from(input) : failure('invalid-request', 400)
      length += bytes.byteLength
      if (length > maximum) { request.resume(); failure('request-too-large', 413) }
      chunks.push(bytes)
    }
    if (publisher !== undefined) {
      const key = parseMarketUploadRequestId(request.headers['idempotency-key'])
      reply(201, await catalog.upload(actor, publisher, key, Buffer.concat(chunks))); return
    }
    let body: unknown
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch (error) { throw new MarketCloudError('invalid-json', 400, { cause: error }) }
    if (!marketRecord(body)) failure('invalid-request', 400)
    if (path === '/publishers' && typeof body.title === 'string' && Object.keys(body).length === 2) {
      reply(201, { id: await catalog.invite(actor, body.title, parseMarketAccountId(body.accountId)) }); return
    }
    if (id !== undefined && match?.[2] === '/review' && Object.keys(body).length === 3
      && typeof body.revision === 'number' && positive(body.revision) && typeof body.note === 'string'
      && (body.action === 'submit' || body.action === 'approve' || body.action === 'reject' || body.action === 'withdraw')) {
      reply(200, await catalog.transition(actor, id, body.revision, body.action, body.note)); return
    }
    failure('invalid-request', 400)
  } catch (error) {
    if (response.destroyed || response.writableEnded) return
    if (response.headersSent) { response.destroy(); return }
    const status = error instanceof MarketCloudError ? error.status : error instanceof MarketError ? 400 : 500
    const code = error instanceof MarketCloudError || error instanceof MarketError ? error.code : 'market-unavailable'
    reply(status, { error: code })
  } finally { release?.() }
}
