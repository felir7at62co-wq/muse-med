/** Local Skill publication preparation, import, verification and export; no activation or cloud access. */
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { isAbsolute } from 'node:path'
import { collectMarketSkill } from './author.ts'
import { MarketError, marketMetadata } from './format.ts'
import { MuseMarketLocal, type MarketLocalConfig } from './local.ts'
import { createMarketPackage } from './package.ts'
import type { MuseMarketInstallation, MarketLimits, MarketMetadata, MarketReleaseId } from './types.ts'

export type * from './types.ts'

/** Resolved local publication storage and size limits. */
export interface Config extends MarketLimits {
  /** Absolute private storage root. */
  readonly root: string
}

declare module '@deepseek-ai/cordis' {
  interface Context { museMarket: MuseMarket }
}

/** Local publication service; installing a package never registers or executes its Skill. */
export default class MuseMarket extends TypertRemoteService {
  static inject = ['skills']
  static Config = Schema.object({
    root: Schema.string().default(dshHomePath('muse-market')),
    archiveBytes: Schema.natural().min(1024).max(64 * 1024 * 1024).default(16 * 1024 * 1024),
    expandedBytes: Schema.natural().min(1024).max(256 * 1024 * 1024).default(64 * 1024 * 1024),
    fileCount: Schema.natural().min(2).max(4096).default(512),
    recordBytes: Schema.natural().min(1024).max(16 * 1024 * 1024).default(4 * 1024 * 1024),
  })
  private readonly local: MuseMarketLocal
  private operations: Promise<unknown> = Promise.resolve()
  private closing = false

  constructor(ctx: Context, private readonly config: Config) {
    if (!isAbsolute(config.root)) throw new MarketError('invalid-storage')
    super(ctx, 'museMarket')
    this.local = new MuseMarketLocal({ root: config.root, limits: config,
      beforeRemove: async (id) => { await ctx.serial('muse-market/before-remove', id) } })
    ctx.effect(() => async () => { this.closing = true; await this.operations })
  }

  async [Service.init](): Promise<void> { await this.local.ready() }

  /** Internal storage specification for co-located activation; not a Remote endpoint.
   * @returns Readonly resolved paths and bounds, without exposing archive contents.
   */
  publicationStorage(): MarketLocalConfig { return { root: this.config.root, limits: this.config } }

  private serial<T>(operation: () => Promise<T>, changed = false): Promise<T> {
    if (this.closing) return Promise.reject(new RemoteError('muse-market/operation-failed', 'Skill publication service is closing', { code: 'closing' }))
    const result = this.operations.then(operation).then((value) => {
      if (changed) {
        try { this.ctx.emit('muse-market/inventory-changed') }
        catch (error) { this.ctx.logger.warn('Market inventory observer failed', error) }
      }
      return value
    })
    this.operations = result.catch(() => undefined)
    return result.catch((error: unknown) => {
      throw new RemoteError('muse-market/operation-failed', 'Skill publication operation failed', {
        code: error instanceof MarketError ? error.code : 'storage-unavailable',
      })
    })
  }

  /** List current authoring candidates without reading or uploading resource directories.
   * @returns Discovered metadata and whether every provider completed this observation.
   */
  @Remote('sources')
  async sources(): Promise<{ skills: { name: string; description: string; whenToUse?: string }[]; complete: boolean }> {
    return await this.serial(async () => {
      const snapshot = await this.ctx.skills.snapshot()
      return { skills: snapshot.skills.map(skill => ({ name: skill.name, description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }) })), complete: snapshot.complete }
    })
  }

  /** Prepare one selected local Skill as a disabled publication without uploading it.
   * @param metadata - Explicit author metadata.
   * @param skillName - Exact registry invocation name.
   * @returns Verified disabled installation containing the selected complete bundle.
   */
  @Remote('prepare')
  async prepare(metadata: MarketMetadata, skillName: string): Promise<MuseMarketInstallation> {
    return await this.serial(async () => {
      const info = marketMetadata(metadata), skill = await this.ctx.skills.get(skillName)
      if (!skill) throw new MarketError('missing-skill')
      const files = await collectMarketSkill(skill, this.config)
      const archive = createMarketPackage({ ...info, formatVersion: 1, kind: 'skill',
        skills: [{ name: skill.name, path: `skills/${skill.name}/SKILL.md` }] }, files, this.config)
      return await this.local.install(archive)
    }, true)
  }

  /** Import a user-selected publication without activation or network access.
   * @param base64 - Complete, canonical base64 ZIP bytes.
   * @returns Matching installation or a newly committed disabled release.
   */
  @Remote('importPackage')
  async importPackage(base64: string): Promise<MuseMarketInstallation> {
    return await this.serial(async () => {
      if (base64.length > Math.ceil(this.config.archiveBytes / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/u.test(base64)) throw new MarketError('invalid-archive')
      const archive = Buffer.from(base64, 'base64')
      if (archive.toString('base64') !== base64) throw new MarketError('invalid-archive')
      return await this.local.install(archive)
    }, true)
  }

  /** List retained publication records; none is activated by this service.
   * @returns Validated disabled local installations.
   */
  @Remote('installed')
  async installed(): Promise<MuseMarketInstallation[]> { return await this.serial(() => this.local.list()) }

  /** Export original package bytes after verifying every extracted resource.
   * @param id - Exact installed release identity.
   * @returns Portable filename and complete canonical base64 ZIP.
   */
  @Remote('exportPackage')
  async exportPackage(id: MarketReleaseId): Promise<{ name: string; base64: string }> {
    return await this.serial(async () => {
      const item = (await this.local.list()).find(row => row.release.id === id)
      if (!item) throw new MarketError('not-installed')
      const archive = await this.local.verify(item.release)
      return { name: `${item.release.manifest.name}-${item.release.manifest.version}.zip`, base64: archive.toString('base64') }
    })
  }

  /** Remove a disabled publication record without deleting reusable archive bytes.
   * @param id - Exact installed release identity.
   */
  @Remote('removePackage')
  async removePackage(id: MarketReleaseId): Promise<void> { await this.serial(() => this.local.remove(id), true) }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'muse-market/operation-failed': { readonly code: string }
  }
}
