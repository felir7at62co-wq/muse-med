/** Manuscript registration and manual production requests from the official script-center workbench. */
import { JubianError, type JubianRequest } from '@deepseek-ai/dsh-jubian'
import { buildProjectCreateRequest, type ProjectCreateInput } from './project.ts'
import { readPayload } from './reading.ts'
import { invalid, wireHttpsUrl, wireObject, wirePositiveId } from './wire.ts'

/** Script-format codes displayed by workbench module 3344 on 2026-10-26. */
export const MANUSCRIPT_SCRIPT_FORMATS = [
  { value: 1, label: '解说漫（推文）' }, { value: 2, label: '真人剧' },
  { value: 3, label: '3D动态漫' }, { value: 4, label: '仿真人剧' },
] as const

/** Production-team codes displayed by workbench module 3344; neither is a default. */
export const MANUSCRIPT_PRODUCER_TYPES = [{ value: 1, label: '杭州' }, { value: 2, label: '厦门' }] as const

/** Categories requested by ProduceUploadDialog and AuditScriptTagsInfo. */
export const MANUSCRIPT_TAG_CATEGORIES = ['creationType', 'genre', 'era', 'audience'] as const

/** One of the manuscript form's remote tag categories. */
export type ManuscriptTagCategory = typeof MANUSCRIPT_TAG_CATEGORIES[number]

/** The production-side and editor-side registration routes are explicit, independent choices. */
export type ManuscriptOwner = 'produce' | 'editor'

/** One current remote tag option; tag IDs are distinct from semantic tag codes. */
export interface ManuscriptTag {
  tag_id: number
  name: string | null
  code: string | null
  category: ManuscriptTagCategory
  snapshot: Record<string, unknown>
}

/** All four current option lists needed to validate a registration form. */
export type ManuscriptTagOptions = Record<ManuscriptTagCategory, readonly ManuscriptTag[]>

/** One already uploaded Word document; uploading bytes belongs to the caller. */
export interface ManuscriptUploadFile {
  name: string
  url: string
  objectKey: string
}

/** Explicit metadata and the two document identities required by ProduceUploadDialog. */
export interface ManuscriptUploadInput {
  scriptName: string
  scriptFormat: 1 | 2 | 3 | 4
  /** One ID from the current creationType tag list, not a code such as original. */
  creationType: number
  sourceScriptName?: string
  producerType: 1 | 2
  episodeCount: number
  genreTagIds: readonly number[]
  eraTagId: number
  audienceTagId: number
  manuscriptFile: ManuscriptUploadFile
  originalFile: ManuscriptUploadFile
  /** The caller supplies the user's declaration; no copyright status is inferred. */
  hasCopyright: '0' | '1'
  copyrightOwner?: string
  /** Only the editor route offers assignment in the current workbench. */
  assignLeaderId?: number
}

/** File metadata returned by pool detail or manuscriptFile; absent evidence stays null. */
export interface ManuscriptFileInfo {
  file_name: string | null
  file_url: string | null
  object_key: string | null
}

/** A bindable manuscript row; this is not an AIGC project's script ID. */
export interface BindableManuscript {
  manuscript_id: number
  name: string | null
  episode_count: number | null
  status: string | null
  snapshot: Record<string, unknown>
}

/** Current pool detail and provider permissions; no absent permission is treated as granted. */
export interface ManuscriptDetail extends BindableManuscript {
  manuscript_type: number | null
  version_no: number | null
  script_format: number | null
  creation_type: string | null
  source_script_name: string | null
  producer_type: number | null
  genre_tag_ids: string | null
  era_tag_ids: string | null
  audience_tag_ids: string | null
  has_copyright: '0' | '1' | null
  copyright_owner: string | null
  holder_post_code: string | null
  can_modify: boolean | null
  can_distribute: boolean | null
  can_claim: boolean | null
  manuscript_file: ManuscriptFileInfo
  original_file: ManuscriptFileInfo
}

/** Optional filters sent by the official search-my-manuscripts selector. */
export interface BindableManuscriptQuery {
  keyword?: string
  pageNum?: number
  pageSize?: number
}

function argument(field: string): never { throw new JubianError('INVALID_ARGUMENT', field) }

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) argument(field)
  return value
}

function nonblank(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) argument(field)
  return value.trim()
}

function nullableText(value: unknown): string | null { return typeof value === 'string' ? value : null }

function nullableNumber(value: unknown): number | null {
  const candidate = typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null
}

function nullableFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return value === 1 ? true : value === 0 ? false : null
}

function selectedOwner(owner: unknown): ManuscriptOwner {
  if (owner !== 'produce' && owner !== 'editor') argument('owner')
  return owner
}

function selectedCategory(category: unknown): ManuscriptTagCategory {
  switch (category) {
    case 'creationType': case 'genre': case 'era': case 'audience': return category
    default: return argument('tag category')
  }
}

function selectedTag(options: readonly ManuscriptTag[], id: number, category: ManuscriptTagCategory): ManuscriptTag {
  positive(id, category)
  const matches = options.filter(option => option.tag_id === id && option.category === category)
  const selected = matches[0]
  if (matches.length !== 1 || selected === undefined) argument(`Select one current ${category} tag ID`)
  return selected
}

function documentFields(file: ManuscriptUploadFile, field: string): { name: string; url: string; objectKey: string } {
  const name = nonblank(file.name, `${field}.name`)
  if (!/\.docx?$/i.test(name) || /[/\\]/.test(name)) argument(`${field}.name must be a Word filename`)
  const url = wireHttpsUrl(file.url)
  if (url === null || /\s/.test(url) || new URL(url).hash) argument(`${field}.url`)
  return { name, url, objectKey: nonblank(file.objectKey, `${field}.objectKey`) }
}

function uploadBody(owner: ManuscriptOwner, input: ManuscriptUploadInput, options: ManuscriptTagOptions): Record<string, unknown> {
  const scriptName = nonblank(input.scriptName, 'scriptName')
  if (!MANUSCRIPT_SCRIPT_FORMATS.some(option => option.value === input.scriptFormat)) argument('scriptFormat')
  if (!MANUSCRIPT_PRODUCER_TYPES.some(option => option.value === input.producerType)) argument('producerType')
  const episodeCount = positive(input.episodeCount, 'episodeCount')
  if (episodeCount > 200) argument('episodeCount must not exceed 200')
  const creation = selectedTag(options.creationType, input.creationType, 'creationType')
  if (input.genreTagIds.length < 1 || input.genreTagIds.length > 4
    || new Set(input.genreTagIds).size !== input.genreTagIds.length) argument('Select 1..4 different genre tag IDs')
  for (const id of input.genreTagIds) selectedTag(options.genre, id, 'genre')
  selectedTag(options.era, input.eraTagId, 'era')
  selectedTag(options.audience, input.audienceTagId, 'audience')
  let sourceScriptName: string | null = null
  if (creation.code !== 'original' && input.sourceScriptName !== undefined) {
    sourceScriptName = nonblank(input.sourceScriptName, 'sourceScriptName')
  }
  if ((creation.code === 'iteration' || creation.code === 'rewrite') && sourceScriptName === null) argument('sourceScriptName')
  let copyrightOwner: string | null = null
  switch (input.hasCopyright) {
    case '1': copyrightOwner = nonblank(input.copyrightOwner ?? '', 'copyrightOwner'); break
    case '0': break
    default: argument('hasCopyright')
  }
  const manuscript = documentFields(input.manuscriptFile, 'manuscriptFile')
  const original = documentFields(input.originalFile, 'originalFile')
  if (owner === 'produce' && input.assignLeaderId !== undefined) argument('assignLeaderId is only offered by editor registration')
  const assignLeaderId = input.assignLeaderId === undefined ? null : positive(input.assignLeaderId, 'assignLeaderId')
  return { scriptName, scriptFormat: input.scriptFormat, creationType: String(input.creationType), sourceScriptName,
    producerType: input.producerType, episodeCount, genreTagIds: input.genreTagIds.join(','),
    eraTagIds: String(input.eraTagId), audienceTagIds: String(input.audienceTagId),
    hasCopyright: input.hasCopyright, copyrightOwner,
    originalNovelName: original.name.replace(/\.[^.]+$/, ''), manuscriptName: manuscript.name.replace(/\.[^.]+$/, ''),
    manuscriptFileName: manuscript.name, manuscriptFileUrl: manuscript.url, manuscriptObjectKey: manuscript.objectKey,
    originalFileName: original.name, originalFileUrl: original.url, originalObjectKey: original.objectKey,
    assignLeaderId }
}

/**
 * Query one current tag category used by the registration form, without creating tags.
 * @param category - creationType, genre, era or audience from the current workbench.
 * @returns The GET request for /script/center/tag/listByCategory.
 */
export function buildManuscriptTagOptionsRequest(category: ManuscriptTagCategory): JubianRequest {
  return { method: 'GET', path: `/script/center/tag/listByCategory?tagCategory=${selectedCategory(category)}` }
}

/**
 * Read ScriptCenterTags' option array, distinguishing tag IDs from semantic codes.
 * @param data - Envelope data from the listByCategory request.
 * @param category - Category used in that exact query.
 * @returns Validated options, with unknown fields retained in detached snapshots.
 */
export function readManuscriptTagOptions(data: unknown, category: ManuscriptTagCategory): ManuscriptTag[] {
  const selected = selectedCategory(category)
  return readPayload('readManuscriptTagOptions', data, () => {
    if (!Array.isArray(data)) invalid()
    const ids = new Set<number>()
    return data.map((value) => {
      const row = wireObject(value)
      const id = wirePositiveId(row.id)
      if (ids.has(id) || (row.tagCategory !== undefined && row.tagCategory !== selected)) invalid()
      ids.add(id)
      return { tag_id: id, name: nullableText(row.tagName), code: nullableText(row.tagCode),
        category: selected, snapshot: structuredClone(row) }
    })
  })
}

/**
 * Register already uploaded Word files through the selected owner's existing-manuscript route.
 * Evidence: ProduceUploadDialog, chunk-165f436a.f1c0b02a.js, handleSubmit at character 19584; wrapper 027b.
 * @param owner - produce uses produceUpload; editor uses editorUpload and may assign a leader.
 * @param input - Explicit metadata, document identities and the user's copyright declaration.
 * @param options - Current category lists used to resolve the selected IDs and source-name requirement.
 * @returns A POST request; neither uploads bytes nor submits an editor-audit task.
 */
export function buildManuscriptUploadRequest(owner: ManuscriptOwner, input: ManuscriptUploadInput,
  options: ManuscriptTagOptions): JubianRequest {
  const selected = selectedOwner(owner)
  return { method: 'POST', path: `/script/center/pool/${selected === 'produce' ? 'produceUpload' : 'editorUpload'}`,
    body: uploadBody(selected, input, options) }
}

/**
 * Start manual production with the same bound manuscript inside and outside the project form.
 * Evidence: ScriptCenterPoolDetail.handleProduceSubmit posts {manuscriptId, script: form} through wrapper 027b.
 * @param manuscriptId - Existing manuscript selected for production, not an AIGC project ID.
 * @param project - Explicit manual project form bound to this manuscript; no parsing or audit is selected.
 * @returns The POST /script/center/pool/startProduce request.
 */
export function buildManuscriptStartProduceRequest(manuscriptId: number, project: ProjectCreateInput): JubianRequest {
  const id = positive(manuscriptId, 'manuscript_id')
  if (project.produceType !== 1 || project.manuscriptId !== id) {
    argument('Manual production requires createType=1, produceType=1 and the same manuscriptId')
  }
  return { method: 'POST', path: '/script/center/pool/startProduce',
    body: { manuscriptId: id, script: buildProjectCreateRequest(project) } }
}

/**
 * Search the current account's bindable manuscripts using the workbench selector's filters.
 * @param query - Explicit keyword and pagination; omitted values are not replaced with hidden defaults.
 * @returns A GET request, distinct from listing AIGC projects or claiming a pool manuscript.
 */
export function buildBindableManuscriptsRequest(query: BindableManuscriptQuery): JubianRequest {
  const params = new URLSearchParams()
  if (query.keyword !== undefined) params.set('keyword', nonblank(query.keyword, 'keyword'))
  if (query.pageNum !== undefined) params.set('pageNum', String(positive(query.pageNum, 'pageNum')))
  if (query.pageSize !== undefined) params.set('pageSize', String(positive(query.pageSize, 'pageSize')))
  return { method: 'GET', path: `/script/center/pool/bindable${params.size ? `?${params}` : ''}` }
}

/**
 * Read a bindable selector page without claiming full coverage when no total was returned.
 * @param data - Normalized payload from /script/center/pool/bindable.
 * @returns Manuscript rows and the provider total when present.
 */
export function readBindableManuscripts(data: unknown): { total: number | null; rows: BindableManuscript[] } {
  return readPayload('readBindableManuscripts', data, () => {
    const page = wireObject(data)
    if (!Array.isArray(page.rows)) invalid()
    const total = nullableNumber(page.total)
    if (page.total !== undefined && total === null) invalid()
    return { total, rows: page.rows.map((value) => {
      const row = wireObject(value)
      return { manuscript_id: wirePositiveId(row.id), name: nullableText(row.scriptName),
        episode_count: nullableNumber(row.episodeCount), status: nullableText(row.status), snapshot: structuredClone(row) }
    }) }
  })
}

/**
 * Address one pool manuscript detail without claiming, publishing or changing it.
 * @param manuscriptId - Existing manuscript ID.
 * @returns The GET /script/center/pool/detail/{id} request.
 */
export function buildManuscriptDetailRequest(manuscriptId: number): JubianRequest {
  return { method: 'GET', path: `/script/center/pool/detail/${positive(manuscriptId, 'manuscript_id')}` }
}

function fileInfo(row: Record<string, unknown>, kind: 'manuscript' | 'original'): ManuscriptFileInfo {
  return { file_name: nullableText(row[`${kind}FileName`]), file_url: wireHttpsUrl(row[`${kind}FileUrl`]),
    object_key: nullableText(row[kind === 'manuscript' ? 'manuscriptObjectKey' : 'originalObjectKey']) }
}

/**
 * Read the pool detail wrapper used by ProduceUploadDialog and ScriptCenterPoolDetail.
 * @param data - Envelope data with its manuscript record, file metadata and account permissions.
 * @returns Current identities and metadata; absent permissions remain null and unknown fields stay in snapshot.
 */
export function readManuscriptDetail(data: unknown): ManuscriptDetail {
  return readPayload('readManuscriptDetail', data, () => {
    const row = wireObject(data)
    const manuscript = wireObject(row.manuscript)
    const copyright = manuscript.hasCopyright
    return { manuscript_id: wirePositiveId(manuscript.id), name: nullableText(manuscript.scriptName),
      episode_count: nullableNumber(manuscript.episodeCount), status: nullableText(manuscript.status),
      manuscript_type: nullableNumber(manuscript.manuscriptType), version_no: nullableNumber(manuscript.versionNo),
      script_format: nullableNumber(manuscript.scriptFormat), creation_type: nullableText(manuscript.creationType),
      source_script_name: nullableText(manuscript.sourceScriptName), producer_type: nullableNumber(manuscript.producerType),
      genre_tag_ids: nullableText(manuscript.genreTagIds), era_tag_ids: nullableText(manuscript.eraTagIds),
      audience_tag_ids: nullableText(manuscript.audienceTagIds),
      has_copyright: copyright === '0' || copyright === '1' ? copyright : null,
      copyright_owner: nullableText(manuscript.copyrightOwner), holder_post_code: nullableText(row.holderPostCode),
      can_modify: nullableFlag(row.canModify), can_distribute: nullableFlag(row.canDistribute),
      can_claim: nullableFlag(row.canClaim),
      manuscript_file: fileInfo(row, 'manuscript'), original_file: fileInfo(row, 'original'), snapshot: structuredClone(row) }
  })
}

/**
 * Address the bound-file lookup used to preset the project creation dialog.
 * @param manuscriptId - Existing manuscript selected by the caller.
 * @returns The GET /script/center/pool/manuscriptFile/{id} request.
 */
export function buildManuscriptFileRequest(manuscriptId: number): JubianRequest {
  return { method: 'GET', path: `/script/center/pool/manuscriptFile/${positive(manuscriptId, 'manuscript_id')}` }
}

/**
 * Read the manuscriptFile lookup without assuming an ID or upload receipt the frontend does not inspect.
 * @param data - Envelope data from /script/center/pool/manuscriptFile/{id}.
 * @returns Known file metadata and the detached provider record; no uploaded-record ID is inferred.
 */
export function readManuscriptFile(data: unknown): ManuscriptFileInfo & { snapshot: Record<string, unknown> } {
  return readPayload('readManuscriptFile', data, () => {
    const row = wireObject(data)
    return { ...fileInfo(row, 'manuscript'), snapshot: structuredClone(row) }
  })
}
