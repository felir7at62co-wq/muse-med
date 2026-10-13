/** Read-only current-project matching; recommendations never approve or apply assets. */
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { readAssetList, readMaterialList, trustedSubjectId } from '@deepseek-ai/dsh-jubian-api'
import { readManifest } from './manifest.ts'

type Row = Record<string, unknown>
type Kind = 'character' | 'scene' | 'voice'
type Status = 'reuse_ready' | 'needs_review' | 'missing' | 'blocked'

/** Bounds resolved by the tool's deployment configuration. */
export interface MatchLimits {
  /** Provider page size, at most 1000. */
  pageSize: number
  /** Maximum pages per inventory; exhaustion blocks the preview. */
  pageLimit: number
  /** Maximum requirements in one preview. */
  requirementsLimit: number
}

/** One source-backed requirement; omitted identity links cannot establish a character. */
export interface MatchRequirement {
  id: string
  kind: Kind
  name: string
  source_line: number
  source_text: string
  conditions: string[]
  character_id?: string
  stable_id?: string
  episode?: number
  state_or_costume?: string
  /** Explicit story period for a voice; never inferred from costume or age wording. */
  voice_period_id?: string
}

/** Candidate IDs and explanations, without a writable binding or approval. */
export interface EntityMatch {
  id: string
  kind: Kind
  name: string
  status: Status
  candidate_asset_ids: number[]
  selected_asset_id?: number
  reason_codes: string[]
  evidence: string[]
  /** Period requested for this voice, absent for legacy unperioded requirements. */
  voice_period_id?: string
}

/** A preview is scoped to this project, not a claim that the historical library is empty. */
export interface MatchPreview {
  method: 'match_preview'
  status: Status
  script_id?: number
  source_sha256?: string
  search_scope: 'current_project'
  matches: EntityMatch[]
  counts: Record<Status, number>
  issues: { code: string; message: string }[]
  read_only: true
  paid_requests: 0
  remote_writes: 0
  local_writes: 0
  next: string
}

class MatchBlocked extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
function block(code: string, message: string): never { throw new MatchBlocked(code, message) }
function object(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) block('INVALID_DATA', `${label} must be a JSON object.`)
  return value as Row
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function normalized(value: string): string { return value.normalize('NFKC').trim().toLowerCase().replace(/[；;,，、]/g, ';').replace(/\s+/g, '') }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
function https(value: unknown): boolean {
  try { const url = new URL(text(value)); return url.protocol === 'https:' && !url.username && !url.password && !url.hash }
  catch (_error) { return false }
}

/** One configured voice period, or the legacy unperioded default. */
export interface ConfiguredVoiceProfile {
  /** Exact configured voice period; absent only for the legacy default. */
  voice_period_id?: string
  /** Human-readable period label, which does not determine identity. */
  label?: string
  /** Flat reference fields and voice guidance for this period. */
  profile: Row
}

/** Read explicit voice periods without mixing them with a legacy default.
 * @param character - Current persisted character entry.
 * @returns Unique configured periods, or one legacy profile when no periods exist.
 */
export function configuredVoiceProfiles(character: Row): ConfiguredVoiceProfile[] {
  if (character.voice_profiles !== undefined && !Array.isArray(character.voice_profiles)) {
    block('VOICE_PERIODS_UNREADABLE', 'voice_profiles must be an array of explicit periods.')
  }
  if (Array.isArray(character.voice_profiles) && character.voice_profiles.length > 0) {
    const seen = new Set<string>()
    return character.voice_profiles.map((value) => {
      const profile = object(value, 'voice period'), period = profile.voice_period_id
      if (typeof period !== 'string' || !period.trim() || seen.has(period) || profile.label !== undefined && !text(profile.label)) {
        block('VOICE_PERIODS_AMBIGUOUS', 'Voice periods need unique nonempty voice_period_id values and readable labels.')
      }
      seen.add(period)
      return { voice_period_id: period, ...(profile.label === undefined ? {} : { label: text(profile.label) }), profile }
    })
  }
  return [{ profile: character.voice_profile === undefined ? {} : object(character.voice_profile, 'voice_profile') }]
}

/** Reads retain byte digests so changes during remote queries invalidate the whole preview. */
export class ProjectFiles {
  /** Byte digests of every file observed during this read operation. */
  readonly observed = new Map<string, string>()
  /** Canonical locations retained to detect retargeted directory links. */
  readonly resolved = new Map<string, string>()
  constructor(readonly root: string) {}
  /** Resolve an existing project-contained path.
   * @param input - Project-relative or absolute local input path.
   * @returns Canonical path, refusing external or retargeted links.
   */
  async path(input: string): Promise<string> {
    const requested = resolve(this.root, input)
    const path = await realpath(requested)
    const part = relative(this.root, path)
    if (part.startsWith('..') || isAbsolute(part)) block('PATH_OUTSIDE_PROJECT', 'Matching files must remain inside the project.')
    if (this.resolved.has(requested) && this.resolved.get(requested) !== path) block('SOURCE_CHANGED', 'A matching input now resolves to a different source.')
    this.resolved.set(requested, path)
    return path
  }
  /** Read bytes and retain their digest for final revalidation.
   * @param input - Project-contained local input path.
   * @returns Current file bytes, refusing changes since an earlier read.
   */
  async bytes(input: string): Promise<Buffer> {
    const path = await this.path(input)
    const bytes = await readFile(path)
    const digest = hash(bytes)
    if (this.observed.has(path) && this.observed.get(path) !== digest) block('SOURCE_CHANGED', 'A matching input changed while being read.')
    this.observed.set(path, digest)
    return bytes
  }
  /** Parse a tracked project file as a JSON object.
   * @param input - Project-contained JSON input path.
   * @returns Parsed object, refusing invalid documents.
   */
  async json(input: string): Promise<Row> {
    return object(JSON.parse((await this.bytes(input)).toString('utf8').replace(/^\uFEFF/, '')), input)
  }
  /** Refuse byte changes or link retargeting since any tracked read. */
  async unchanged(): Promise<void> {
    for (const requested of this.resolved.keys()) await this.path(requested)
    for (const [path, digest] of this.observed) {
      if (hash(await readFile(path)) !== digest) block('SOURCE_CHANGED', 'A matching input changed during the preview.')
    }
  }
}

/** Inspected inputs contain exactly one match per validated requirement; callers recheck them after additional reads. */
export interface MatchingSnapshot {
  preview: MatchPreview
  requirements: MatchRequirement[]
  entries: Row[]
  materials: Row[]
  parents: Row[]
  /** All hashes describe inspected bytes, not approvals. */
  input_sha256: Record<string, string>
  /** Read another project-contained input and retain its digest. */
  readJson(input: string): Promise<Row>
  /** Refuse byte changes or directory-link retargeting. */
  unchanged(): Promise<void>
}

function requirements(document: Row, limit: number): MatchRequirement[] {
  if (document.version !== 1 || !Array.isArray(document.requirements)
    || document.requirements.length < 1 || document.requirements.length > limit) {
    block('INVALID_REQUIREMENTS', 'Use version=1 and a nonempty bounded requirements array.')
  }
  const ids = new Set<string>()
  return document.requirements.map((value) => {
    const row = object(value, 'requirement')
    if (!text(row.id) || ids.has(text(row.id)) || !['character', 'scene', 'voice'].includes(text(row.kind))
      || !text(row.name) || !positive(row.source_line) || !text(row.source_text)
      || !Array.isArray(row.conditions) || row.conditions.some(item => !text(item))) {
      block('INVALID_REQUIREMENTS', 'Every requirement needs a unique id, kind, name, exact source line/text and conditions array.')
    }
    for (const key of ['character_id', 'stable_id', 'state_or_costume']) {
      if (row[key] !== undefined && !text(row[key])) block('INVALID_REQUIREMENTS', `${key} must be nonempty text.`)
    }
    if (row.voice_period_id !== undefined && (typeof row.voice_period_id !== 'string' || !row.voice_period_id.trim())) {
      block('INVALID_REQUIREMENTS', 'voice_period_id must be nonempty text.')
    }
    if (row.episode !== undefined && !positive(row.episode)) block('INVALID_REQUIREMENTS', 'episode must be a positive integer.')
    ids.add(text(row.id))
    return { id: text(row.id), kind: text(row.kind) as Kind, name: text(row.name),
      source_line: row.source_line, source_text: String(row.source_text), conditions: strings(row.conditions),
      ...(row.character_id === undefined ? {} : { character_id: text(row.character_id) }),
      ...(row.stable_id === undefined ? {} : { stable_id: text(row.stable_id) }),
      ...(row.episode === undefined ? {} : { episode: row.episode }),
      ...(row.state_or_costume === undefined ? {} : { state_or_costume: text(row.state_or_costume) }),
      ...(row.voice_period_id === undefined ? {} : { voice_period_id: row.voice_period_id }) }
  })
}

/** Uses the existing response readers but requires complete, stable, non-repeating pages. */
async function inventory(client: JubianClient, scriptId: number, kind: 'asset' | 'material', limits: MatchLimits): Promise<Row[]> {
  const result: Row[] = []
  const seen = new Set<number>()
  let total: number | undefined
  for (let page = 1; page <= limits.pageLimit; page++) {
    const { data } = await client.request({ method: 'GET',
      path: `/aigc/${kind}/list?scriptId=${scriptId}${kind === 'asset' ? '&isParent=1' : ''}&pageNum=${page}&pageSize=${limits.pageSize}` })
    const mapped = kind === 'asset' ? readAssetList(data) : readMaterialList(data)
    const payload = object(data, `${kind} page`)
    if (typeof payload.total !== 'number' || !Number.isSafeInteger(payload.total) || payload.total < 0) block('PAGINATION_INCOMPLETE', 'Provider inventory has no explicit valid total.')
    if (total !== undefined && total !== mapped.total) block('INVENTORY_CHANGED', 'Provider inventory total changed between pages.')
    total = payload.total
    const rows = payload.rows as Row[]
    if (rows.length > limits.pageSize || result.length + rows.length > total) block('PAGINATION_INCOMPLETE', 'Provider page count does not agree with its total.')
    for (const row of rows) {
      if (!positive(row.id) || seen.has(row.id)) block('PAGINATION_INCOMPLETE', 'Provider inventory repeats or omits a row identity.')
      if (row.scriptId !== undefined && row.scriptId !== scriptId) block('PROJECT_MISMATCH', 'Provider inventory contains another project.')
      seen.add(row.id)
      result.push(row)
    }
    if (result.length === total) return result
    if (rows.length === 0) block('PAGINATION_INCOMPLETE', 'Provider inventory ended before its declared total.')
  }
  return block('PAGINATION_INCOMPLETE', 'Provider inventory exceeded the configured page limit.')
}

function base(requirement: MatchRequirement, status: Status, rows: Row[], code: string, evidence: string[] = []): EntityMatch {
  return { id: requirement.id, kind: requirement.kind, name: requirement.name, status,
    candidate_asset_ids: [...new Set(rows.map(row => row.jubian_asset_id ?? row.asset_id ?? row.id).filter(positive))],
    reason_codes: [code], evidence,
    ...(requirement.kind !== 'voice' || requirement.voice_period_id === undefined ? {} : { voice_period_id: requirement.voice_period_id }) }
}
function names(row: Row): string[] { return [text(row.name ?? row.assetName), ...strings(row.aliases)] }
function covers(row: Row, episode: number | undefined): boolean {
  return episode !== undefined && Array.isArray(row.episodes) && (row.episodes.includes('all') || row.episodes.includes(episode))
}
function kindOf(row: Row): number {
  const type = text(row.type).toLowerCase()
  return ['character', '角色', '人物'].includes(type) ? 1 : ['scene', '场景'].includes(type) ? 2 : 0
}
function hasConditions(row: Row, conditions: string[]): boolean {
  const facts = [text(row.identity), text(row.state_or_costume), ...strings(row.scene_conditions)]
    .flatMap(fact => [fact, ...fact.split(/[；;,，、]/)]).map(normalized)
  return conditions.every(condition => facts.includes(normalized(condition)))
}
async function checkedParent(client: JubianClient, scriptId: number, assetId: number, assetType: number, url: string,
  parents: Row[]): Promise<Row> {
  const { data } = await client.request({ method: 'GET', path: `/aigc/asset/${assetId}` })
  const parent = object(data, 'asset detail')
  if (parent.id !== assetId || parent.scriptId !== scriptId || parent.assetType !== assetType || String(parent.delFlag) !== '0') {
    block('ASSET_IDENTITY_CHANGED', 'Asset detail no longer agrees with its project, category or identity.')
  }
  if (!https(url) || text(parent.assetUrl ?? parent.url) !== url) block('ASSET_SOURCE_CHANGED', 'Asset URL differs from the recorded source.')
  parents.push(parent)
  return parent
}

async function visualMatch(client: JubianClient, scriptId: number, req: MatchRequirement,
  entries: Row[], characters: Row[], assets: Row[], materials: Row[], parents: Row[]): Promise<EntityMatch> {
  const type = req.kind === 'character' ? 1 : 2
  const character = characters.find(row => row.character_id === req.character_id)
  const rows = entries.filter(row => kindOf(row) === type && (req.stable_id !== undefined && row.stable_id === req.stable_id
    || names(row).some(name => normalized(name) === normalized(req.name))
    || req.kind === 'character' && req.character_id !== undefined
      && (row.character_id === req.character_id || row.jubian_asset_id === character?.asset_id)))
  const remoteNames = assets.filter(row => row.assetType === type && String(row.delFlag) === '0'
    && normalized(text(row.assetName ?? row.name)) === normalized(req.name))
  if (rows.length === 0) return base(req, remoteNames.length ? 'needs_review' : 'missing', remoteNames,
    remoteNames.length ? 'UNREGISTERED_CANDIDATE' : 'NO_CURRENT_PROJECT_CANDIDATE')
  if (req.episode === undefined || req.kind === 'character' && !req.state_or_costume
    || req.kind === 'scene' && req.conditions.length === 0) {
    return base(req, 'needs_review', rows, 'REQUIREMENT_DETAILS_MISSING')
  }
  const eligible = rows.filter(row => covers(row, req.episode) && hasConditions(row, req.conditions)
    && (req.kind !== 'character' || normalized(text(row.state_or_costume)) === normalized(req.state_or_costume ?? '')))
  const [row] = eligible
  if (eligible.length !== 1 || row === undefined) return base(req, 'needs_review', rows,
    eligible.length > 1 ? 'AMBIGUOUS_CANDIDATES' : 'STATE_OR_CONDITIONS_CONFLICT')
  const knownNames = [...names(row), ...(character === undefined ? [] : names(character))]
  if (!knownNames.some(name => normalized(name) === normalized(req.name))) return base(req, 'needs_review', [row], 'IDENTITY_NAME_CONFLICT')
  const stableIdentity = req.stable_id !== undefined && row.stable_id === req.stable_id
  const characterIdentity = req.kind === 'character' && character !== undefined
    && (row.character_id === req.character_id || row.jubian_asset_id === character.asset_id)
  const referenceRows = entries.filter(entry => entry.jubian_asset_id === character?.asset_id)
  const referenceIdentity = character?.asset_id === undefined || character.asset_id === row.jubian_asset_id
    || referenceRows.length > 0 && referenceRows.every(entry => kindOf(entry) === 1
      && entry.character_id === req.character_id && entry.official === true)
      && assets.some(asset => asset.id === character.asset_id && asset.assetType === 1 && String(asset.delFlag) === '0')
  if (req.stable_id !== undefined && !stableIdentity
    || req.kind === 'character' && req.character_id !== undefined
      && (!characterIdentity || row.character_id !== undefined && row.character_id !== req.character_id
        || !referenceIdentity)) {
    return base(req, 'needs_review', [row], 'IDENTITY_FIELDS_CONFLICT')
  }
  const identity = stableIdentity || characterIdentity
  if (!identity) return base(req, 'needs_review', [row], 'NAME_ONLY_IDENTITY_UNVERIFIED')
  if (row.official !== true || !positive(row.jubian_asset_id) || !https(row.url)) return base(req, 'needs_review', [row], 'FORMAL_ASSET_EVIDENCE_MISSING')
  const remote = assets.filter(asset => asset.id === row.jubian_asset_id)
  const selected = materials.filter(material => material.assetId === row.jubian_asset_id && material.isUsed === 1
    && normalized(text(material.hsAssetStatus)) === 'active')
  const remoteAsset = remote.at(0), selectedMaterial = selected.at(0)
  if (remote.length !== 1 || remoteAsset === undefined || remoteAsset.assetType !== type || String(remoteAsset.delFlag) !== '0'
    || selected.length !== 1 || selectedMaterial === undefined || trustedSubjectId(selectedMaterial.hsAssetId) === null) {
    return base(req, 'blocked', [row], 'FORMAL_ASSET_IDENTITY_CHANGED')
  }
  if (text(selectedMaterial.assetUrl) !== row.url || text(remoteAsset.url ?? remoteAsset.assetUrl) !== row.url) {
    return base(req, 'blocked', [row], 'ASSET_SOURCE_CHANGED')
  }
  await checkedParent(client, scriptId, row.jubian_asset_id, type, text(row.url), parents)
  return { ...base(req, 'reuse_ready', [row], 'REGISTERED_IDENTITY_AND_CONDITIONS_VERIFIED',
    [`stable_id=${text(row.stable_id)}`, `episode=${req.episode}`, `asset_id=${row.jubian_asset_id}`, 'official=true; current project; Active; source URL verified']),
  selected_asset_id: row.jubian_asset_id }
}

async function voiceMatch(client: JubianClient, files: ProjectFiles, scriptId: number, req: MatchRequirement,
  characters: Row[], samples: Row[], assets: Row[], parents: Row[]): Promise<EntityMatch> {
  const character = characters.find(row => row.character_id === req.character_id)
  const named = assets.filter(row => row.assetType === 4 && text(row.delFlag) === '0'
    && normalized(text(row.assetName ?? row.name)).includes(normalized(req.name)))
  if (!character) return base(req, 'needs_review', named, 'CHARACTER_VOICE_IDENTITY_UNVERIFIED')
  if (!names(character).some(name => normalized(name) === normalized(req.name))) return base(req, 'needs_review', named, 'IDENTITY_NAME_CONFLICT')
  const profiles = configuredVoiceProfiles(character)
  if (req.voice_period_id === undefined && profiles.some(profile => profile.voice_period_id !== undefined)) {
    return base(req, 'needs_review', named, 'VOICE_PERIOD_REQUIRED')
  }
  const configured = profiles.find(profile => profile.voice_period_id === req.voice_period_id)
  if (configured === undefined) return base(req, 'needs_review', named, 'VOICE_PERIOD_NOT_CONFIGURED')
  const voice = configured.profile
  const references = samples.filter(sample => sample.character_id === req.character_id
    && sample.voice_period_id === req.voice_period_id && !['archived', 'archived_duplicate'].includes(text(sample.status)))
  if (!voice.reference_audio) return base(req, references.length || named.length ? 'needs_review' : 'missing', named,
    references.length || named.length ? 'NO_APPROVED_CURRENT_VOICE' : 'NO_CURRENT_PROJECT_VOICE')
  const selected = references.filter(sample => sample.status === 'approved' && sample.asset_id === voice.reference_audio_asset_id)
  const [sample] = selected
  if (selected.length !== 1 || sample === undefined) return base(req, 'needs_review', named, 'VOICE_APPROVAL_OR_SOURCE_UNVERIFIED')
  if (!positive(sample.asset_id) || !https(sample.url) || !/^[a-f0-9]{64}$/i.test(text(sample.sha256))
    || sample.url !== voice.reference_audio || sample.sha256 !== voice.reference_audio_sha256
    || sample.duration_seconds !== voice.reference_audio_duration_seconds) {
    return base(req, 'blocked', [sample], 'VOICE_REFERENCE_CHANGED')
  }
  if (typeof sample.duration_seconds !== 'number' || sample.duration_seconds <= 0 || sample.duration_seconds > 15
    || !text(sample.source_path) || !/^[a-f0-9]{64}$/i.test(text(sample.source_sha256))
    || typeof sample.start_seconds !== 'number' || sample.start_seconds < 0) {
    return base(req, 'needs_review', [sample], 'VOICE_APPROVAL_OR_SOURCE_UNVERIFIED')
  }
  if (hash(await files.bytes(text(sample.source_path))) !== text(sample.source_sha256).toLowerCase()) {
    return base(req, 'blocked', [sample], 'VOICE_SOURCE_CHANGED')
  }
  if (!req.conditions.every(condition => text(voice.description).split(/[；;,，、]/).map(normalized).includes(normalized(condition)))) {
    return base(req, 'needs_review', [sample], 'VOICE_DESCRIPTION_CONFLICT')
  }
  const remote = assets.filter(row => row.id === sample.asset_id)
  const remoteVoice = remote.at(0)
  if (remote.length !== 1 || remoteVoice === undefined || remoteVoice.assetType !== 4 || String(remoteVoice.delFlag) !== '0') return base(req, 'blocked', [sample], 'VOICE_ASSET_IDENTITY_CHANGED')
  await checkedParent(client, scriptId, sample.asset_id, 4, text(sample.url), parents)
  return { ...base(req, 'reuse_ready', [sample], 'APPROVED_CURRENT_CHARACTER_VOICE',
    [`character_id=${req.character_id}`, ...(req.voice_period_id === undefined ? [] : [`voice_period_id=${req.voice_period_id}`]),
      `audio_asset_id=${String(sample.asset_id)}`, `sha256=${text(sample.sha256)}`, 'Approved sample/source matches current voice profile; generated voice still requires listening.']),
  selected_asset_id: sample.asset_id }
}

function report(matches: EntityMatch[], issues: MatchPreview['issues'], scriptId?: number, sourceSha?: string): MatchPreview {
  const counts = { reuse_ready: 0, needs_review: 0, missing: 0, blocked: 0 }
  for (const match of matches) counts[match.status]++
  const status = issues.length || counts.blocked ? 'blocked'
    : counts.needs_review ? 'needs_review' : counts.missing ? 'missing' : 'reuse_ready'
  return { method: 'match_preview', status, ...(scriptId === undefined ? {} : { script_id: scriptId }),
    ...(sourceSha === undefined ? {} : { source_sha256: sourceSha }), search_scope: 'current_project', matches, counts, issues,
    read_only: true, paid_requests: 0, remote_writes: 0, local_writes: 0,
    next: '只读匹配预览，不代表审批或绑定。missing 仅限当前项目；继续既有素材库检索，'
      + '人工确认不确定项与正式采用，付费生成另需授权。' }
}

/**
 * Match source-backed requirements to current-project assets and approved voices using GET only.
 * @param client - Existing provider client; every request is a read.
 * @param projectDir - Existing project holding its manifest and project bible.
 * @param requirementsPath - Project-contained version-1 requirement JSON, with source path and SHA-256.
 * @param limits - Deployment-resolved inventory and requirement bounds.
 * @returns Four-state recommendations; unreadable, incomplete or changed inputs block instead of claiming absence.
 */
export async function matchPreview(client: JubianClient, projectDir: string,
  requirementsPath: string, limits: MatchLimits): Promise<MatchPreview> {
  return (await matchingSnapshot(client, projectDir, requirementsPath, limits)).preview
}

/**
 * Retain the verified reads used by matching for a read-only reuse planner.
 * @param client - Existing GET transport.
 * @param projectDir - Existing project root.
 * @param requirementsPath - Source-backed requirement JSON.
 * @param limits - Resolved matching bounds.
 * @returns Matching result and inspected evidence; never an approval or write authorization.
 */
export async function matchingSnapshot(client: JubianClient, projectDir: string,
  requirementsPath: string, limits: MatchLimits): Promise<MatchingSnapshot> {
  let reqs: MatchRequirement[] = []
  let scriptId: number | undefined
  let sourceSha: string | undefined
  let files: ProjectFiles | undefined
  const snapshot = (preview: MatchPreview, entries: Row[] = [], materials: Row[] = [], parents: Row[] = []): MatchingSnapshot => ({
    preview, requirements: reqs, entries, materials, parents,
    input_sha256: files === undefined ? {} : Object.fromEntries([...files.observed].map(([path, digest]) =>
      [relative(projectDir, path).replaceAll('\\', '/'), digest])),
    readJson: async (input) => {
      if (!files) return block('DATA_READ_FAILED', 'Project inputs are unavailable.')
      return await files.json(input)
    },
    unchanged: async () => { if (files) await files.unchanged() },
  })
  try {
    files = new ProjectFiles(await realpath(projectDir))
    const document = await files.json(requirementsPath)
    reqs = requirements(document, limits.requirementsLimit)
    if (!text(document.source_path) || !/^[a-f0-9]{64}$/i.test(text(document.source_sha256))) block('INVALID_SOURCE', 'Requirements need source_path and its 64-character SHA-256.')
    const source = await files.bytes(text(document.source_path))
    sourceSha = hash(source)
    if (sourceSha !== text(document.source_sha256).toLowerCase()) block('SOURCE_CHANGED', 'The source SHA-256 differs from the requirement baseline.')
    const lines = source.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    for (const req of reqs) if (lines[req.source_line - 1] !== req.source_text) block('SOURCE_MAPPING_CHANGED', 'A requirement does not quote its exact source line.')
    await files.bytes('assets_manifest.json')
    const { manifest, issues } = await readManifest(files.root)
    if (issues.length) block('MANIFEST_UNREADABLE', 'Repair the manifest issues with the existing reconcile workflow before matching.')
    scriptId = manifest.script_id
    const config = await files.json('project_config.json')
    if (config.jubian_script_id !== scriptId) block('PROJECT_MISMATCH', 'The manifest and project bible are not bound to the same project.')
    const bible = object(config.project_bible, 'project_bible')
    if (!Array.isArray(bible.characters)) block('PROJECT_BIBLE_UNREADABLE', 'Project bible needs its characters array, empty when none exist.')
    const characters = bible.characters.map(value => object(value, 'character'))
    const characterIds = characters.map(row => text(row.character_id))
    if (characterIds.some(id => !id) || new Set(characterIds).size !== characterIds.length) block('CHARACTER_IDENTITIES_AMBIGUOUS', 'Character IDs must be present and unique.')
    let samples: Row[] = []
    if (reqs.some(req => req.kind === 'voice')) {
      const voices = await files.json('audio/voice-references/manifest.json')
      if (!Array.isArray(voices.samples)) block('VOICE_MANIFEST_UNREADABLE', 'Voice manifest needs its samples array, empty when no samples exist.')
      samples = voices.samples.map(value => object(value, 'voice sample'))
    }
    const assets = await inventory(client, scriptId, 'asset', limits)
    const materials = await inventory(client, scriptId, 'material', limits)
    const entries = [...manifest.items, ...manifest.lead_readonly_records]
    const matches: EntityMatch[] = []
    const parents: Row[] = []
    for (const req of reqs) {
      try {
        matches.push(req.kind === 'voice' ? await voiceMatch(client, files, scriptId, req, characters, samples, assets, parents)
          : await visualMatch(client, scriptId, req, entries, characters, assets, materials, parents))
      } catch (error) {
        const code = error instanceof MatchBlocked ? error.code : 'DATA_READ_FAILED'
        matches.push(base(req, 'blocked', [], code))
      }
    }
    await files.unchanged()
    return snapshot(report(matches, [], scriptId, sourceSha), entries, materials, parents)
  } catch (error) {
    const issue = error instanceof MatchBlocked ? { code: error.code, message: error.message }
      : { code: 'DATA_READ_FAILED', message: 'A matching input or provider read failed; no absence or approval was established.' }
    return snapshot(report(reqs.map(req => base(req, 'blocked', [], issue.code)), [issue], scriptId, sourceSha))
  }
}
