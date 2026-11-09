/** Immutable local publication storage with atomic, cross-process ledger updates. */
import { constants } from 'node:fs'
import { open, lstat, mkdir, readdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { MarketError, marketManifest, marketRecord } from './format.ts'
import { marketRelease, readMarketPackage } from './package.ts'
import type { MuseMarketInstallation, MarketLimits, MarketRelease, MarketReleaseId } from './types.ts'

/** Read a bounded regular file without accepting links, special files or concurrent replacement.
 * @param path - Absolute file location.
 * @param maximum - Maximum accepted bytes.
 * @returns The complete unchanged file bytes.
 */
export async function readMarketBytes(path: string, maximum: number): Promise<Buffer> {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.size > BigInt(maximum)) throw new MarketError('invalid-storage')
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const handle = await open(path, flags)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new MarketError('invalid-storage')
    const chunks: Buffer[] = []
    let length = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, maximum - length + 1))
      const { bytesRead } = await handle.read(chunk)
      if (!bytesRead) break
      length += bytesRead
      if (length > maximum) throw new MarketError('invalid-storage')
      chunks.push(chunk.subarray(0, bytesRead))
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true })
    if (!current.isFile() || [after, current].some(info => info.dev !== before.dev || info.ino !== before.ino
      || info.size !== before.size || info.mtimeNs !== before.mtimeNs || info.ctimeNs !== before.ctimeNs)
      || BigInt(length) !== before.size) throw new MarketError('changed-resource')
    return Buffer.concat(chunks, length)
  } finally { await handle.close() }
}

interface LocalState { version: 1; installations: MuseMarketInstallation[] }

/** Explicit storage location and resolved bounds for local publications. */
export interface MarketLocalConfig {
  readonly root: string
  readonly limits: MarketLimits
}

/** Retains verified packages independently of any execution or Skill activation. */
export class MuseMarketLocal {
  private readonly ledger: string
  constructor(private readonly config: MarketLocalConfig) {
    if (!isAbsolute(config.root)) throw new MarketError('invalid-storage')
    this.ledger = join(config.root, 'installations.json')
  }

  /** Create private storage, refusing existing linked or non-directory roots. */
  async ready(): Promise<void> {
    for (const path of [this.config.root, join(this.config.root, 'packages')]) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new MarketError('invalid-storage')
    }
  }

  private async state(): Promise<LocalState> {
    let bytes: Buffer
    try { bytes = await readMarketBytes(this.ledger, this.config.limits.recordBytes) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, installations: [] }
      throw error
    }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch (_error) { throw new MarketError('invalid-ledger') }
    if (!marketRecord(value) || value.version !== 1 || !Array.isArray(value.installations)) throw new MarketError('invalid-ledger')
    const installations = value.installations.map((row: unknown): MuseMarketInstallation => {
      if (!marketRecord(row) || row.enabled !== false || !marketRecord(row.release)) throw new MarketError('invalid-ledger')
      const release = row.release
      if (typeof release.id !== 'string' || !/^[a-f0-9]{64}$/u.test(release.id) || release.sha256 !== release.id
        || !Number.isSafeInteger(release.bytes) || typeof release.bytes !== 'number' || release.bytes <= 0
        || release.bytes > this.config.limits.archiveBytes) throw new MarketError('invalid-ledger')
      return { enabled: false, release: { id: release.id as MarketReleaseId, sha256: release.id, bytes: release.bytes,
        manifest: marketManifest(release.manifest) } }
    })
    if (new Set(installations.map(row => row.release.id)).size !== installations.length) throw new MarketError('invalid-ledger')
    return { version: 1, installations }
  }

  private async update<T>(operation: (state: LocalState) => T | Promise<T>): Promise<T> {
    return await withFileLock(this.ledger, async () => {
      const state = await this.state(), result = await operation(state)
      const bytes = Buffer.from(JSON.stringify(state) + '\n')
      if (bytes.byteLength > this.config.limits.recordBytes) throw new MarketError('record-too-large')
      await writeFileAtomic(this.ledger, bytes, { mode: 0o600, dirMode: 0o700 })
      return result
    })
  }

  /** List retained disabled releases without activating or evaluating them.
   * @returns Validated local installation records.
   */
  async list(): Promise<MuseMarketInstallation[]> { return (await this.state()).installations }

  private directory(id: MarketReleaseId): string { return join(this.config.root, 'packages', id) }

  /** Verify exact cached archive bytes and the complete extracted resource tree.
   * @param release - Metadata selected from the local ledger.
   * @returns Original ZIP bytes after checking all extracted resources.
   */
  async verify(release: MarketRelease): Promise<Buffer> {
    const root = this.directory(release.id), rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new MarketError('modified-installation')
    const archive = await readMarketBytes(join(root, 'publication.zip'), this.config.limits.archiveBytes)
    if (!isDeepStrictEqual(marketRelease(archive, this.config.limits), release)) throw new MarketError('modified-installation')
    const { files } = readMarketPackage(archive, this.config.limits)
    const directories = new Set<string>()
    for (const path of Object.keys(files)) {
      const parts = path.split('/'); parts.pop()
      while (parts.length) { directories.add(parts.join('/')); parts.pop() }
    }
    const visit = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix + entry.name, native = join(directory, entry.name)
        if (entry.isDirectory() && directories.has(path)) { await visit(native, path + '/'); continue }
        if (!entry.isFile() || path !== 'publication.zip' && files[path] === undefined) throw new MarketError('modified-installation')
        const expected = path === 'publication.zip' ? archive : files[path]
        if (expected === undefined) throw new MarketError('modified-installation')
        const actual = await readMarketBytes(native, this.config.limits.expandedBytes)
        if (!actual.equals(expected)) throw new MarketError('modified-installation')
      }
    }
    await visit(root, '')
    for (const [path, expected] of Object.entries(files)) {
      const actual = await readMarketBytes(join(root, ...path.split('/')), this.config.limits.expandedBytes)
      if (!actual.equals(expected)) throw new MarketError('modified-installation')
    }
    return archive
  }

  /** Install complete verified bytes as a disabled, immutable publication.
   * @param archive - User-selected or locally prepared ZIP bytes.
   * @returns Existing matching installation, or a newly committed disabled installation.
   */
  async install(archive: Uint8Array): Promise<MuseMarketInstallation> {
    const release = marketRelease(archive, this.config.limits), parsed = readMarketPackage(archive, this.config.limits)
    return await this.update(async (state) => {
      const existing = state.installations.find(row => row.release.id === release.id)
      if (existing) { await this.verify(existing.release); return existing }
      const destination = this.directory(release.id)
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
        } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
      }
      await this.verify(release)
      const item: MuseMarketInstallation = { release, enabled: false }
      state.installations.push(item)
      return item
    })
  }

  /** Remove a disabled installation record while retaining reusable immutable cache bytes.
   * @param id - Exact installed release identity.
   */
  async remove(id: MarketReleaseId): Promise<void> {
    await this.update((state) => {
      if (!state.installations.some(row => row.release.id === id)) throw new MarketError('not-installed')
      state.installations = state.installations.filter(row => row.release.id !== id)
    })
  }
}
