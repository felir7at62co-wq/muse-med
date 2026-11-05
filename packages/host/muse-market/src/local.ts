/** Immutable publication files and a locked local installation ledger. */
import { readFile, writeFile, mkdir, lstat, rename, mkdtemp, rm } from 'node:fs/promises'
import { join, dirname, isAbsolute } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { MarketError, marketDigest, marketRelease, readMarketPackage } from './package.ts'
import { marketLegacyId, marketRecord } from './format.ts'
import type { MarketInstallation, MarketLimits, MarketRelease } from './types.ts'

interface LocalState {
  version: 1
  installations: MarketInstallation[]
  references: Record<string, string[]>
}

/** Explicit paths and limits for one Muse runtime. */
export interface MarketLocalConfig {
  readonly root: string
  readonly limits: MarketLimits
  readonly allowedPlugins: readonly string[]
}

/** One local runtime's verified release files; downloads do not activate code. */
export class MuseMarketLocal {
  private readonly ledger: string
  constructor(readonly config: MarketLocalConfig) {
    if (!isAbsolute(config.root)) throw new Error('Market root must be absolute')
    this.ledger = join(config.root, 'installations.json')
  }

  /** Create private storage directories without following an existing root link. */
  async ready(): Promise<void> {
    await mkdir(this.config.root, { recursive: true, mode: 0o700 })
    if ((await lstat(this.config.root)).isSymbolicLink()) throw new MarketError('invalid-storage')
    await mkdir(join(this.config.root, 'packages'), { recursive: true, mode: 0o700 })
    if ((await lstat(join(this.config.root, 'packages'))).isSymbolicLink()) throw new MarketError('invalid-storage')
  }

  private async state(): Promise<LocalState> {
    let value: unknown
    try { value = JSON.parse(await readFile(this.ledger, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, installations: [], references: {} }
      throw error
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MarketError('invalid-ledger')
    const record = value as Record<string, unknown>
    if (record.version !== 1 || !Array.isArray(record.installations) || !record.references || typeof record.references !== 'object' || Array.isArray(record.references)) throw new MarketError('invalid-ledger')
    const installationRows: unknown[] = record.installations
    const installations = installationRows.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof (item as Record<string, unknown>).enabled !== 'boolean') throw new MarketError('invalid-ledger')
      const row = item as Record<string, unknown>
      const release = marketRelease(row.release, this.config.allowedPlugins)
      const source = row.legacySource
      if (source === undefined) return { release, enabled: row.enabled as boolean }
      if (!marketRecord(source) || !marketLegacyId(source.id)
        || !source.id.startsWith(`muse/${release.manifest.kind}s/`) || typeof source.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(source.sha256) || source.sha256 !== release.id) throw new MarketError('invalid-ledger')
      return { release, enabled: row.enabled as boolean, legacySource: { id: source.id, sha256: source.sha256 } }
    })
    if (new Set(installations.map(item => item.release.id)).size !== installations.length) throw new MarketError('invalid-ledger')
    const references: Record<string, string[]> = {}
    for (const [id, releases] of Object.entries(record.references as Record<string, unknown>)) {
      const releaseRows: unknown[] | undefined = Array.isArray(releases) ? releases : undefined
      if (!releaseRows || !releaseRows.every(release => typeof release === 'string' && installations.some(item => item.release.id === release))) throw new MarketError('invalid-ledger')
      references[id] = releaseRows as string[]
    }
    return { version: 1, installations, references }
  }

  private async update<T>(operation: (state: LocalState) => T | Promise<T>): Promise<T> {
    return await withFileLock(this.ledger, async () => {
      const state = await this.state()
      const result = await operation(state)
      await writeFileAtomic(this.ledger, JSON.stringify(state) + '\n', { mode: 0o600, dirMode: 0o700 })
      return result
    })
  }

  /** Read installed releases without loading their plugins.
   * @returns Current downloaded releases and independent enablement state.
   */
  async list(): Promise<MarketInstallation[]> { return (await this.state()).installations }

  /** Read releases retained for an existing session.
   * @param sessionId Durable session identity.
   * @returns Exact retained releases, or undefined before the session's first binding.
   */
  async binding(sessionId: string): Promise<MarketRelease[] | undefined> {
    const state = await this.state()
    const ids = state.references[sessionId]
    return ids === undefined ? undefined : state.installations.filter(item => ids.includes(item.release.id)).map(item => item.release)
  }

  /** Locate a release's immutable extracted resource directory.
   * @param release Release metadata.
   * @returns Native package directory beneath this runtime's storage.
   */
  directory(release: MarketRelease): string { return join(this.config.root, 'packages', release.sha256) }

  /** Check archive and extracted files before use, detecting edits and links.
   * @param release Installed release.
   * @returns The verified cached publication bytes.
   */
  async verify(release: MarketRelease): Promise<Uint8Array> {
    const root = this.directory(release)
    if ((await lstat(root)).isSymbolicLink()) throw new MarketError('modified-installation')
    const archive = await readFile(join(root, 'publication.zip'))
    if (marketDigest(archive) !== release.sha256 || archive.byteLength !== release.bytes) throw new MarketError('modified-installation')
    const parsed = readMarketPackage(archive, this.config.limits, this.config.allowedPlugins)
    if (JSON.stringify(parsed.manifest) !== JSON.stringify(release.manifest)) throw new MarketError('modified-installation')
    for (const [path, bytes] of Object.entries(parsed.files)) {
      const full = join(root, ...path.split('/'))
      let current = root
      for (const component of path.split('/')) {
        current = join(current, component)
        if ((await lstat(current)).isSymbolicLink()) throw new MarketError('modified-installation')
      }
      if (marketDigest(await readFile(full)) !== marketDigest(bytes)) throw new MarketError('modified-installation')
    }
    return archive
  }

  /** Store a verified publication without registering or enabling it.
   * @param release Cloud or local-import metadata.
   * @param archive Exact publication bytes.
   * @param source Original catalog identity for a conversion, or `zip-import` to reuse a matching cloud installation.
   * @returns The existing verified installation, or a new disabled installation.
   */
  async install(release: MarketRelease, archive: Uint8Array, source?: MarketInstallation['legacySource'] | 'zip-import'): Promise<MarketInstallation> {
    if (marketDigest(archive) !== release.sha256 || archive.byteLength !== release.bytes) throw new MarketError('digest-mismatch')
    const parsed = readMarketPackage(archive, this.config.limits, this.config.allowedPlugins)
    if (JSON.stringify(parsed.manifest) !== JSON.stringify(release.manifest)) throw new MarketError('manifest-mismatch')
    const legacySource = source === 'zip-import' ? undefined : source
    return await this.update(async (state) => {
      const cloudMatch = source === 'zip-import' ? state.installations.find(item => !item.legacySource
        && item.release.id !== item.release.sha256 && item.release.sha256 === release.sha256
        && item.release.bytes === release.bytes) : undefined
      const old = cloudMatch ?? state.installations.find(item => item.release.id === release.id)
      if (old) {
        if (old.release.sha256 !== release.sha256 || old.legacySource?.id !== legacySource?.id
          || old.legacySource?.sha256 !== legacySource?.sha256) throw new MarketError('release-conflict', 409)
        await this.verify(old.release); return old
      }
      const destination = this.directory(release)
      try { await lstat(destination) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const staging = await mkdtemp(join(this.config.root, '.pending-'))
        try {
          await writeFile(join(staging, 'publication.zip'), archive, { flag: 'wx', mode: 0o600 })
          for (const [path, bytes] of Object.entries(parsed.files)) {
            const file = join(staging, ...path.split('/'))
            await mkdir(dirname(file), { recursive: true, mode: 0o700 })
            await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
          }
          await rename(staging, destination)
        } catch (failure) { await rm(staging, { recursive: true, force: true }); throw failure }
      }
      await this.verify(release)
      const installed = { release, enabled: false, ...(legacySource === undefined ? {} : { legacySource }) }
      state.installations.push(installed)
      return installed
    })
  }

  /** Persist an explicit runtime enablement choice.
   * @param id Installed release identity.
   * @param enabled Requested enablement.
   * @returns Committed installation metadata.
   */
  async enable(id: string, enabled: boolean): Promise<MarketInstallation> {
    return await this.update(async (state) => {
      const index = state.installations.findIndex(item => item.release.id === id)
      const old = state.installations[index]
      if (!old) throw new MarketError('not-installed', 404)
      if (enabled) {
        await this.verify(old.release)
        const skillName = old.release.manifest.skills[0]?.name
        if (old.release.manifest.kind === 'skill' && state.installations.some(item => item.enabled && item.release.id !== id
          && item.release.manifest.kind === 'skill' && item.release.manifest.skills[0]?.name === skillName)) throw new MarketError('skill-name-conflict', 409)
      } else if (old.release.manifest.kind === 'bot' && Object.values(state.references).some(ids => ids.includes(id))) {
        throw new MarketError('release-in-use', 409)
      }
      const item = { ...old, enabled }; state.installations[index] = item
      return item
    })
  }

  /** Replace the complete set of releases retained for a session's recovery.
   * @param sessionId Durable session identity.
   * @param ids Releases selected by the runtime.
   * @returns Completion after the reference is durable.
   */
  async reference(sessionId: string, ids: readonly string[]): Promise<void> {
    await this.update((state) => {
      if (!ids.every(id => state.installations.some(item => item.release.id === id))) throw new MarketError('not-installed', 404)
      state.references[sessionId] = [...new Set(ids)]
    })
  }

  /** Remove an unused installation from the ledger while retaining its shared cache.
   * @param id Installed release identifier.
   * @returns Completion after the installation is removed.
   */
  async remove(id: string): Promise<void> {
    await this.update((state) => {
      if (Object.values(state.references).some(ids => ids.includes(id))) throw new MarketError('release-in-use', 409)
      const old = state.installations.find(item => item.release.id === id)
      if (!old) throw new MarketError('not-installed', 404)
      if (old.enabled) throw new MarketError('disable-first', 409)
      state.installations = state.installations.filter(item => item.release.id !== id)
    })
  }
}
