import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { projectMethod, type ProjectArgs } from '../src/project.ts'
import { manuscriptMethod } from '../src/manuscript.ts'
import { readProjectOperationReceipt } from '../src/project-operation.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-project-operations-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function fixture() {
  const project: Record<string, unknown> = { id: 91, scriptName: '旧项目名', parsingStatus: 5, unrelated: 'preserved' }
  const calls: { method: string; path: string; body?: unknown }[] = []
  const client = new JubianClient({ credential: async () => 'PRIVATE_TEST_TOKEN', fetch: async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url).pathname.replace('/prod-api', '')
    const method = String(init?.method)
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    let data: unknown = null
    if (path === '/aigc/script' && method === 'POST') data = 91
    else if (path === '/aigc/script/91' && method === 'GET') data = project
    else throw new Error(`Unexpected request ${method} ${path}`)
    return new Response(JSON.stringify({ code: 200, data }))
  } })
  return { client, calls }
}

const CREATE = { method: 'create', idempotency_key: 'create-project', script_name: '项目名',
  production_type: 0, produce_type: 2, script_style: 0, episode_count: 2, storyboard_count_per_episode: 1 } satisfies ProjectArgs

function contentFixture(loseResponse = false) {
  const calls: string[] = []
  const client = new JubianClient({ credential: async () => 'PRIVATE_TEST_TOKEN', fetch: async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url).pathname.replace('/prod-api', '')
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${path}`)
    let data: unknown
    if (path === '/script/center/pool/detail/73') data = { manuscript: { id: 73 } }
    else if (path === '/aigc/script/checkManuscriptProject') data = 0
    else if (method === 'POST') {
      if (loseResponse) throw new Error('response lost')
      data = 91
    } else if (path === '/aigc/script/91') data = { id: 91, manuscriptId: 73, produceType: 1 }
    else throw new Error(`Unexpected request ${method} ${path}`)
    return new Response(JSON.stringify({ code: 200, data }))
  } })
  return { client, calls }
}
const CONTENT_CREATE = { ...CREATE, produce_type: 1, manuscript_id: 73 } satisfies ProjectArgs
const START_PROJECT = { scriptName: '项目名', createType: 1 as const, productionType: 0 as const,
  produceType: 1 as const, manuscriptId: 73, scriptStyle: 0, episodeCount: 2, storyboardCountPerEpisode: 1 }

describe('project operation receipts', () => {
  it('keeps the created project ID across ledger instances without creating or reading it again', async () => {
    const f = fixture()
    const original = await projectMethod(f.client, new JubianLedger({ root }), CREATE)
    expect(original).toMatchObject({ script_id: 91, outcome: 'accepted', replayed: false })
    const calls = f.calls.length
    const replay = await projectMethod(f.client, new JubianLedger({ root }), { ...CREATE })
    expect(replay).toMatchObject({ script_id: 91, outcome: 'accepted', replayed: true, data: 91 })
    expect(f.calls).toHaveLength(calls)
    const receipt = await readFile(String(original.receipt_path), 'utf8')
    expect(receipt).not.toContain('PRIVATE_TEST_TOKEN')
    expect(JSON.parse(receipt)).toMatchObject({ request: { method: 'POST', path: '/aigc/script' }, response: { data: 91 } })
  })

  it('rejects a different business intent before preparing another remote request', async () => {
    const f = fixture()
    await projectMethod(f.client, new JubianLedger({ root }), CREATE)
    const calls = f.calls.length
    await expect(projectMethod(f.client, new JubianLedger({ root }), { ...CREATE, script_name: '另一个项目' }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(f.calls).toHaveLength(calls)
  })

  it('recognizes the same explicit settings after their JSON object key order changes', async () => {
    const f = fixture()
    await projectMethod(f.client, new JubianLedger({ root }), { ...CREATE, global_config: { modelId: 'selected', duration: 5 } })
    const calls = f.calls.length
    expect(await projectMethod(f.client, new JubianLedger({ root }), { ...CREATE, global_config: { duration: 5, modelId: 'selected' } }))
      .toMatchObject({ replayed: true, outcome: 'accepted', script_id: 91 })
    expect(f.calls).toHaveLength(calls)
  })

  it('retains accepted response data when ledger settlement fails after the receipt was saved', async () => {
    const f = fixture(), ledger = new JubianLedger({ root })
    vi.spyOn(ledger, 'settle').mockRejectedValueOnce(new Error('settlement interrupted'))
    await expect(projectMethod(f.client, ledger, CREATE)).rejects.toThrow('settlement interrupted')
    expect(await projectMethod(f.client, new JubianLedger({ root }), CREATE))
      .toMatchObject({ script_id: 91, replayed: true, outcome: 'accepted', settlement_pending: true })
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('does not repeat a recorded write when its business receipt has been lost', async () => {
    const f = fixture()
    const result = await projectMethod(f.client, new JubianLedger({ root }), CREATE)
    await rm(String(result.receipt_path))
    const count = f.calls.length
    expect(await projectMethod(f.client, new JubianLedger({ root }), CREATE))
      .toMatchObject({ replayed: true, outcome: 'unknown', script_id: null, data: null, receipt_status: 'missing' })
    expect(f.calls).toHaveLength(count)
  })

  it('keeps an ambiguous transport failure unresolved instead of trying the project creation again', async () => {
    let attempts = 0
    const client = new JubianClient({ credential: async () => 'PRIVATE_TEST_TOKEN', fetch: async () => {
      attempts += 1
      throw new Error('connection ended without a response')
    } })
    await expect(projectMethod(client, new JubianLedger({ root }), CREATE)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(await projectMethod(client, new JubianLedger({ root }), CREATE))
      .toMatchObject({ replayed: true, outcome: 'unknown', script_id: null, data: null })
    expect(attempts).toBe(1)
  })

  it('serializes simultaneous uses of one key into one provider mutation', async () => {
    const f = fixture()
    const results = await Promise.all([1, 2, 3].map(() => projectMethod(f.client, new JubianLedger({ root }), CREATE)))
    expect(results.map(result => result.script_id)).toEqual([91, 91, 91])
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('does not trust a saved response after its original ledger has disappeared', async () => {
    const f = fixture(), ledger = new JubianLedger({ root })
    await projectMethod(f.client, ledger, CREATE)
    for (const file of await ledger.files()) await rm(file)
    const count = f.calls.length
    expect(await projectMethod(f.client, new JubianLedger({ root }), CREATE))
      .toMatchObject({ replayed: true, outcome: 'unknown', script_id: null })
    expect(f.calls).toHaveLength(count)
  })

  it('verifies the exact bound manuscript before creating a content project', async () => {
    let writes = 0
    const client = new JubianClient({ credential: async () => 'PRIVATE_TEST_TOKEN', fetch: async (_url, init) => {
      if (init?.method === 'POST') writes += 1
      return new Response(JSON.stringify({ code: 200, data: { manuscript: { id: 999 } } }))
    } })
    await expect(projectMethod(client, new JubianLedger({ root }), { ...CREATE, produce_type: 1, manuscript_id: 73 }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(writes).toBe(0)
  })


  it('refuses an existing manuscript/workbench project without reinterpreting its existence indicator as an ID', async () => {
    let writes = 0
    const client = new JubianClient({ credential: async () => 'PRIVATE_TEST_TOKEN', fetch: async (url, init) => {
      if (init?.method === 'POST') writes += 1
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      return new Response(JSON.stringify({ code: 200, data: path.includes('checkManuscriptProject') ? 1 : { manuscript: { id: 73 } } }))
    } })
    await expect(projectMethod(client, new JubianLedger({ root }), { ...CREATE, produce_type: 1, manuscript_id: 73 }))
      .rejects.toThrow('already has a project')
    expect(writes).toBe(0)
  })


  it('serializes different keys across both creation tools for one manuscript and workbench', async () => {
    const f = contentFixture()
    const results = await Promise.allSettled([
      projectMethod(f.client, new JubianLedger({ root }), { ...CONTENT_CREATE, idempotency_key: 'project-entry' }),
      manuscriptMethod(f.client, new JubianLedger({ root }), { method: 'start_produce', manuscript_id: 73,
        project: START_PROJECT, idempotency_key: 'manuscript-entry' }, { maxBytes: 1024 }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    if (rejected?.status !== 'rejected') throw new Error('Expected the duplicate attempt to be refused')
    expect(rejected.reason).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(f.calls.filter(call => call.startsWith('POST '))).toHaveLength(1)
    expect(f.calls.filter(call => call.includes('checkManuscriptProject'))).toHaveLength(1)
  })

  it('blocks a new key and the other entry point after an unknown project submission', async () => {
    const f = contentFixture(true)
    await expect(manuscriptMethod(f.client, new JubianLedger({ root }), { method: 'start_produce', manuscript_id: 73,
      project: START_PROJECT, idempotency_key: 'original-unknown' }, { maxBytes: 1024 }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    const count = f.calls.length
    await expect(projectMethod(f.client, new JubianLedger({ root }), { ...CONTENT_CREATE, idempotency_key: 'replacement-key' }))
      .rejects.toThrow('original-unknown')
    expect(await manuscriptMethod(f.client, new JubianLedger({ root }), { method: 'start_produce', manuscript_id: 73,
      project: START_PROJECT, idempotency_key: 'original-unknown' }, { maxBytes: 1024 }))
      .toMatchObject({ replayed: true, outcome: 'unknown', script_id: null })
    expect(f.calls).toHaveLength(count)
  })

  it('releases the manuscript association after preflight failed before a project attempt', async () => {
    const invalid = new JubianClient({ credential: async () => 'PRIVATE_TEST_TOKEN', fetch: async () =>
      new Response(JSON.stringify({ code: 200, data: { manuscript: { id: 999 } } })) })
    await expect(projectMethod(invalid, new JubianLedger({ root }), { ...CONTENT_CREATE, idempotency_key: 'bad-preflight' }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    const f = contentFixture()
    expect(await projectMethod(f.client, new JubianLedger({ root }), { ...CONTENT_CREATE, idempotency_key: 'corrected-project' }))
      .toMatchObject({ outcome: 'accepted', script_id: 91 })
    expect(f.calls.filter(call => call.startsWith('POST '))).toHaveLength(1)
  })

  it('returns the accepted original receipt when the provider response has no scalar project ID', async () => {
    let writes = 0
    const client = new JubianClient({ credential: async () => 'PRIVATE_TEST_TOKEN', fetch: async () => {
      writes += 1
      return new Response(JSON.stringify({ code: 200, data: { id: 91 } }))
    } })
    const result = await projectMethod(client, new JubianLedger({ root }), CREATE)
    expect(result).toMatchObject({ outcome: 'accepted', script_id: null, original_idempotency_key: 'create-project',
      readback: { status: 'unavailable' } })
    expect(result.receipt_path).toEqual(expect.any(String))
    expect(await projectMethod(client, new JubianLedger({ root }), CREATE))
      .toMatchObject({ outcome: 'accepted', replayed: true, script_id: null, readback: { status: 'unavailable' } })
    expect(writes).toBe(1)
  })

})

describe('read-only original operation lookup', () => {
  it('recovers the original project ID using only the original key without network requests or writes', async () => {
    const f = fixture(), ledger = new JubianLedger({ root })
    const created = await projectMethod(f.client, ledger, CREATE)
    const files = [String(created.receipt_path), ...(await ledger.files())]
    const before = await Promise.all(files.map(file => readFile(file, 'utf8')))
    const calls = f.calls.length
    expect(await projectMethod(f.client, new JubianLedger({ root }), { method: 'operation', idempotency_key: CREATE.idempotency_key }))
      .toMatchObject({ found: true, status: 'accepted', data: 91,
        operation: { method: 'project_create', script_id: null, intent: { action: 'create' } },
        evidence: { receipt: 'recorded', ledger: 'recorded', lookup_provider_requests: 0 } })
    expect(f.calls).toHaveLength(calls)
    expect(await Promise.all(files.map(file => readFile(file, 'utf8')))).toEqual(before)
  })

  it('does not create a missing ledger directory when the original key has no record', async () => {
    const absent = join(root, 'absent')
    expect(await readProjectOperationReceipt(new JubianLedger({ root: absent }), 'original-key'))
      .toMatchObject({ found: false, status: 'not_found', data: null })
    await expect(stat(absent)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports unknown instead of guessing an ID from an accepted ledger that lost its business receipt', async () => {
    const f = fixture(), ledger = new JubianLedger({ root })
    const created = await projectMethod(f.client, ledger, CREATE)
    await rm(String(created.receipt_path))
    expect(await readProjectOperationReceipt(ledger, 'create-project'))
      .toMatchObject({ found: true, status: 'unknown', data: null,
        operation: { method: 'project_create' }, evidence: { receipt: 'missing', ledger: 'recorded' } })
  })

  it('refuses a receipt whose stored request no longer matches its recorded hash', async () => {
    const f = fixture(), ledger = new JubianLedger({ root })
    const created = await projectMethod(f.client, ledger, CREATE)
    const path = String(created.receipt_path)
    const receipt = JSON.parse(await readFile(path, 'utf8')) as { request: { path: string } }
    receipt.request.path = '/aigc/script/other'
    await writeFile(path, JSON.stringify(receipt))
    await expect(readProjectOperationReceipt(ledger, 'create-project')).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })

  it('refuses ledger identity mismatch without replacing either original file', async () => {
    const f = fixture(), ledger = new JubianLedger({ root })
    await projectMethod(f.client, ledger, CREATE)
    const record = await ledger.find('create-project')
    if (record === undefined) throw new Error('Fixture write did not create a ledger record')
    vi.spyOn(ledger, 'find').mockResolvedValue({ ...record, request_sha256: 'sha256:another-request' })
    await expect(readProjectOperationReceipt(ledger, 'create-project')).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })
})
