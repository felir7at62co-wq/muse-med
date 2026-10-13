/** Centralized reuse and storyboard selection previews; this module cannot approve or write. */
import { buildSubjectSelection, stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import type { SubjectSelectionRequest } from '@deepseek-ai/dsh-jubian-api'
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { matchingSnapshot } from './matching.ts'
import type { EntityMatch, MatchingSnapshot, MatchLimits, MatchRequirement } from './matching.ts'

type Row = Record<string, unknown>
type Status = EntityMatch['status']

/** Requirements sharing verified identity and applicability, never grouped only by name. */
export interface ReuseGroup {
  fingerprint: string
  kind: MatchRequirement['kind']
  name: string
  identity: string
  /** Explicit voice period; absent for visual and legacy unperioded groups. */
  voice_period_id?: string
  status: Status
  requirement_ids: string[]
  episodes: number[]
  conditions: string[]
  state_or_costume: string
  candidate_asset_ids: number[]
  selected_asset_id?: number
  reason_codes: string[]
  candidates: { asset_id: number; name: string; stable_id: string; state_or_costume: string }[]
  approval_required: true
}

/** A whole-card selection suggestion, with unrelated fields preserved or explicitly blocked. */
export interface ShotReusePreview {
  storyboard_id: number
  status: 'awaiting_confirmation' | 'already_bound' | 'blocked'
  reason_codes: string[]
  requirement_ids: string[]
  selections: SubjectSelectionRequest[]
  before_sha256?: string
  after_sha256?: string
  apply_allowed: false
}

/** Deterministic review data; its fingerprint supplies no authority to execute it. */
export interface ReusePreview {
  method: 'reuse_preview'
  status: Status
  script_id?: number
  fingerprint: string
  groups: ReuseGroup[]
  shots: ShotReusePreview[]
  issues: { code: string; message: string }[]
  read_only: true
  local_writes: 0
  remote_writes: 0
  paid_requests: 0
  apply_allowed: false
  next: string
}

class PlanBlocked extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PlanBlocked' }
}
function block(code: string): never { throw new PlanBlocked(code) }
function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) block('UNREADABLE_PLAN_OR_CARD')
  return value as Row
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function parsed(value: unknown): unknown { return typeof value === 'string' ? JSON.parse(value) : value }
function normalize(value: string): string { return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '') }

function groupsOf(snapshot: MatchingSnapshot): ReuseGroup[] {
  const groups = new Map<string, ReuseGroup>()
  for (const req of snapshot.requirements) {
    const match = snapshot.preview.matches.find(item => item.id === req.id) as EntityMatch
    const identity = req.kind === 'scene' ? req.stable_id : req.character_id ?? req.stable_id
    const identityType = req.kind === 'scene' || req.character_id === undefined ? 'stable_id' : 'character_id'
    const scope = { kind: req.kind, identity_type: identityType, identity: identity ?? `unverified:${req.id}`,
      ...(req.kind !== 'voice' || req.voice_period_id === undefined ? {} : { voice_period_id: req.voice_period_id }),
      conditions: req.conditions.map(normalize).sort(), state: normalize(req.state_or_costume ?? ''),
      status: match.status, asset: match.selected_asset_id ?? null, candidates: match.candidate_asset_ids }
    const key = stableSha256(scope)
    const group = groups.get(key)
    if (group) {
      group.requirement_ids.push(req.id)
      if (req.episode !== undefined && !group.episodes.includes(req.episode)) group.episodes.push(req.episode)
      group.reason_codes = [...new Set([...group.reason_codes, ...match.reason_codes])]
      continue
    }
    groups.set(key, { fingerprint: key, kind: req.kind, name: req.name, identity: identity ?? '',
      ...(req.kind !== 'voice' || req.voice_period_id === undefined ? {} : { voice_period_id: req.voice_period_id }),
      status: match.status, requirement_ids: [req.id], episodes: req.episode === undefined ? [] : [req.episode],
      conditions: req.conditions, state_or_costume: req.state_or_costume ?? '',
      candidate_asset_ids: match.candidate_asset_ids,
      ...(match.selected_asset_id === undefined ? {} : { selected_asset_id: match.selected_asset_id }),
      reason_codes: match.reason_codes, approval_required: true,
      candidates: match.candidate_asset_ids.map((id) => {
        const row = snapshot.entries.find(item => item.jubian_asset_id === id)
        return { asset_id: id, name: text(row?.name), stable_id: text(row?.stable_id), state_or_costume: text(row?.state_or_costume) }
      }) })
  }
  for (const id of new Set(snapshot.parents.map(row => row.id))) {
    const rows = snapshot.parents.filter(row => row.id === id)
    if (rows.some(row => stableSha256(row) !== stableSha256(rows[0]))) block('ASSET_VERSION_CHANGED')
  }
  return [...groups.values()].map(group => ({ ...group, fingerprint: stableSha256({ group,
    inputs: snapshot.input_sha256, parents: snapshot.parents.filter(row => group.candidate_asset_ids.includes(Number(row.id))),
    materials: snapshot.materials.filter(row => group.candidate_asset_ids.includes(Number(row.assetId))) }) }))
}

interface ShotRequest {
  storyboard_id: number
  episode: number
  episode_id: number
  bindings: { requirement_id: string; material_key: string }[]
}

function shotRequests(document: Row, limit: number): ShotRequest[] {
  if (document.version !== 1 || Object.keys(document).some(key => !['version', 'shots'].includes(key))
    || !Array.isArray(document.shots) || !document.shots.length || document.shots.length > limit) block('INVALID_REUSE_PLAN')
  const ids = new Set<number>()
  return document.shots.map((value) => {
    const row = record(value)
    if (!positive(row.storyboard_id) || ids.has(row.storyboard_id) || !positive(row.episode) || !positive(row.episode_id)
      || Object.keys(row).some(key => !['storyboard_id', 'episode', 'episode_id', 'bindings'].includes(key))
      || !Array.isArray(row.bindings) || !row.bindings.length || row.bindings.length > limit) block('INVALID_SHOT_MAPPING')
    ids.add(row.storyboard_id)
    const keys = new Set<string>()
    const bindings = row.bindings.map((value) => {
      const binding = record(value)
      if (!text(binding.requirement_id) || !text(binding.material_key) || keys.has(text(binding.material_key))
        || Object.keys(binding).some(key => !['requirement_id', 'material_key'].includes(key))) block('INVALID_SHOT_MAPPING')
      keys.add(text(binding.material_key))
      return { requirement_id: text(binding.requirement_id), material_key: text(binding.material_key) }
    })
    return { storyboard_id: row.storyboard_id, episode: row.episode, episode_id: row.episode_id, bindings }
  })
}

async function shotPreview(client: JubianClient, snapshot: MatchingSnapshot, request: ShotRequest): Promise<ShotReusePreview> {
  const result: ShotReusePreview = { storyboard_id: request.storyboard_id, status: 'blocked',
    reason_codes: [], requirement_ids: request.bindings.map(binding => binding.requirement_id), selections: [], apply_allowed: false }
  try {
    const resolved = request.bindings.map((binding) => {
      const req = snapshot.requirements.find(item => item.id === binding.requirement_id)
      const match = snapshot.preview.matches.find(item => item.id === binding.requirement_id)
      if (!req || !match || req.kind === 'voice' || req.episode !== request.episode) block('REQUIREMENT_SCOPE_MISMATCH')
      if (match.status !== 'reuse_ready' || !positive(match.selected_asset_id)) block('RELATION_NOT_REUSE_READY')
      return { ...binding, req, asset_id: match.selected_asset_id }
    })
    const { data } = await client.request({ method: 'GET', path: `/aigc/storyboard/${request.storyboard_id}` })
    const board = record(data)
    if (board.id !== request.storyboard_id || board.scriptId !== snapshot.preview.script_id) block('STORYBOARD_PROJECT_MISMATCH')
    if (board.episodeId !== request.episode_id) block('STORYBOARD_EPISODE_MISMATCH')
    const config = record(parsed(board.modelConfig))
    if (typeof config.prompt !== 'string') block('UNREADABLE_PLAN_OR_CARD')
    const rawMaterials = parsed(board.storyboardMaterialList)
    if (!Array.isArray(rawMaterials)) block('UNREADABLE_PLAN_OR_CARD')
    const current = rawMaterials.map(record)
    if (current.some(row => !text(row.materialKey) || !['image', 'audio'].includes(text(row.materialType)))
      || new Set(current.map(row => text(row.materialKey))).size !== current.length) block('UNREADABLE_PLAN_OR_CARD')
    const audioKeys = current.filter(row => row.materialType === 'audio').map(row => text(row.materialKey))
    if (resolved.some(binding => audioKeys.includes(binding.material_key))) block('IMAGE_MAPPING_TARGETS_AUDIO')
    const markers = [...config.prompt.matchAll(/@\[([^\]]+)\]\(([^()\s]+)\)/g)]
    const keys = [...new Set(markers.map(marker => text(marker[2])))].filter(key => !audioKeys.includes(key))
    for (const binding of resolved) {
      const labels = markers.filter(marker => marker[2] === binding.material_key).map(marker => normalize(text(marker[1])))
      const entry = snapshot.entries.find(row => row.jubian_asset_id === binding.asset_id)
      const aliases = Array.isArray(entry?.aliases) ? entry.aliases.filter((value): value is string => typeof value === 'string') : []
      const names = [binding.req.name, text(entry?.name), ...aliases].map(normalize)
      if (!labels.length || labels.some(label => !names.includes(label))) block('PROMPT_IDENTITY_MISMATCH')
    }
    const selections = keys.map((key) => {
      const binding = resolved.find(item => item.material_key === key)
      if (binding) return { material_key: key, asset_id: binding.asset_id }
      const row = current.find(item => item.materialKey === key && item.materialType === 'image')
      if (!row || !positive(row.materialAssetId)) block('UNMAPPED_MATERIAL')
      return { material_key: key, asset_id: row.materialAssetId }
    })
    if (current.some(row => row.materialType === 'image' && !keys.includes(text(row.materialKey)))) block('PRESERVATION_CONFLICT')
    const parents: Row[] = []
    for (const id of [...new Set(selections.map(selection => selection.asset_id))]) {
      const recorded = snapshot.parents.filter(row => row.id === id)
      const parent = recorded[0] ?? record((await client.request({ method: 'GET', path: `/aigc/asset/${id}` })).data)
      parents.push(parent)
    }
    const plan = buildSubjectSelection({ storyboard: board, selections, subjectRows: snapshot.materials, parentAssets: parents })
    const proposed = parsed(plan.payload.storyboardMaterialList) as Row[]
    for (const [index, row] of current.entries()) {
      if (!resolved.some(binding => binding.material_key === row.materialKey)
        && stableSha256(proposed[index]) !== stableSha256(row)) block('PRESERVATION_CONFLICT')
    }
    result.selections = selections
    result.before_sha256 = stableSha256(board)
    result.after_sha256 = stableSha256(plan.payload)
    result.status = plan.status === 'already_applied' ? 'already_bound' : 'awaiting_confirmation'
    result.reason_codes = [plan.status === 'already_applied' ? 'CURRENT_SELECTION_MATCHES' : 'HUMAN_CONFIRMATION_REQUIRED']
    return result
  } catch (error) {
    result.reason_codes = [error instanceof PlanBlocked ? error.code : 'CARD_READ_OR_SELECTION_FAILED']
    return result
  }
}

/**
 * Centralize source-backed matching and optional whole-card binding suggestions using reads only.
 * @param client - GET-only provider transport; no apply executor is present.
 * @param projectDir - Existing project root.
 * @param requirementsPath - Existing source-backed matching requirements.
 * @param planPath - Optional project-contained version-1 shot mapping, never approvals.
 * @param limits - Existing matching bounds, also bounding shots and bindings.
 * @returns Four-state groups, preserved-card suggestions and a non-authorizing fingerprint.
 */
export async function reusePreview(client: JubianClient, projectDir: string, requirementsPath: string,
  planPath: string | undefined, limits: MatchLimits): Promise<ReusePreview> {
  const snapshot = await matchingSnapshot(client, projectDir, requirementsPath, limits)
  const issues = [...snapshot.preview.issues]
  let groups: ReuseGroup[] = [], shots: ShotReusePreview[] = []
  let mapping: Row | undefined
  try {
    groups = groupsOf(snapshot)
    if (planPath !== undefined && snapshot.preview.status !== 'blocked') {
      mapping = await snapshot.readJson(planPath)
      const requests = shotRequests(mapping, limits.requirementsLimit)
      for (const request of requests) {
        const shot = await shotPreview(client, snapshot, request)
        shots.push(shot)
        if (shot.status === 'blocked') break
      }
      if (shots.length < requests.length) issues.push({ code: 'PLANNING_STOPPED', message: 'A card failed preflight; later cards were not inspected. No bindings were applied.' })
    }
    await snapshot.unchanged()
  } catch (error) {
    const code = error instanceof PlanBlocked ? error.code : 'INPUT_READ_OR_SOURCE_CHANGED'
    issues.push({ code,
      message: 'Reuse planning stopped. No approval, binding or asset absence was established.' })
    groups = groups.map(group => ({ ...group, status: 'blocked', reason_codes: [...group.reason_codes, code] }))
    shots = shots.map(shot => ({ ...shot, status: 'blocked', selections: [], reason_codes: [...shot.reason_codes, code] }))
  }
  const fingerprint = stableSha256({ project: snapshot.preview.script_id ?? null, source: snapshot.preview.source_sha256 ?? null,
    inputs: snapshot.input_sha256, requirements: snapshot.requirements, entries: snapshot.entries,
    materials: snapshot.materials, parents: snapshot.parents, mapping: mapping ?? null, groups, shots, issues })
  const status = issues.length || snapshot.preview.status === 'blocked' || shots.some(shot => shot.status === 'blocked') ? 'blocked' : snapshot.preview.status
  return { method: 'reuse_preview', status, ...(snapshot.preview.script_id === undefined ? {} : { script_id: snapshot.preview.script_id }),
    fingerprint, groups, shots, issues, read_only: true, local_writes: 0, remote_writes: 0, paid_requests: 0, apply_allowed: false,
    next: '匹配预览 → 复用建议 → 用户确认 → 模型调用原有 jubian_storyboard.select_assets。'
      + 'apply_allowed=false 只表示预览不授予写入权限；未授权不得绑定。用户授权后沿原工具实时校验和回读，不把计划指纹当审批。'
      + 'missing 继续检索，needs_review 人工澄清，blocked 停止受影响项；声线沿 audio_preview → audio_apply。' }
}
