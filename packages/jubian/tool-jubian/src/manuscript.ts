/** Account-scoped manuscript registration and manual project creation with original-operation receipts. */
import { JubianError, type JubianClient, type JubianLedger } from '@deepseek-ai/dsh-jubian'
import { MANUSCRIPT_PRODUCER_TYPES, MANUSCRIPT_SCRIPT_FORMATS, MANUSCRIPT_TAG_CATEGORIES,
  buildBindableManuscriptsRequest, buildManuscriptDetailRequest, buildManuscriptFileRequest,
  buildManuscriptStartProduceRequest, buildManuscriptTagOptionsRequest,
  buildManuscriptUploadRequest, readBindableManuscripts, readCreatedProjectId, readManuscriptDetail,
  readManuscriptFile, readManuscriptTagOptions, readProjectDetail } from '@deepseek-ai/dsh-jubian-api'
import type { ManuscriptDetail, ManuscriptOwner, ManuscriptTagCategory, ManuscriptTagOptions, ManuscriptUploadInput,
  ProjectCreateInput } from '@deepseek-ai/dsh-jubian-api'
import { uploadDocumentMethod, type DocumentUploadOptions } from './document-upload.ts'
import { projectOperation, type ProjectOperationOutcome } from './project-operation.ts'
import { ensureNoManuscriptProject } from './project.ts'
import { need, requireKey } from './write.ts'

/** Tool arguments; registration metadata and copyright declarations are supplied explicitly. */
export interface ManuscriptArgs {
  method: 'options' | 'bindable' | 'get' | 'file' | 'upload_document' | 'register' | 'start_produce'
  script_id?: number
  manuscript_id?: number
  name?: string
  page_num?: number
  page_size?: number
  owner?: ManuscriptOwner
  metadata?: ManuscriptUploadInput
  project?: ProjectCreateInput
  document_path?: string
  idempotency_key?: string
}

function positive(value: number | undefined, field: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new JubianError('INVALID_ARGUMENT', `${field} must be a positive integer`)
  }
  return value
}

function view<T extends { snapshot: Record<string, unknown> }>(record: T): Omit<T, 'snapshot'> {
  const { snapshot: _snapshot, ...fields } = record
  return fields
}

async function manuscriptAt(client: JubianClient, manuscriptId: number): Promise<ManuscriptDetail> {
  const response = await client.request(buildManuscriptDetailRequest(manuscriptId))
  const detail = readManuscriptDetail(response.data)
  if (detail.manuscript_id !== manuscriptId) throw new JubianError('CONTRACT_CHANGED', 'Manuscript readback returned a different ID')
  return detail
}

async function tagOptions(client: JubianClient): Promise<ManuscriptTagOptions> {
  const read = async (category: ManuscriptTagCategory) => {
    const response = await client.request(buildManuscriptTagOptionsRequest(category))
    return readManuscriptTagOptions(response.data, category)
  }
  const [creationType, genre, era, audience] = await Promise.all([
    read('creationType'), read('genre'), read('era'), read('audience')])
  return { creationType, genre, era, audience }
}

function resolvedQuery(args: ManuscriptArgs): { pageNum: number; pageSize: number; keyword?: string } {
  const pageNum = positive(args.page_num ?? 1, 'page_num')
  const pageSize = positive(args.page_size ?? 20, 'page_size')
  if (pageSize > 1000) throw new JubianError('INVALID_ARGUMENT', 'page_size must be within 1..1000')
  return { pageNum, pageSize, ...(args.name === undefined ? {} : { keyword: args.name }) }
}

function registrationResult(args: ManuscriptArgs, result: ProjectOperationOutcome): Record<string, unknown> {
  return { method: args.method, ...result, status: result.outcome === 'accepted' ? 'accepted_unverified' : 'unverified',
    manuscript_id: null,
    original_idempotency_key: args.idempotency_key, ai_parsing_started: false, generation_started: false,
    next: '受理回执不证明已定位或完整核对稿件。先用 bindable 搜索，再 get 精确稿件 ID，核对两份 Word 的名称、URL、objectKey 和元数据。保留本次原 key；未知结果不换 key 重复登记，也不把稿件 ID 当制作项目 ID。' }
}

async function startedProjectReadback(client: JubianClient, result: ProjectOperationOutcome,
  manuscriptId: number): Promise<{ script_id: number | null; readback: Record<string, unknown> }> {
  if (result.outcome !== 'accepted') {
    return { script_id: null, readback: { status: 'not_read', reason: 'The original operation has no accepted response; reconcile its receipt before creating again.' } }
  }
  let scriptId: number
  try { scriptId = readCreatedProjectId(result.data) }
  catch (_error) {
    return { script_id: null, readback: { status: 'unavailable', reason: 'The response does not prove a scalar project ID; reconcile the original receipt.' } }
  }
  try {
    const response = await client.request({ method: 'GET', path: `/aigc/script/${scriptId}` })
    const project = readProjectDetail(response.data)
    if (project.script_id !== scriptId) throw new JubianError('CONTRACT_CHANGED', 'Project readback returned a different ID')
    return { script_id: scriptId, readback: { status: 'read', project: view(project),
      manuscript_binding_verified: project.manuscript_id === manuscriptId && project.produce_type === 1,
      content_reviewed: false } }
  } catch (error) {
    return { script_id: scriptId, readback: { status: 'unavailable',
      reason: error instanceof JubianError ? error.message : 'Project readback failed', content_reviewed: false } }
  }
}

/**
 * Read manuscript metadata, upload document objects, register files or start manual production.
 * @param client - Existing authenticated account client; token values are never copied into operation receipts.
 * @param ledger - Existing write history used with durable intent and response receipts.
 * @param args - Explicit owner route, record identities, real metadata and the original idempotency key.
 * @param documentOptions - Deployment-owned upload byte limit for local resource use.
 * @returns Current metadata or separate acceptance/readback evidence; no automatic parsing, audit submission or generation.
 */
export async function manuscriptMethod(client: JubianClient, ledger: JubianLedger, args: ManuscriptArgs,
  documentOptions: DocumentUploadOptions): Promise<Record<string, unknown>> {
  switch (args.method) {
    case 'options': {
      const tags = await tagOptions(client)
      return { script_formats: MANUSCRIPT_SCRIPT_FORMATS, producer_types: MANUSCRIPT_PRODUCER_TYPES,
        tags: Object.fromEntries(MANUSCRIPT_TAG_CATEGORIES.map(category => [category, tags[category].map(view)])),
        next: '按当前标签 ID 填写 metadata：creationType 一个，genreTagIds 1–4 个，eraTagId 与 audienceTagId 各一个。版权与原文来源按用户实际信息填写；不从 UI 默认值、文件上传或模型推断。稿件登记分别需要剧本和原文两份 Word 的真实文件信息。' }
    }
    case 'bindable': {
      const query = resolvedQuery(args)
      const response = await client.request(buildBindableManuscriptsRequest(query))
      const page = readBindableManuscripts(response.data)
      return { total: page.total, rows: page.rows.map(view), page_num: query.pageNum, page_size: query.pageSize,
        complete: page.total !== null && query.pageNum === 1 && page.rows.length >= page.total,
        next: '这里的 manuscript_id 是可绑定稿件 ID，不是制作项目 script_id。按 total 分页；total 缺失时不能声称已覆盖全部。' }
    }
    case 'get':
      return { manuscript: view(await manuscriptAt(client, positive(args.manuscript_id, 'manuscript_id'))) }
    case 'file': {
      const id = positive(args.manuscript_id, 'manuscript_id')
      await manuscriptAt(client, id)
      const response = await client.request(buildManuscriptFileRequest(id))
      return { manuscript_id: id, file: view(readManuscriptFile(response.data)),
        identity_basis: 'Exact manuscript detail ID checked before the manuscriptFile lookup; that file response does not carry its own manuscript ID.' }
    }
    case 'upload_document': {
      const result = await uploadDocumentMethod(client, ledger, { document_path: need(args.document_path, 'document_path'),
        idempotency_key: requireKey(args.idempotency_key) }, documentOptions)
      return { ...result, file: result.uploaded === true
        ? { name: result.file_name, url: result.material_url, objectKey: result.object_key } : null,
      registered: false, ai_parsing_started: false, generation_started: false,
      next: '仅上传了原样文档对象，尚未登记稿件、创建项目或解析。Word 的 file 可填入 metadata.manuscriptFile 或 originalFile 的对应真实文件位置；TXT 不能用于 Word 稿件登记。原 key 回放只返回原上传回执，不重读变化的源文件或重发上传；结果未知时用原 key 对账，不反复上传。' }
    }
    case 'register': {
      const key = requireKey(args.idempotency_key)
      const owner = need(args.owner, 'owner')
      const metadata = need(args.metadata, 'metadata')
      const result = await projectOperation(client, ledger, { key, method: 'manuscript_register',
        intent: { operation: 'register', owner, metadata },
        prepare: async () => {
          const options = await tagOptions(client)
          return buildManuscriptUploadRequest(owner, metadata, options)
        } })
      return registrationResult(args, result)
    }
    case 'start_produce': {
      const key = requireKey(args.idempotency_key)
      const id = positive(args.manuscript_id, 'manuscript_id')
      const project = need(args.project, 'project')
      const result = await projectOperation(client, ledger, { key, method: 'project_create',
        binding: { manuscriptId: id, productionType: project.productionType },
        intent: { operation: 'start_produce', manuscript_id: id, project },
        prepare: async () => {
          const request = buildManuscriptStartProduceRequest(id, project)
          if (project.productionType === 0) {
            need(project.scriptStyle, 'project.scriptStyle')
            need(project.episodeCount, 'project.episodeCount')
            need(project.storyboardCountPerEpisode, 'project.storyboardCountPerEpisode')
          }
          await manuscriptAt(client, id)
          await ensureNoManuscriptProject(client, id, project.productionType)
          return request
        } })
      return { method: args.method, manuscript_id: id, ...result,
        ...await startedProjectReadback(client, result, id),
        original_idempotency_key: args.idempotency_key, ai_parsing_started: false, generation_started: false,
        next: '这是开始手动制作的受理与项目回读，不代表剧本内容已经审核或整剧制作完成。继续使用回读到的制作项目 script_id；未知结果保留原 key 对账，不重新建项目。' }
    }
    default: throw new JubianError('INVALID_ARGUMENT', 'Unsupported jubian_manuscript method')
  }
}
