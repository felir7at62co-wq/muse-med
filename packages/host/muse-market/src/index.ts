/** Muse market directory, explicit publication and local activation service. */
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { MuseMarketCloud } from './cloud.ts'
import { MuseMarketLocal } from './local.ts'
import { bindMarketPortrait } from './format.ts'
import { MarketError, marketDigest, marketManifest, createMarketPackage, readMarketPackage } from './package.ts'
import { collectMarketSkills, marketPresetRows } from './author.ts'
import { createMarketSkillProvider } from './skills.ts'
import { createLegacyBotPackage, legacyBotCompatibility } from './legacy-bot.ts'
import { createLegacySkillPackage } from './legacy-skill.ts'
import type { MarketInstallation, MarketLegacyResource, MarketLimits, MarketManifest, MarketPresetPortraitId, MarketRelease, MarketReleaseId, MarketPublisherId } from './types.ts'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { SkillProvider } from '@deepseek-ai/dsh-skill'

export type * from './types.ts'

/** Product configuration for the cloud origin and local publication policy. */
export interface Config {
  /** Cloud market origin used for authenticated directory and release requests. */
  readonly baseUrl: string
  /** Local installation, immutable release, and session-binding storage directory. */
  readonly root: string
  /** Trusted Host account directory containing session.json; defaults to the resolved muse-account home. */
  readonly accountHome?: string
  /** Maximum duration in milliseconds for one cloud request. */
  readonly requestTimeoutMs: number
  /** Maximum compressed package size in bytes. */
  readonly archiveBytes: number
  /** Maximum total expanded file size in bytes. */
  readonly expandedBytes: number
  /** Maximum number of files accepted in one package. */
  readonly fileCount: number
  /** Explicit product allowlist of package plugin identifiers; internal filesystem providers remain forbidden. */
  readonly allowedPlugins: string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context { museMarket: MuseMarket }
}

/** Cloud directory and immutable release files; installation and enablement are distinct. */
export default class MuseMarket extends TypertRemoteService {
  static inject = ['agentPresets', 'skills']
  static Config = Schema.object({
    baseUrl: Schema.string().required(), root: Schema.string().default(dshHomePath('muse-market')), accountHome: Schema.string(),
    requestTimeoutMs: Schema.natural().min(1000).max(300000).default(60000),
    archiveBytes: Schema.natural().min(1024).max(64 * 1024 * 1024).default(16 * 1024 * 1024),
    expandedBytes: Schema.natural().min(1024).max(256 * 1024 * 1024).default(64 * 1024 * 1024),
    fileCount: Schema.natural().min(1).max(4096).default(512), allowedPlugins: Schema.array(Schema.string()).required(),
  })
  private readonly local: MuseMarketLocal
  private readonly cloud: MuseMarketCloud
  private readonly limits: MarketLimits
  private readonly activations = new Map<string, () => Promise<void>>()
  private readonly pendingSelectionReferences = new Map<string, Set<string>>()
  private operations: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'museMarket')
    this.limits = { archiveBytes: config.archiveBytes, expandedBytes: config.expandedBytes, fileCount: config.fileCount }
    this.local = new MuseMarketLocal({ root: config.root, limits: this.limits, allowedPlugins: config.allowedPlugins })
    this.cloud = new MuseMarketCloud({ baseUrl: config.baseUrl, sessionFile: join(config.accountHome ?? dshHomePath('muse-account'), 'session.json'),
      archiveBytes: config.archiveBytes, requestTimeoutMs: config.requestTimeoutMs, allowedPlugins: config.allowedPlugins })
    ctx.effect(() => async () => {
      await this.cloud.close(); await this.operations
      await Promise.all([...this.activations.values()].map(dispose => dispose()))
      this.activations.clear()
    })
    ctx.on('agent-preset/selected', (sessionId, presetId) => {
      const releaseId = this.releaseId(presetId)
      if (releaseId === undefined) return
      this.reserveSelectionReference(releaseId, sessionId)
      this.observe(async () => {
        const installed = (await this.local.list()).find(item => item.release.id === releaseId)
        if (!installed || installed.release.manifest.kind !== 'bot' || this.presetId(installed.release) !== presetId) {
          this.releaseSelectionReference(releaseId, sessionId)
          return
        }
        await this.local.reference(sessionId, [releaseId])
        this.releaseSelectionReference(releaseId, sessionId)
      }, `record selected market Bot for session ${sessionId}`)
    })
  }

  async [Service.init](): Promise<void> {
    await this.local.ready()
    for (const installed of await this.local.list()) if (installed.enabled && installed.release.manifest.kind === 'bot') await this.activate(installed, true)
    this.ctx.on('agent/created', async ({ agent }) => {
      const id = this.ctx.agentPresets.composedPreset(agent.ctx)
      const installed = await this.local.list()
      const release = installed.find(item => this.presetId(item.release) === id)
      const bound = await this.local.binding(agent.id) ?? installed.filter(item => item.enabled && item.release.manifest.kind === 'skill').map(item => item.release)
      await this.local.reference(agent.id, [...bound.map(item => item.id), ...(release ? [release.release.id] : [])])
      const skills = bound.filter(item => item.manifest.kind === 'skill')
      await agent.ctx.plugin({ inject: ['skills'], apply: (scope) => {
        scope.effect(() => scope.skills.registerProvider(() => createMarketSkillProvider(this.local, skills, `muse-market-${agent.id}`)))
      } })
    })
  }

  private presetId(release: MarketRelease): string { return `market-${release.id}` }
  private releaseId(presetId: string): string | undefined {
    const id = presetId.startsWith('market-') ? presetId.slice('market-'.length) : ''
    return /^[a-f0-9]{32,64}$/.test(id) ? id : undefined
  }
  private reserveSelectionReference(releaseId: string, sessionId: string): void {
    const sessions = this.pendingSelectionReferences.get(releaseId) ?? new Set<string>()
    sessions.add(sessionId)
    this.pendingSelectionReferences.set(releaseId, sessions)
  }
  private releaseSelectionReference(releaseId: string, sessionId: string): void {
    const sessions = this.pendingSelectionReferences.get(releaseId)
    if (!sessions) return
    sessions.delete(sessionId)
    if (!sessions.size) this.pendingSelectionReferences.delete(releaseId)
  }
  private selectionInFlight(releaseId: string): boolean {
    return this.pendingSelectionReferences.has(releaseId)
      || this.ctx.agentPresets.inspectCompositions().some(row => row.id === `market-${releaseId}`)
  }
  private observe(operation: () => Promise<void>, label: string): void {
    const result = this.operations.then(operation)
    this.operations = result.catch(() => undefined)
    void result.catch((error: unknown) => { this.ctx.logger.warn(`Muse market could not ${label}: ${String(error)}`) })
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation)
    this.operations = result.catch(() => undefined)
    return result.catch((error: unknown) => {
      throw new RemoteError('muse-market/operation-failed', 'Muse market operation failed', {
        code: error instanceof MarketError ? error.code : 'market-unavailable',
      })
    })
  }

  private legacyComposition(source: NonNullable<MarketInstallation['legacySource']>, rows: PresetDefinition['plugins']): PresetDefinition['plugins'] {
    const compatibility = legacyBotCompatibility(source)
    if (!compatibility) throw new MarketError('legacy-not-supported')
    const productRows = this.ctx.agentPresets.presetPlugins(compatibility.preset)
    if (!productRows) throw new MarketError('legacy-not-supported')
    const { provider } = compatibility
    const toolSkill = '@deepseek-ai/dsh-tool-skill'
    const hasSkillLoader = productRows.some(row => row.name === toolSkill && row.disabled !== true)
    const native = productRows.filter(row => row.name !== '@deepseek-ai/dsh-persona').map((row) => {
      if (provider === undefined || row.id !== 'delegation' || row.group !== true || !Array.isArray(row.config)) return row
      const delegates: PresetDefinition['plugins'] = row.config
      return { ...row, config: delegates.map(delegate => delegate.id === `tool-subagent-${provider}`
        && delegate.name === '@deepseek-ai/dsh-tool-subagent' ? { ...delegate, disabled: false } : delegate) }
    })
    return [...rows.filter(row => row.name !== toolSkill || !hasSkillLoader), ...native]
  }

  private async activate(installation: MarketInstallation, restoring = false): Promise<void> {
    const { release, legacySource } = installation
    if (this.activations.has(release.id)) return
    await this.local.verify(release)
    const rows: PresetDefinition['plugins'][number][] = [...(release.manifest.plugins ?? [])]
    if (release.manifest.skills.length) rows.push({ name: '@deepseek-ai/dsh-muse-market/bot-skills', config: { releaseId: release.id } })
    const resolvePlugins = legacySource === undefined ? undefined : () => this.legacyComposition(legacySource, rows)
    // The restored market row can start before Desktop registers its native presets.
    const plugins = restoring ? rows : resolvePlugins?.() ?? rows
    const presetId = this.presetId(release)
    const selectable = this.ctx.agentPresets.config.selectablePresets
    const addedToRoster = selectable !== undefined && !selectable.includes(presetId)
    if (addedToRoster) this.ctx.agentPresets.config.selectablePresets = [...selectable, presetId]
    try {
      const dispose = await this.ctx.agentPresets.register({ id: presetId, name: `${release.manifest.title} ${release.manifest.version}`,
        description: release.manifest.description, activation: 'on-demand', plugins }, restoring ? resolvePlugins : undefined)
      this.activations.set(release.id, async () => {
        try { await dispose() }
        finally {
          if (addedToRoster && this.ctx.agentPresets.config.selectablePresets !== undefined) {
            this.ctx.agentPresets.config.selectablePresets = this.ctx.agentPresets.config.selectablePresets.filter(id => id !== presetId)
          }
        }
      })
    } catch (error) {
      if (addedToRoster && this.ctx.agentPresets.config.selectablePresets !== undefined) {
        this.ctx.agentPresets.config.selectablePresets = this.ctx.agentPresets.config.selectablePresets.filter(id => id !== presetId)
      }
      throw error
    }
  }

  /** Resolve the exact enabled Bot release requested by the Host-synthesized child plugin.
   * @param releaseId Installed Bot release identifier.
   * @returns Provider backed by the verified, enabled release; rejects an unavailable release.
   */
  async botSkillProvider(releaseId: string): Promise<SkillProvider> {
    if (!/^[a-f0-9]{32,64}$/.test(releaseId)) throw new MarketError('invalid-release')
    const installation = (await this.local.list()).find(item => item.release.id === releaseId)
    if (!installation?.enabled || installation.release.manifest.kind !== 'bot') throw new MarketError('not-installed', 404)
    await this.local.verify(installation.release)
    return createMarketSkillProvider(this.local, [installation.release], `muse-market-bot-${releaseId}`)
  }

  /** Search public releases or the signed-in creator's drafts.
   * @param q Search text.
   * @param kind Bot or Skill filter; empty selects both.
   * @param mine Whether to include the creator's private releases.
   * @returns Matching release metadata.
   */
  @Remote('catalog')
  async catalog(q: string, kind: string, mine: boolean): Promise<MarketRelease[]> {
    return await this.serial(() => this.cloud.list(q, kind, mine))
  }

  /** List the original public Bot and Skill distributions for discovery.
   * @param query Search text.
   * @param kind Optional Bot or Skill filter. An empty string includes both.
   * @returns Matching metadata and original download links.
   */
  @Remote('legacyCatalog')
  async legacyCatalog(query: string, kind: string): Promise<MarketLegacyResource[]> {
    return await this.serial(() => this.cloud.legacyCatalog(query, kind))
  }

  /** Read signed-in publisher membership and administrator status.
   * @returns Account-safe publication privileges.
   */
  @Remote('identity')
  async identity(): Promise<{ publishers: { id: string; title: string }[]; admin: boolean }> {
    return await this.serial(() => this.cloud.identity())
  }

  /** List local release files and their independent activation states.
   * @returns Downloaded releases, including disabled versions.
   */
  @Remote('installed')
  async installed(): Promise<MarketInstallation[]> { return await this.serial(() => this.local.list()) }

  /** List local authoring sources without reading or uploading their resources.
   * @returns Discoverable Skill names and configured Bot identities.
   */
  @Remote('sources')
  async sources(): Promise<{ website: string; skills: { name: string; description: string }[]; bots: { id: string; name: string }[] }> {
    return await this.serial(async () => ({ website: new URL('/market', this.config.baseUrl).href,
      skills: (await this.ctx.skills.list()).map(row => ({ name: row.name, description: row.description })),
      bots: (await this.ctx.agentPresets.list()).filter(row => !row.broken).map(row => ({ id: row.id, name: row.name ?? row.id })) }))
  }

  /** Prepare selected local resources for inspection and export before any upload.
   * @param metadata Creator-entered publication information; execution fields are rebuilt from selected sources.
   * @param skillNames Explicit local Skill selection.
   * @param botId Local Bot identity, or empty for a standalone Skill.
   * @returns A disabled local publication available for export and private draft upload.
   */
  @Remote('prepare')
  async prepare(metadata: MarketManifest, skillNames: string[], botId: string): Promise<MarketInstallation> {
    return await this.serial(async () => {
      if (!Array.isArray(skillNames) || skillNames.length > 64 || new Set(skillNames).size !== skillNames.length) {
        throw new MarketError('invalid-selection')
      }
      const skills = []
      for (const name of skillNames) {
        const skill = await this.ctx.skills.get(name)
        if (!skill) throw new MarketError('missing-skill')
        skills.push(skill)
      }
      const manifest = marketManifest({ ...metadata, formatVersion: 1, kind: botId ? 'bot' : 'skill',
        skills: skills.map(skill => ({ name: skill.name, path: `skills/${skill.name}/SKILL.md` })),
        plugins: botId ? marketPresetRows((await this.ctx.agentPresets.readDocument(botId)).content) : undefined,
      }, this.config.allowedPlugins)
      const archive = createMarketPackage(
        manifest, await collectMarketSkills(skills, this.limits), this.limits, this.config.allowedPlugins,
      )
      return await this.importArchive(archive)
    })
  }

  /** Download a selected release into local storage without enabling it.
   * @param id Selected cloud release identity.
   * @returns Verified local installation.
   */
  @Remote('installPackage')
  async install(id: MarketReleaseId): Promise<MarketInstallation> {
    return await this.serial(async () => {
      const { release, archive } = await this.cloud.download(id)
      return await this.local.install(release, archive)
    })
  }

  /** Download and adapt a public original distribution into a disabled local installation.
   * @param id Original catalog identity.
   * @param sha256 Original digest selected by the user.
   * @returns Verified installation and original source identity. A repeat retains its existing activation state.
   */
  @Remote('installLegacy')
  async installLegacy(id: string, sha256: string): Promise<MarketInstallation> {
    return await this.serial(async () => {
      const { resource, archive } = await this.cloud.downloadLegacy(id, sha256)
      const installation = (await this.local.list()).find(item => item.legacySource?.id === id && item.legacySource.sha256 === sha256)
      if (installation) {
        await this.local.verify(installation.release)
        return installation
      }
      const adapt = resource.kind === 'bot' ? createLegacyBotPackage : createLegacySkillPackage
      const converted = adapt(resource, archive, this.limits, this.config.allowedPlugins)
      const { manifest } = readMarketPackage(converted, this.limits, this.config.allowedPlugins)
      return await this.local.install({ id: sha256 as MarketReleaseId, publisherId: '0000000000000000' as MarketPublisherId,
        publisher: 'Muse', manifest, sha256: marketDigest(converted), bytes: converted.byteLength, status: 'published', reviewNote: '',
        revision: 1, createdAt: new Date().toISOString() }, converted, { id, sha256 })
    })
  }

  /** Import an explicitly selected local publication without uploading it.
   * @param base64 Complete publication archive encoded by the local file picker.
   * @returns The matching verified installation and its activation state, or a new disabled local installation.
   */
  @Remote('importPackage')
  async importPackage(base64: string): Promise<MarketInstallation> {
    return await this.serial(async () => {
      if (base64.length > Math.ceil(this.config.archiveBytes / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(base64)) throw new MarketError('invalid-archive')
      const archive = Buffer.from(base64, 'base64')
      if (archive.toString('base64') !== base64) throw new MarketError('invalid-archive')
      return await this.importArchive(archive, 'zip-import')
    })
  }

  private async importArchive(archive: Uint8Array, source?: 'zip-import'): Promise<MarketInstallation> {
    const { manifest } = readMarketPackage(archive, this.limits, this.config.allowedPlugins)
    const sha256 = marketDigest(archive)
    return await this.local.install({ id: sha256 as MarketReleaseId, publisherId: '0000000000000000' as MarketPublisherId,
      publisher: 'Local', manifest, sha256, bytes: archive.byteLength, status: 'draft', reviewNote: '', revision: 1,
      createdAt: new Date().toISOString() }, archive, source)
  }

  /** Enable or disable an installed release with explicit resource verification.
   * @param id Installed release identity.
   * @param enabled Requested enablement.
   * @returns Persisted activation choice.
   */
  @Remote('enable')
  async enable(id: MarketReleaseId, enabled: boolean): Promise<MarketInstallation> {
    return await this.serial(async () => {
      if (!enabled && this.pendingSelectionReferences.has(id)) throw new MarketError('release-in-use', 409)
      const previous = (await this.local.list()).find(item => item.release.id === id)
      if (!previous) throw new MarketError('not-installed', 404)
      if (!enabled && previous.release.manifest.kind === 'bot' && this.selectionInFlight(id)) {
        throw new MarketError('release-in-use', 409)
      }
      const result = await this.local.enable(id, enabled)
      if (result.release.manifest.kind !== 'bot') return result
      if (enabled) {
        try { await this.activate(result) }
        catch (error) {
          await this.local.enable(id, previous.enabled)
          throw error
        }
        return result
      }
      if (this.selectionInFlight(id)) {
        await this.local.enable(id, previous.enabled)
        throw new MarketError('release-in-use', 409)
      }
      try { await this.activations.get(id)?.() }
      catch (error) {
        await this.local.enable(id, previous.enabled)
        throw error
      }
      this.activations.delete(id)
      if (this.selectionInFlight(id)) {
        await this.local.enable(id, previous.enabled)
        await this.activate(previous)
        throw new MarketError('release-in-use', 409)
      }
      return result
    })
  }

  /** Remove an unused, disabled local installation while retaining shared cache files.
   * @param id Installed release identity.
   * @returns Completion after the ledger update.
   */
  @Remote('removePackage')
  async remove(id: MarketReleaseId): Promise<void> {
    await this.serial(() => {
      if (this.pendingSelectionReferences.has(id)) throw new MarketError('release-in-use', 409)
      return this.local.remove(id)
    })
  }

  /** Export exact local publication bytes to a user-requested download.
   * @param id Installed release identity.
   * @returns Filename and encoded publication archive.
   */
  @Remote('exportPackage')
  async exportPackage(id: MarketReleaseId): Promise<{ name: string; base64: string }> {
    return await this.serial(async () => {
      const item = (await this.local.list()).find(row => row.release.id === id)
      if (!item) throw new MarketError('not-installed', 404)
      if (item.legacySource) throw new MarketError('legacy-not-exportable', 403)
      return { name: `${item.release.manifest.name}-${item.release.manifest.version}.zip`, base64: Buffer.from(await this.local.verify(item.release)).toString('base64') }
    })
  }

  /** Upload a selected installed release as a private cloud draft.
   * @param id Installed release identity.
   * @param publisherId Explicitly selected publisher.
   * @param requestId Stable upload idempotency key.
   * @param presetPortrait Automatic portrait for a Bot whose archive has no portrait binding.
   * @returns The cloud draft; public submission is a separate action.
   */
  @Remote('publishDraft')
  async publishDraft(
    id: MarketReleaseId, publisherId: MarketPublisherId, requestId: string, presetPortrait?: MarketPresetPortraitId,
  ): Promise<MarketRelease> {
    return await this.serial(async () => {
      const item = (await this.local.list()).find(row => row.release.id === id)
      if (!item) throw new MarketError('not-installed', 404)
      if (item.legacySource) throw new MarketError('legacy-not-publishable', 403)
      const archive = await this.local.verify(item.release)
      const manifest = item.release.manifest
      const upload = presetPortrait && manifest.kind === 'bot' && !manifest.presetPortrait && !manifest.portrait
        ? bindMarketPortrait(archive, presetPortrait, this.limits, this.config.allowedPlugins) : archive
      return await this.cloud.upload(publisherId, requestId, upload)
    })
  }

  /** Submit a draft, review it, or withdraw a publication using the current revision.
   * @param id Cloud release identity.
   * @param revision Revision shown in the creator or administrator view.
   * @param action Explicit submit, approve, reject or withdraw action.
   * @param note Review reason.
   * @returns Updated cloud release.
   */
  @Remote('review')
  async review(id: MarketReleaseId, revision: number, action: string, note: string): Promise<MarketRelease> {
    return await this.serial(() => this.cloud.review(id, revision, action, note))
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'muse-market/operation-failed': { readonly code: string }
  }
}
