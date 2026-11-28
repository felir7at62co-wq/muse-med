import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import type { ManuscriptUploadInput, ProjectCreateInput } from '@deepseek-ai/dsh-jubian-api'
import { manuscriptMethod, type ManuscriptArgs } from '../src/manuscript.ts'
import { uploadDocumentMethod } from '../src/document-upload.ts'

vi.mock('../src/document-upload.ts', async original => ({
  ...await original<typeof import('../src/document-upload.ts')>(), uploadDocumentMethod: vi.fn(),
}))

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-manuscript-')); vi.clearAllMocks() })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const UPLOAD_OPTIONS = { maxBytes: 1024 }
const METADATA: ManuscriptUploadInput = {
  scriptName: '测试剧', scriptFormat: 4, creationType: 10, producerType: 1, episodeCount: 80,
  genreTagIds: [20], eraTagId: 30, audienceTagId: 40, hasCopyright: '1', copyrightOwner: '用户声明版权方',
  manuscriptFile: { name: '剧本.docx', url: 'https://media.example/manuscript.docx', objectKey: 'prod/manuscript.docx' },
  originalFile: { name: '原文.docx', url: 'https://media.example/original.docx', objectKey: 'prod/original.docx' },
}
const PROJECT: ProjectCreateInput = { scriptName: '测试制作项目', createType: 1, productionType: 0,
  produceType: 1, manuscriptId: 73, scriptStyle: 0, episodeCount: 80, storyboardCountPerEpisode: 0 }
const DETAIL = { manuscript: { id: 73, scriptName: '测试剧', episodeCount: 80, status: 'claimed' },
  manuscriptFileName: '剧本.docx', manuscriptFileUrl: 'https://media.example/manuscript.docx',
  manuscriptObjectKey: 'prod/manuscript.docx', canModify: true, holderPostCode: 'prodlead' }

function fixture(options: {
  detail?: () => unknown
  project?: () => unknown
  registerData?: unknown
  startData?: unknown
  write?: (path: string) => Response | Promise<Response>
  tags?: () => Record<string, unknown[]>
  bindable?: unknown
  existingProjects?: unknown
  makeClient?: (clientOptions: ConstructorParameters<typeof JubianClient>[0]) => JubianClient
} = {}) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const credential = vi.fn(async () => 'unit-test-credential')
  const makeClient = options.makeClient ?? (clientOptions => new JubianClient(clientOptions))
  const client = makeClient({ credential, fetch: async (url, init) => {
    const absolute = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    const path = absolute.replace('https://web.jubianai.net/prod-api', '')
    const method = init?.method ?? 'GET'
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ method, path, body })
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (path.startsWith('/script/center/tag/listByCategory?')) {
      const category = new URL(absolute).searchParams.get('tagCategory') ?? ''
      const categories = options.tags?.() ?? { creationType: [{ id: 10, tagName: '原创', tagCode: 'original' }],
        genre: [{ id: 20, tagName: '家庭' }], era: [{ id: 30, tagName: '现代' }], audience: [{ id: 40, tagName: '通用' }] }
      return answer(categories[category])
    }
    if (path.startsWith('/script/center/pool/bindable')) {
      return answer(options.bindable ?? { total: 1, rows: [{ id: 73, scriptName: '测试剧', episodeCount: 80 }] })
    }
    if (path === '/script/center/pool/detail/73') return answer(options.detail?.() ?? DETAIL)
    if (path === '/script/center/pool/manuscriptFile/73') return answer(DETAIL)
    if (path === '/aigc/script/checkManuscriptProject?manuscriptId=73&productionType=0') return answer(options.existingProjects === undefined ? 0 : options.existingProjects)
    if (path === '/aigc/script/91') return answer(options.project?.() ?? { id: 91, scriptName: '测试制作项目',
      productionType: 0, produceType: 1, manuscriptId: 73 })
    if (method === 'POST') {
      if (options.write !== undefined) return await options.write(path)
      return answer(path === '/script/center/pool/startProduce' ? options.startData ?? 91 : options.registerData ?? null)
    }
    throw new Error(`Unexpected request ${method} ${path}`)
  } })
  const ledger = new JubianLedger({ root })
  return { client, ledger, calls, credential }
}

describe('manuscript reads', () => {
  it('returns the four current tag categories and explicit form choices without writes', async () => {
    const f = fixture()
    const result = await manuscriptMethod(f.client, f.ledger, { method: 'options' }, UPLOAD_OPTIONS)
    expect(result).toMatchObject({ script_formats: [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }],
      producer_types: [{ value: 1 }, { value: 2 }], tags: { creationType: [{ tag_id: 10, code: 'original' }] } })
    expect(f.calls).toHaveLength(4)
    expect(f.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('maps name and paging to the bindable selector and reports first-page coverage separately', async () => {
    const f = fixture()
    expect(await manuscriptMethod(f.client, f.ledger, { method: 'bindable', name: '测试剧' }, UPLOAD_OPTIONS))
      .toMatchObject({ complete: true, page_num: 1, page_size: 20, rows: [{ manuscript_id: 73, name: '测试剧' }] })
    expect(f.calls[0]?.path).toBe('/script/center/pool/bindable?keyword=%E6%B5%8B%E8%AF%95%E5%89%A7&pageNum=1&pageSize=20')
    expect(await manuscriptMethod(f.client, f.ledger, { method: 'bindable', page_num: 2 }, UPLOAD_OPTIONS))
      .toMatchObject({ complete: false, page_num: 2 })
    const missingTotal = fixture({ bindable: { rows: [] } })
    expect(await manuscriptMethod(missingTotal.client, missingTotal.ledger, { method: 'bindable' }, UPLOAD_OPTIONS))
      .toMatchObject({ total: null, complete: false })
  })

  it('does not report a different manuscript as the requested detail', async () => {
    const f = fixture({ detail: () => ({ ...DETAIL, manuscript: { id: 74 } }) })
    await expect(manuscriptMethod(f.client, f.ledger, { method: 'get', manuscript_id: 73 }, UPLOAD_OPTIONS))
      .rejects.toThrow('different ID')
    expect(f.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('checks detail identity before reading the endpoint that has no manuscript ID of its own', async () => {
    const f = fixture()
    expect(await manuscriptMethod(f.client, f.ledger, { method: 'file', manuscript_id: 73 }, UPLOAD_OPTIONS))
      .toMatchObject({ manuscript_id: 73, file: { file_name: '剧本.docx', object_key: 'prod/manuscript.docx' } })
    expect(f.calls.map(call => call.path)).toEqual(['/script/center/pool/detail/73', '/script/center/pool/manuscriptFile/73'])
    const wrong = fixture({ detail: () => ({ manuscript: { id: 74 } }) })
    await expect(manuscriptMethod(wrong.client, wrong.ledger, { method: 'file', manuscript_id: 73 }, UPLOAD_OPTIONS)).rejects.toThrow()
    expect(wrong.calls).toHaveLength(1)
  })

  it('delegates a single document upload and reports that it has not registered or parsed anything', async () => {
    vi.mocked(uploadDocumentMethod).mockResolvedValueOnce({ uploaded: true, file_name: 'source.docx',
      material_url: 'https://media.example/source.docx', object_key: 'prod/source.docx', sha256: 'sha256:fixture' })
    const f = fixture()
    const result = await manuscriptMethod(f.client, f.ledger, { method: 'upload_document', document_path: '/tmp/source.docx', idempotency_key: 'upload-1' }, UPLOAD_OPTIONS)
    expect(uploadDocumentMethod).toHaveBeenCalledExactlyOnceWith(f.client, f.ledger,
      { document_path: '/tmp/source.docx', idempotency_key: 'upload-1' }, UPLOAD_OPTIONS)
    expect(result).toMatchObject({ registered: false, ai_parsing_started: false, generation_started: false,
      file: { name: 'source.docx', url: 'https://media.example/source.docx', objectKey: 'prod/source.docx' } })
    expect(f.calls).toEqual([])
    expect(f.credential).not.toHaveBeenCalled()
  })

  it('does not retry a failed object upload', async () => {
    vi.mocked(uploadDocumentMethod).mockRejectedValueOnce(new Error('object upload unavailable'))
    const f = fixture()
    await expect(manuscriptMethod(f.client, f.ledger, { method: 'upload_document', document_path: '/tmp/source.docx', idempotency_key: 'upload-1' }, UPLOAD_OPTIONS))
      .rejects.toThrow('object upload unavailable')
    expect(uploadDocumentMethod).toHaveBeenCalledTimes(1)
    expect(f.calls).toEqual([])
  })
})

describe('manuscript upload evidence', () => {
  it('reports no file identity when the upload outcome is unknown', async () => {
    vi.mocked(uploadDocumentMethod).mockResolvedValueOnce({ uploaded: false, outcome: 'unknown', replayed: true })
    const f = fixture()
    expect(await manuscriptMethod(f.client, f.ledger, { method: 'upload_document', document_path: '/tmp/source.docx',
      idempotency_key: 'upload-unknown' }, UPLOAD_OPTIONS))
      .toMatchObject({ uploaded: false, outcome: 'unknown', file: null, registered: false })
  })
})

describe('manuscript registration receipts', () => {
  it('registers current tags and both actual Word identities without inventing a returned manuscript ID', async () => {
    const f = fixture({ registerData: 12345 })
    const result = await manuscriptMethod(f.client, f.ledger, { method: 'register', owner: 'produce',
      metadata: METADATA, idempotency_key: 'register-1' }, UPLOAD_OPTIONS)
    expect(result).toMatchObject({ outcome: 'accepted', status: 'accepted_unverified', manuscript_id: null,
      receipt_status: 'recorded', data: 12345, ai_parsing_started: false, generation_started: false })
    expect(f.calls.filter(call => call.method === 'POST')).toMatchObject([{ path: '/script/center/pool/produceUpload',
      body: { scriptName: '测试剧', creationType: '10', manuscriptFileUrl: METADATA.manuscriptFile.url,
        originalFileUrl: METADATA.originalFile.url, hasCopyright: '1', copyrightOwner: '用户声明版权方' } }])
    expect((await f.ledger.find('register-1'))?.method).toBe('manuscript_register')
  })

  it('replays the original record without rebuilding against changed or unavailable current tag lists', async () => {
    let available = true
    const f = fixture({ tags: () => {
      if (!available) throw new Error('current tag list unavailable')
      return { creationType: [{ id: 10, tagCode: 'original' }], genre: [{ id: 20 }], era: [{ id: 30 }], audience: [{ id: 40 }] }
    } })
    const args: ManuscriptArgs = { method: 'register', owner: 'produce', metadata: METADATA, idempotency_key: 'repeat-register' }
    await manuscriptMethod(f.client, f.ledger, args, UPLOAD_OPTIONS)
    const before = f.calls.length
    available = false
    expect(await manuscriptMethod(f.client, f.ledger, args, UPLOAD_OPTIONS))
      .toMatchObject({ replayed: true, outcome: 'accepted', status: 'accepted_unverified' })
    expect(f.calls).toHaveLength(before)
    await expect(manuscriptMethod(f.client, f.ledger,
      { ...args, metadata: { ...METADATA, scriptName: '另一个剧本' } }, UPLOAD_OPTIONS)).rejects.toThrow('different business operation')
    expect(f.calls).toHaveLength(before)
  })

  it('preserves an uncertain write and does not retry it under the same key', async () => {
    const f = fixture({ write: () => { throw new Error('connection closed after dispatch') } })
    const args: ManuscriptArgs = { method: 'register', owner: 'produce', metadata: METADATA, idempotency_key: 'unknown-register' }
    await expect(manuscriptMethod(f.client, f.ledger, args, UPLOAD_OPTIONS)).rejects.toThrow()
    expect((await f.ledger.find('unknown-register'))?.outcome).toBe('unknown')
    const before = f.calls.length
    expect(await manuscriptMethod(f.client, f.ledger, args, UPLOAD_OPTIONS))
      .toMatchObject({ replayed: true, outcome: 'unknown', status: 'unverified', manuscript_id: null })
    expect(f.calls).toHaveLength(before)
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('uses the chosen editor registration route without submitting an audit operation', async () => {
    const f = fixture()
    await manuscriptMethod(f.client, f.ledger, { method: 'register', owner: 'editor',
      metadata: METADATA, idempotency_key: 'editor-register' }, UPLOAD_OPTIONS)
    expect(f.calls.filter(call => call.method !== 'GET').map(call => call.path)).toEqual(['/script/center/pool/editorUpload'])
  })

  it('does not fabricate copyright declarations missing from the supplied metadata', async () => {
    const { copyrightOwner: _owner, ...metadata } = METADATA
    const f = fixture()
    await expect(manuscriptMethod(f.client, f.ledger, { method: 'register', owner: 'produce',
      metadata, idempotency_key: 'missing-owner' }, UPLOAD_OPTIONS)).rejects.toThrow('copyrightOwner')
    expect(f.calls.filter(call => call.method === 'POST')).toEqual([])
    expect(await f.ledger.records()).toEqual([])
  })
})

describe('manual production start', () => {
  it('uses a checked manuscript ID and separates the accepted request from project readback and content review', async () => {
    const f = fixture()
    const args: ManuscriptArgs = { method: 'start_produce', manuscript_id: 73, project: PROJECT, idempotency_key: 'start-1' }
    expect(await manuscriptMethod(f.client, f.ledger, args, UPLOAD_OPTIONS))
      .toMatchObject({ outcome: 'accepted', script_id: 91, manuscript_id: 73,
        readback: { status: 'read', manuscript_binding_verified: true, content_reviewed: false },
        ai_parsing_started: false, generation_started: false })
    expect(f.calls.map(call => [call.method, call.path])).toEqual([
      ['GET', '/script/center/pool/detail/73'],
      ['GET', '/aigc/script/checkManuscriptProject?manuscriptId=73&productionType=0'], ['POST', '/script/center/pool/startProduce'], ['GET', '/aigc/script/91'],
    ])
    expect(f.calls.find(call => call.method === 'POST')?.body).toEqual({ manuscriptId: 73, script: PROJECT })
  })

  it('replays the original project ID after current manuscript state changes without creating another project', async () => {
    let available = true
    const f = fixture({ detail: () => {
      if (!available) throw new Error('current manuscript is no longer available')
      return DETAIL
    } })
    const args: ManuscriptArgs = { method: 'start_produce', manuscript_id: 73, project: PROJECT, idempotency_key: 'repeat-start' }
    await manuscriptMethod(f.client, f.ledger, args, UPLOAD_OPTIONS)
    available = false
    expect(await manuscriptMethod(f.client, f.ledger, args, UPLOAD_OPTIONS))
      .toMatchObject({ replayed: true, script_id: 91, readback: { status: 'read' } })
    expect(f.calls.filter(call => call.path.includes('/detail/'))).toHaveLength(1)
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('does not assume an object response carries a proven new project ID', async () => {
    const f = fixture({ startData: { id: 91 } })
    expect(await manuscriptMethod(f.client, f.ledger, { method: 'start_produce', manuscript_id: 73,
      project: PROJECT, idempotency_key: 'object-start' }, UPLOAD_OPTIONS))
      .toMatchObject({ outcome: 'accepted', script_id: null, readback: { status: 'unavailable' } })
    expect(f.calls.filter(call => /^\/aigc\/script\/\d+$/u.test(call.path))).toHaveLength(0)
  })

  it('does not report a mismatched project readback or manuscript binding as verified', async () => {
    const wrongId = fixture({ project: () => ({ id: 92, manuscriptId: 73, produceType: 1 }) })
    expect(await manuscriptMethod(wrongId.client, wrongId.ledger, { method: 'start_produce', manuscript_id: 73,
      project: PROJECT, idempotency_key: 'wrong-project' }, UPLOAD_OPTIONS))
      .toMatchObject({ outcome: 'accepted', readback: { status: 'unavailable', content_reviewed: false } })
  })

  it('reports a generic readback reason when the project read fails with a non-Jubian error', async () => {
    class ReadbackFailure extends JubianClient {
      override async request(request: Parameters<JubianClient['request']>[0]) {
        if (request.path === '/aigc/script/91') throw new TypeError('socket reset')
        return await super.request(request)
      }
    }
    const f = fixture({ makeClient: clientOptions => new ReadbackFailure(clientOptions) })
    expect(await manuscriptMethod(f.client, f.ledger, { method: 'start_produce', manuscript_id: 73,
      project: PROJECT, idempotency_key: 'readback-failure' }, UPLOAD_OPTIONS))
      .toMatchObject({ outcome: 'accepted', script_id: 91,
        readback: { status: 'unavailable', reason: 'Project readback failed', content_reviewed: false } })
  })

  it('keeps a mismatched manuscript binding unverified', async () => {
    const wrongBinding = fixture({ project: () => ({ id: 91, manuscriptId: 74, produceType: 1 }) })
    expect(await manuscriptMethod(wrongBinding.client, wrongBinding.ledger, { method: 'start_produce', manuscript_id: 73,
      project: PROJECT, idempotency_key: 'wrong-binding' }, UPLOAD_OPTIONS))
      .toMatchObject({ readback: { status: 'read', manuscript_binding_verified: false, content_reviewed: false } })
  })

  it('rejects unbound, mismatched or automatic-parse project forms before provider reads or mutation', async () => {
    const f = fixture()
    for (const project of [{ ...PROJECT, manuscriptId: 74 }, { ...PROJECT, createType: 2 as const }]) {
      await expect(manuscriptMethod(f.client, f.ledger, { method: 'start_produce', manuscript_id: 73,
        // @ts-expect-error The second fixture checks untrusted JSON outside the public manual-only type.
        project, idempotency_key: 'invalid-project' }, UPLOAD_OPTIONS)).rejects.toThrow()
    }
    expect(f.calls).toEqual([])
  })

  it('refuses a second project for a manuscript in the same workbench before any POST', async () => {
    const f = fixture({ existingProjects: 1 })
    await expect(manuscriptMethod(f.client, f.ledger,
      { method: 'start_produce', manuscript_id: 73, project: PROJECT, idempotency_key: 'duplicate-project' }, UPLOAD_OPTIONS))
      .rejects.toThrow('already has a project')
    expect(f.calls.every(call => call.method === 'GET')).toBe(true)
    expect(await f.ledger.find('duplicate-project')).toBeUndefined()
  })

  it.each([null, '-1', -1, 1.5, {}])('does not create when duplicate-check data is unreadable: %j', async (value) => {
    const f = fixture({ existingProjects: value })
    await expect(manuscriptMethod(f.client, f.ledger,
      { method: 'start_produce', manuscript_id: 73, project: PROJECT, idempotency_key: 'unreadable-check' }, UPLOAD_OPTIONS))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(f.calls.every(call => call.method === 'GET')).toBe(true)
  })

})


it('refuses an unsupported method name before any provider request', async () => {
  const f = fixture()
  // @ts-expect-error Model-supplied JSON can carry a method outside the declared union.
  await expect(manuscriptMethod(f.client, f.ledger, { method: 'delete' }, UPLOAD_OPTIONS))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', detail: 'Unsupported jubian_manuscript method' })
  expect(f.calls).toEqual([])
})

it.each<ManuscriptArgs>([
  { method: 'get' }, { method: 'file', manuscript_id: 0 }, { method: 'bindable', page_size: 1001 },
  { method: 'register', metadata: METADATA }, { method: 'register', idempotency_key: 'no-owner', metadata: METADATA },
  { method: 'register', owner: 'produce', idempotency_key: 'no-metadata' },
  { method: 'start_produce', manuscript_id: 73, idempotency_key: 'no-project' }, { method: 'upload_document' },
])('rejects missing or unusable method arguments before resolving credentials: %j', async (args) => {
  const f = fixture()
  await expect(manuscriptMethod(f.client, f.ledger, args, UPLOAD_OPTIONS)).rejects.toThrow()
  expect(f.calls).toEqual([])
  expect(f.credential).not.toHaveBeenCalled()
})
