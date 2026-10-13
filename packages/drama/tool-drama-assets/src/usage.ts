/** Local asset-use projections and voice gaps; no approval, binding or generation. */
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { readManifest } from './manifest.ts'
import { ProjectFiles } from './matching.ts'
import { realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'

type Row = Record<string, unknown>
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JubianError('INVALID_ARGUMENT', 'Usage inputs must contain JSON objects')
  return value as Row
}
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function id(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  if (typeof value === 'string' && !/^[1-9][0-9]*$/.test(value)) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}
function category(value: unknown): string {
  if (['character', '角色', '人物'].includes(text(value))) return 'character'
  if (['scene', '场景'].includes(text(value))) return 'scene'
  if (['prop', '道具'].includes(text(value))) return 'prop'
  return ''
}

/** One explicit reference in a local compiler package, not a remote binding receipt. */
export interface AssetUsage {
  stable_id: string
  character_id: string
  name: string
  kind: string
  asset_id: number
  material_id: number
  episode: number
  package_index: number
  shots: number[]
  material_key: string
  state_or_costume: string
  source_path: string
  source_sha256: string
  status: 'local_package_reference' | 'project_voice_reference'
}
/** A character's local voice state never establishes remote existence or audio quality. */
export interface VoiceState {
  character_id: string
  name: string
  status: 'missing' | 'candidate' | 'current_reference_needs_verification'
  candidate_count: number
}
/** Current local uses and voice gaps, bounded without implying a complete remote inventory. */
export interface UsagePreview {
  method: 'usage_preview'
  script_id: number
  usage_rows: AssetUsage[]
  voice_states: VoiceState[]
  total: number
  truncated: boolean
  issues: { code: string; message: string }[]
  read_only: true
  paid_requests: 0
  remote_writes: 0
  local_writes: 0
  next: string
}

/**
 * Derive uses from current manifests and explicitly hash-pinned compiler output files.
 * @param _client - Retained dispatch signature; this operation makes no network calls.
 * @param projectDir - Existing project root.
 * @param planPath - Optional version-1 document list with path, sha256 and episode fields.
 * @param assetId - Optional exact parent ID filter; names never filter identity.
 * @param limit - Maximum documents, returned uses and voice states; omitted rows remain counted.
 * @returns Bounded local uses, missing voices and invalid-input diagnostics without new permissions.
 */
export async function usagePreview(_client: JubianClient, projectDir: string, planPath: string | undefined,
  assetId: number | undefined, limit: number): Promise<UsagePreview> {
  if (assetId !== undefined && id(assetId) === undefined) throw new JubianError('INVALID_ARGUMENT', 'Use an exact positive asset_id')
  const files = new ProjectFiles(await realpath(projectDir))
  await files.bytes('assets_manifest.json')
  const { manifest, issues: manifestIssues } = await readManifest(files.root)
  const configBytes = await files.bytes('project_config.json')
  const config = object(JSON.parse(configBytes.toString('utf8').replace(/^\uFEFF/, '')))
  if (config.jubian_script_id !== manifest.script_id) throw new JubianError('INVALID_ARGUMENT', 'Project bible and manifest must name the same script')
  const configSha = createHash('sha256').update(configBytes).digest('hex')
  const characters = config.project_bible === undefined ? [] : object(config.project_bible).characters
  if (!Array.isArray(characters) || characters.length > limit) throw new JubianError('INVALID_ARGUMENT', 'Project bible needs a bounded characters array')
  const rows = [...manifest.items, ...manifest.lead_readonly_records]
  const issues: { code: string; message: string }[] = manifestIssues.map(issue => ({ code: issue.code, message: issue.message }))
  if (config.project_bible === undefined) issues.push({ code: 'VOICE_IDENTITY_NOT_CONFIGURED',
    message: 'The project has no character bible; local asset uses remain readable, but voice identity needs project configuration.' })
  const uses: AssetUsage[] = [], voices: VoiceState[] = []
  let samples: Row[] = []
  try {
    const ledger = await files.json('audio/voice-references/manifest.json')
    if (ledger.script_id !== undefined && ledger.script_id !== manifest.script_id || !Array.isArray(ledger.samples)) {
      throw new JubianError('INVALID_ARGUMENT', 'Voice ledger belongs to another project or has no samples array')
    }
    samples = ledger.samples.map(object)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const identities = new Set<string>()
  for (const value of characters) {
    const character = object(value), characterId = text(character.character_id)
    if (!characterId || identities.has(characterId)) throw new JubianError('INVALID_ARGUMENT', 'Every voice needs one unique stable character_id')
    identities.add(characterId)
    const profile = character.voice_profile === undefined ? {} : object(character.voice_profile)
    const candidates = samples.filter(sample => sample.character_id === characterId && sample.status === 'candidate')
    voices.push({ character_id: characterId, name: text(character.name), candidate_count: candidates.length,
      status: profile.reference_audio ? 'current_reference_needs_verification' : candidates.length ? 'candidate' : 'missing' })
    if (profile.reference_audio) {
      const voiceId = id(profile.reference_audio_asset_id)
      if (voiceId === undefined) issues.push({ code: 'VOICE_ID_MISSING', message: `${characterId}: reference has no verified parent ID` })
      else if (assetId === undefined || voiceId === assetId) uses.push({ stable_id: characterId, character_id: characterId,
        name: text(character.name), kind: 'voice', asset_id: voiceId, material_id: 0, episode: 0, package_index: 0, shots: [],
        material_key: '', state_or_costume: '', source_path: 'project_config.json',
        source_sha256: configSha, status: 'project_voice_reference' })
    }
  }
  if (planPath !== undefined) {
    const plan = await files.json(planPath)
    if (plan.version !== 1 || !Array.isArray(plan.documents) || plan.documents.length > limit) throw new JubianError('INVALID_ARGUMENT', 'Use version=1 with bounded documents')
    for (const value of plan.documents) {
      const document = object(value), path = text(document.path), episode = id(document.episode)
      if (!path || episode === undefined || !/^[a-f0-9]{64}$/.test(text(document.sha256))) throw new JubianError('INVALID_ARGUMENT', 'Each compiler document needs path, exact sha256 and positive episode')
      const compiled = await files.json(path)
      if (files.observed.get(await files.path(path)) !== document.sha256) throw new JubianError('INVALID_ARGUMENT', 'Compiler output changed; refresh its hash before querying uses')
      if (compiled.method !== 'compile' || compiled.ok !== true || !Array.isArray(compiled.packages) || !Array.isArray(compiled.shots)) {
        throw new JubianError('INVALID_ARGUMENT', 'Usage projection requires an actual successful drama_shot compile result')
      }
      const shotRows = new Map<number, Row[]>()
      for (const value of compiled.shots) {
        const shot = object(value), shotId = id(shot.shot)
        if (shotId === undefined || shotRows.has(shotId) || !Array.isArray(shot.bindings)) {
          throw new JubianError('INVALID_ARGUMENT', 'Compiler shots need unique positive IDs and explicit bindings')
        }
        shotRows.set(shotId, shot.bindings.map(object))
      }
      for (const value of compiled.packages) {
        const pack = object(value), packageIndex = id(pack.index)
        if (packageIndex === undefined || !Array.isArray(pack.shots) || pack.shots.some(shot => id(shot) === undefined)
          || !Array.isArray(pack.material_bindings)) throw new JubianError('INVALID_ARGUMENT', 'Compiler package has invalid explicit bindings or shot IDs')
        const keys = new Set<string>()
        for (const value of pack.material_bindings) {
          const binding = object(value), parentId = id(binding.asset_id), materialId = id(binding.material_id)
          const key = text(binding.material_key)
          if (parentId === undefined || materialId === undefined || !key || keys.has(key)) {
            throw new JubianError('INVALID_ARGUMENT', 'Bindings need unique keys and exact parent/material IDs')
          }
          keys.add(key)
          const matches = rows.filter(row => id(row.jubian_asset_id) === parentId && id(row.jubian_material_id) === materialId)
          const asset = matches[0]
          if (matches.length !== 1 || !asset || asset.official !== true || binding.official !== true
            || asset.name !== binding.name || category(asset.type) !== category(binding.type)
            || !category(asset.type) || asset.url !== binding.url) {
            issues.push({ code: 'ASSET_VERSION_CHANGED',
              message: `${path}: ${key} no longer agrees with the registered identity, category, material or URL` })
            continue
          }
          const usedShots: number[] = []
          for (const shotId of pack.shots) {
            const shotBindings = shotRows.get(Number(shotId))
            if (shotBindings === undefined) throw new JubianError('INVALID_ARGUMENT', 'Package references a missing compiler shot')
            const references = shotBindings.filter(row => id(row.asset_id) === parentId && id(row.material_id) === materialId)
            if (references.length > 1 || references.some(row => row.official !== true || row.name !== binding.name
              || category(row.type) !== category(binding.type) || row.url !== binding.url)) {
              throw new JubianError('INVALID_ARGUMENT', 'Shot and package asset identities disagree')
            }
            if (references.length === 1) usedShots.push(Number(shotId))
          }
          if (usedShots.length === 0) {
            issues.push({ code: 'PACKAGE_ASSET_NOT_IN_SHOTS', message: `${path}: ${key} is not bound in any shot of this package` })
            continue
          }
          if (assetId !== undefined && parentId !== assetId) continue
          uses.push({ stable_id: text(asset.stable_id), character_id: text(asset.character_id), name: text(asset.name),
            kind: category(asset.type), asset_id: parentId, material_id: materialId, episode, package_index: packageIndex,
            shots: usedShots, material_key: key, state_or_costume: text(asset.state_or_costume),
            source_path: path, source_sha256: text(document.sha256), status: 'local_package_reference' })
        }
      }
    }
  }
  await files.unchanged()
  return { method: 'usage_preview', script_id: manifest.script_id, usage_rows: uses.slice(0, limit),
    voice_states: voices, total: uses.length, truncated: uses.length > limit, issues,
    read_only: true, paid_requests: 0, remote_writes: 0, local_writes: 0,
    next: 'Local package references are planned uses, not remote bindings. Missing voices: load tweet-drama-voice-continuity and prepare candidates after downloading a successful video; verify current voices with match_preview.' }
}
