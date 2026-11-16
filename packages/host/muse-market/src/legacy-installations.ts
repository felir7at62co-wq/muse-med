/** Persistent verified links between original archive digests and canonical local installations. */
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { MarketError, marketRecord } from './format.ts'
import { MuseMarketLocal, readMarketBytes, type MarketLocalConfig } from './local.ts'
import { parseMarketLegacyResourceId, type MarketLegacyResource, type MarketLegacyResourceId } from './legacy.ts'
import type { MarketReleaseId } from './types.ts'

interface LegacyInstallationBinding {
  readonly id: MarketLegacyResourceId
  readonly sha256: string
  readonly installationId: MarketReleaseId
}

/** Version 1 sidecar; canonical archives and the installation ledger remain unchanged. */
interface LegacyInstallationStateV1 {
  readonly version: 1
  readonly bindings: readonly LegacyInstallationBinding[]
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function unavailable(error: unknown): boolean {
  return missing(error) || error instanceof MarketError && ['modified-installation', 'changed-resource', 'invalid-storage',
    'archive-too-large', 'expanded-limit', 'invalid-path', 'invalid-archive', 'invalid-manifest', 'file-mismatch',
    'undeclared-skill', 'missing-skill', 'invalid-skill', 'skill-only'].includes(error.code)
}

function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }

/** Tracks only imports verified against a source catalog's exact digest. */
export class MarketLegacyInstallations {
  private readonly path: string
  private readonly local: MuseMarketLocal

  constructor(private readonly config: MarketLocalConfig) {
    this.path = join(config.root, 'legacy-installations.json')
    this.local = new MuseMarketLocal(config)
  }

  private async read(): Promise<LegacyInstallationStateV1> {
    let bytes: Buffer
    try { bytes = await readMarketBytes(this.path, this.config.limits.recordBytes) }
    catch (error) { if (missing(error)) return { version: 1, bindings: [] }; throw error }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch (_error) { throw new MarketError('invalid-legacy-installations') }
    if (!marketRecord(value) || Object.keys(value).length !== 2 || value.version !== 1 || !Array.isArray(value.bindings)) {
      throw new MarketError('invalid-legacy-installations')
    }
    const bindings: LegacyInstallationBinding[] = [], keys = new Set<string>()
    for (const row of value.bindings) {
      if (!marketRecord(row) || Object.keys(row).length !== 3 || !digest(row.sha256) || !digest(row.installationId)) {
        throw new MarketError('invalid-legacy-installations')
      }
      let id: MarketLegacyResourceId
      try { id = parseMarketLegacyResourceId(row.id) }
      catch (_error) { throw new MarketError('invalid-legacy-installations') }
      const key = `${id}\0${row.sha256}`
      if (keys.has(key)) throw new MarketError('invalid-legacy-installations')
      keys.add(key)
      bindings.push({ id, sha256: row.sha256, installationId: brandString<MarketReleaseId>(row.installationId) })
    }
    return { version: 1, bindings }
  }

  /** Save a completed verified import without changing its archive or activation.
   * @param resource - Original catalog identity and digest verified before conversion.
   * @param installationId - Canonical local archive committed by the import.
   */
  async remember(resource: Pick<MarketLegacyResource, 'id' | 'sha256'>, installationId: MarketReleaseId): Promise<void> {
    await withFileLock(this.path, async () => {
      const previous = await this.read()
      const bindings = previous.bindings.filter(row => row.id !== resource.id || row.sha256 !== resource.sha256)
      bindings.push({ id: resource.id, sha256: resource.sha256, installationId })
      const bytes = Buffer.from(JSON.stringify({ version: 1, bindings } satisfies LegacyInstallationStateV1) + '\n')
      if (bytes.byteLength > this.config.limits.recordBytes) throw new MarketError('record-too-large')
      await writeFileAtomic(this.path, bytes, { mode: 0o600, dirMode: 0o700 })
    })
  }

  /** Annotate exact source digests only when their retained canonical archive still verifies.
   * @param resources - Current original catalog records without inferred installation state.
   * @returns Original metadata with verified local identities; missing or modified archives remain downloadable.
   */
  async resolve(resources: readonly MarketLegacyResource[]): Promise<MarketLegacyResource[]> {
    const state = await this.read()
    if (state.bindings.length === 0) return [...resources]
    const installed = new Map((await this.local.list()).map(item => [item.release.id, item.release]))
    return await Promise.all(resources.map(async (resource) => {
      const binding = state.bindings.find(row => row.id === resource.id && row.sha256 === resource.sha256)
      const release = binding && installed.get(binding.installationId)
      if (release === undefined || release.manifest.name !== resource.name || release.manifest.version !== resource.version) return resource
      try { await this.local.verify(release) }
      catch (error) { if (unavailable(error)) return resource; throw error }
      return { ...resource, installationId: release.id }
    }))
  }
}
