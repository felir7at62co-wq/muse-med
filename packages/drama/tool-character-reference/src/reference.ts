/** Local, opt-in public character reference lookup. No project or network operations. */
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface CharacterReferenceRequest {
  role_description: string
  style?: 'urban' | 'ancient'
  desired_tags?: string[]
  era?: string
}

interface SourcedValue {
  value: string
  source: { kind: string; record: string }
}
interface DraftObject {
  reference_id: string
  scope: string
  status: string
  media: string
  metadata_relative_path: string
  image_relative_path: string
  sha256: string
  bytes: number
  rights_status: string
  reuse_approved: boolean
  usage_policy: { direct_use: boolean; agent_selection_required: boolean; auto_bind: boolean }
  search: {
    style: string
    genre: string[]
    tags: string[]
    appearance: { descriptors: SourcedValue[]; style_candidates: SourcedValue[] }
    role_fit: { suitable_eras: SourcedValue[]; avoid_eras: SourcedValue[]; unconfirmed_eras: SourcedValue[] }
  }
}

export interface CharacterReferenceResult {
  status: 'recommended' | 'no_match' | 'needs_review'
  search_scope: 'local_draft_public_reference'
  recommendation?: { reference_id: string; preview_path: string; metadata_path: string; status: string }
  reason: string
  evidence: { label: string; source_kind: string; source_record: string }[]
  uncertainty: string[]
  read_only: true
  apply_allowed: false
  local_writes: 0
  remote_writes: 0
  paid_requests: 0
}

const safety = { read_only: true, apply_allowed: false, local_writes: 0, remote_writes: 0, paid_requests: 0 } as const
const normalized = (value: string): string => value.trim().toLocaleLowerCase()
const within = (root: string, file: string): boolean => {
  const rel = relative(root, file)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function draftFile(root: string, relativePath: string): Promise<string> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error('Reference index contains an unsafe relative path.')
  }
  const file = await realpath(resolve(root, relativePath))
  if (!within(root, file)) throw new Error('Reference index path escapes the configured draft root.')
  return file
}

function sourced(values: unknown): values is SourcedValue[] {
  return Array.isArray(values) && values.every((item: unknown) => {
    if (item === null || typeof item !== 'object') return false
    const value = item as Partial<SourcedValue>
    return typeof value.value === 'string' && typeof value.source?.kind === 'string'
      && typeof value.source.record === 'string'
  })
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'

function validEntry(value: unknown): value is DraftObject {
  if (!record(value) || !record(value.usage_policy) || !record(value.search)) return false
  const policy = value.usage_policy
  const search = value.search
  if (!record(search.appearance) || !record(search.role_fit)) return false
  const appearance = search.appearance
  const fit = search.role_fit
  const descriptors = appearance.descriptors
  const styleCandidates = appearance.style_candidates
  if (!sourced(descriptors) || !sourced(styleCandidates)) return false
  return typeof value.reference_id === 'string' && typeof value.scope === 'string'
    && typeof value.status === 'string' && typeof value.media === 'string'
    && typeof value.metadata_relative_path === 'string' && typeof value.image_relative_path === 'string'
    && typeof value.sha256 === 'string' && typeof value.bytes === 'number'
    && typeof value.rights_status === 'string' && typeof value.reuse_approved === 'boolean'
    && policy.direct_use === false && policy.auto_bind === false && policy.agent_selection_required === true
    && typeof search.style === 'string' && Array.isArray(search.tags) && Array.isArray(search.genre)
    && search.tags.every((tag: unknown) => typeof tag === 'string')
    && search.genre.every((genre: unknown) => typeof genre === 'string')
    && search.tags.every((tag: string) => descriptors.some(item => item.value === tag))
    && (search.style === 'unknown' || styleCandidates.some(item => item.value === search.style))
    && sourced(fit.suitable_eras) && sourced(fit.avoid_eras) && sourced(fit.unconfirmed_eras)
}

/** Verify the QA draft and its local images before recommending any reference. */
async function loadDraft(indexPath: string): Promise<{ root: string; objects: DraftObject[] }> {
  if (!isAbsolute(indexPath)) throw new Error('referenceIndexPath must be absolute.')
  const actualIndex = await realpath(indexPath)
  const root = resolve(actualIndex, '..')
  const index = JSON.parse(await readFile(actualIndex, 'utf8')) as {
    schema_version?: number
    index_type?: string
    lifecycle?: string
    publishable?: boolean
    total?: number
    objects?: unknown[]
  }
  if (index.schema_version !== 1 || index.index_type !== 'character_reference'
    || index.lifecycle !== 'draft' || index.publishable !== false
    || !Array.isArray(index.objects) || index.total !== index.objects.length) {
    throw new Error('Configured character reference index is not a complete local draft.')
  }
  const ids = new Set<string>()
  const objects: DraftObject[] = []
  for (const item of index.objects) {
    if (!validEntry(item) || !/^char_3d_\d{4}$/.test(item.reference_id)
      || ids.has(item.reference_id) || item.scope !== 'public_reference' || item.media !== 'image') {
      throw new Error('Character reference draft contains an invalid or duplicate entry.')
    }
    objects.push(item)
    ids.add(item.reference_id)
    const metadataPath = await draftFile(root, item.metadata_relative_path)
    const imagePath = await draftFile(root, item.image_relative_path)
    if (resolve(metadataPath, '..') !== resolve(imagePath, '..')
      || resolve(metadataPath, '..').split(sep).at(-1) !== item.reference_id) {
      throw new Error('Reference metadata and image must share their character directory.')
    }
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      id?: string
      schema_version?: number
      scope?: string
      status?: string
      asset_role?: string
      usage_policy?: DraftObject['usage_policy']
      style?: string
      genre?: string[]
      tags?: string[]
      appearance?: DraftObject['search']['appearance']
      role_fit?: DraftObject['search']['role_fit']
      images?: { filename: string; sha256: string; bytes: number }[]
    }
    if (metadata.id !== item.reference_id || metadata.schema_version !== 2
      || metadata.asset_role !== 'reference'
      || metadata.scope !== 'public_reference' || metadata.status !== item.status
      || JSON.stringify(metadata.usage_policy) !== JSON.stringify(item.usage_policy)
      || metadata.style !== item.search.style
      || JSON.stringify(metadata.genre) !== JSON.stringify(item.search.genre)
      || JSON.stringify(metadata.tags) !== JSON.stringify(item.search.tags)
      || JSON.stringify(metadata.appearance) !== JSON.stringify(item.search.appearance)
      || JSON.stringify(metadata.role_fit) !== JSON.stringify(item.search.role_fit)
      || !metadata.images?.some(image => image.filename === imagePath.split(sep).at(-1)
        && image.sha256 === item.sha256 && image.bytes === item.bytes)) {
      throw new Error('Reference index does not match its v2 metadata.')
    }
    const bytes = await readFile(imagePath)
    if ((await stat(imagePath)).size !== item.bytes
      || createHash('sha256').update(bytes).digest('hex') !== item.sha256) {
      throw new Error('Reference image differs from the draft index.')
    }
  }
  return { root, objects }
}

/** Recommend at most one local reference; unknown eras and tied evidence never imply a safe fit. */
export async function recommendCharacterReference(
  indexPath: string, request: CharacterReferenceRequest,
): Promise<CharacterReferenceResult> {
  if (!request.role_description.trim() || request.role_description.length > 2000
    || (request.desired_tags && (!Array.isArray(request.desired_tags) || request.desired_tags.length > 20))) {
    throw new Error('A bounded role description and up to 20 desired tags are required.')
  }
  const { root, objects } = await loadDraft(indexPath)
  const wanted = [...new Set((request.desired_tags ?? []).map(normalized).filter(Boolean))]
  const description = normalized(request.role_description)
  const era = normalized(request.era ?? '')
  const ranked = objects.flatMap((item) => {
    const styles = [item.search.style, ...item.search.appearance.style_candidates.map(value => value.value)]
    if (request.style && !styles.includes(request.style)) return []
    const roleFit = item.search.role_fit
    if (era && (!roleFit.suitable_eras.some(value => normalized(value.value) === era)
      || roleFit.avoid_eras.some(value => normalized(value.value) === era)
      || roleFit.unconfirmed_eras.some(value => normalized(value.value) === era))) return []
    const tags = [...item.search.tags, ...item.search.appearance.descriptors.map(value => value.value)]
    const matched = wanted.length
      ? wanted.filter(tag => tags.some(value => normalized(value) === tag))
      : [...new Set(tags.filter(value => description.includes(normalized(value))))]
    if (wanted.length && matched.length !== wanted.length) return []
    const score = (request.style && item.search.style === request.style ? 4 : 0)
      + (request.style && item.search.style !== request.style ? 1 : 0) + matched.length * 3
    if (!score) return []
    return [{ item, score, matched }]
  }).sort((a, b) => b.score - a.score || a.item.reference_id.localeCompare(b.item.reference_id))
  const base = { search_scope: 'local_draft_public_reference' as const, ...safety }
  const first = ranked.at(0)
  if (!first) return { ...base, status: 'no_match', reason: '本地草稿索引没有足够证据支持此角色需求。',
    evidence: [],
    uncertainty: ['角色需求来自调用方，未与剧本原文核验；未做视觉模型或人工复核。'] }
  if (ranked.at(1)?.score === first.score) {
    return { ...base, status: 'needs_review', reason: '多个人物参考的现有证据同分，不能可靠选出唯一最佳。',
      evidence: [],
      uncertainty: ['需要补充更具体的服装或外观要求；不自动以编号打破平局。'] }
  }
  const { item, matched } = first
  const evidence = [...item.search.appearance.style_candidates
    .filter(value => value.value === request.style)
    .map(value => ({ label: `style:${value.value}`, source_kind: value.source.kind,
      source_record: value.source.record })),
  ...item.search.appearance.descriptors
    .filter(value => matched.some(tag => normalized(tag) === normalized(value.value)))
    .map(value => ({ label: value.value, source_kind: value.source.kind,
      source_record: value.source.record }))]
  const uncertainty = ['角色需求来自调用方，未与剧本原文核验。', '索引仅为本地草稿，未完成本次看图验收。',
    '人物年龄、性别与身份未核验。']
  if (item.status !== 'approved') uncertainty.push('素材仍为待审核，不能直接用于制作。')
  if (!item.reuse_approved || item.rights_status !== 'confirmed') uncertainty.push('复用权利尚未确认。')
  if (item.search.style === 'unknown') uncertainty.push('风格只是候选，尚未正式确认。')
  const reason = [request.style ? `风格候选：${request.style}` : '',
    matched.length ? `已登记的外观标签：${matched.join('、')}` : ''].filter(Boolean).join('；')
  return { ...base, status: 'recommended', recommendation: {
    reference_id: item.reference_id, preview_path: await draftFile(root, item.image_relative_path),
    metadata_path: await draftFile(root, item.metadata_relative_path), status: item.status,
  }, reason: `${reason}。这是参考推荐，不是批准或绑定。`, evidence, uncertainty }
}
