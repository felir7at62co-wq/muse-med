import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JubianClient, JubianLedger, type JubianRequest } from '@deepseek-ai/dsh-jubian'
import { projectOperation, projectOperationReceiptPath, readProjectOperationReceipt,
  type ProjectOperationInput } from '../src/project-operation.ts'
import { bodyHash } from '../src/write.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-operation-receipts-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

const KEY = 'operation-key'
const ledger = () => new JubianLedger({ root })

/** A provider that answers every request with one JSON envelope and records the methods it received. */
function provider(data: unknown = { id: 1 }) {
  const calls: string[] = []
  const client = new JubianClient({ credential: async () => 'unit-test-credential', fetch: async (_input, init) => {
    calls.push(String(init?.method))
    return new Response(JSON.stringify({ code: 200, data }))
  } })
  return { client, calls }
}

function input(overrides: Partial<ProjectOperationInput> = {}): ProjectOperationInput {
  return { key: KEY, method: 'project_create', intent: { operation: 'fixture' },
    prepare: async () => ({ method: 'POST', path: '/aigc/fixture', body: { name: 'fixture' } }), ...overrides }
}

/** The receipt fields that the tampering cases rewrite. */
interface SavedReceipt {
  request: { method: string; path: string; body?: unknown }
  response: { transport: { http_status: unknown; application_code: unknown }; response_sha256: unknown; data: unknown }
}

async function rewriteReceipt(path: string, change: (receipt: SavedReceipt) => unknown): Promise<void> {
  const receipt = JSON.parse(await readFile(path, 'utf8')) as SavedReceipt
  await writeFile(path, JSON.stringify(change(receipt)))
}

async function writeAt(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

describe('request methods and bodies preserved in operation receipts', () => {
  it.each([
    { method: 'PUT', body: undefined },
    { method: 'DELETE', body: { id: 7 } },
  ] as const)('replays a $method request from its receipt without sending it again', async ({ method, body }) => {
    const p = provider()
    const prepare = async (): Promise<JubianRequest> => ({ method, path: '/aigc/fixture/7', ...(body === undefined ? {} : { body }) })
    const first = await projectOperation(p.client, ledger(), input({ prepare }))
    expect(first).toMatchObject({ replayed: false, outcome: 'accepted', receipt_status: 'recorded' })
    expect(await projectOperation(p.client, ledger(), input({ prepare })))
      .toMatchObject({ replayed: true, outcome: 'accepted', data: { id: 1 } })
    expect(p.calls).toEqual([method])
    const saved = JSON.parse(await readFile(first.receipt_path, 'utf8')) as SavedReceipt
    expect(saved.request).toEqual({ method, path: '/aigc/fixture/7', ...(body === undefined ? {} : { body }) })
  })

  it('keeps the project identity in the ledger and aborts the provider request when the caller signal aborts', async () => {
    const controller = new AbortController()
    const client = new JubianClient({ credential: async () => 'unit-test-credential', fetch: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) throw new Error('Expected the request to carry a cancellation signal')
        signal.addEventListener('abort', () => { reject(new Error('request aborted by caller')) }, { once: true })
        controller.abort(new Error('user cancelled'))
      }) })
    await expect(projectOperation(client, ledger(), input({ method: 'project_share', scriptId: 7,
      prepare: async () => ({ method: 'POST', path: '/aigc/fixture', body: {}, signal: controller.signal }) })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR', detail: 'request aborted' })
    expect(await ledger().find(KEY)).toMatchObject({ method: 'project_share', script_id: 7, outcome: 'unknown' })
  })
})

describe('tampered operation receipts', () => {
  it.each<[string, (receipt: SavedReceipt) => unknown, string]>([
    ['a request that is not an object', receipt => ({ ...receipt, request: 'text' }), 'Invalid operation receipt request'],
    ['a request path without a leading slash', receipt => ({ ...receipt, request: { ...receipt.request, path: 'aigc/fixture' } }),
      'Invalid operation receipt request'],
    ['an unsupported request method', receipt => ({ ...receipt, request: { ...receipt.request, method: 'PATCH' } }),
      'Invalid operation receipt method'],
    ['a request body that is not an object', receipt => ({ ...receipt, request: { ...receipt.request, body: [1] } }),
      'Invalid operation receipt body'],
    ['a request that no longer matches its hash', receipt => ({ ...receipt, request: { ...receipt.request, path: '/aigc/other' } }),
      'Operation receipt request hash does not match its request'],
    ['a response that is not an object', receipt => ({ ...receipt, response: 'accepted' }), 'Invalid operation receipt response'],
    ['a response without transport evidence', receipt => ({ ...receipt, response: { data: 1 } }), 'Invalid operation receipt response'],
    ['an HTTP status that is not a number', receipt => ({ ...receipt, response: { ...receipt.response,
      transport: { ...receipt.response.transport, http_status: 'ok' } } }), 'Invalid operation receipt response evidence'],
    ['an application code that is not a number', receipt => ({ ...receipt, response: { ...receipt.response,
      transport: { ...receipt.response.transport, application_code: 'ok' } } }), 'Invalid operation receipt response evidence'],
    ['a response hash that is not a string', receipt => ({ ...receipt, response: { ...receipt.response, response_sha256: 5 } }),
      'Invalid operation receipt response evidence'],
    ['a response hash that differs from the ledger', receipt => ({ ...receipt, response: { ...receipt.response,
      response_sha256: 'sha256:another-response' } }), 'Operation receipt differs from the ledger response'],
  ])('refuses a receipt with %s before sending anything', async (_name, change, message) => {
    const p = provider()
    const first = await projectOperation(p.client, ledger(), input())
    await rewriteReceipt(first.receipt_path, change)
    await expect(projectOperation(p.client, ledger(), input()))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED', detail: message })
    expect(p.calls).toHaveLength(1)
  })

  it('refuses a receipt that is not JSON without sending a request', async () => {
    const p = provider()
    await writeAt(projectOperationReceiptPath(ledger(), KEY), 'not json')
    await expect(projectOperation(p.client, ledger(), input()))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED', detail: 'Operation receipt is not readable JSON; no request was sent' })
    expect(p.calls).toEqual([])
  })

  it('surfaces a receipt location that cannot be read instead of treating it as missing', async () => {
    const p = provider()
    await mkdir(projectOperationReceiptPath(ledger(), KEY), { recursive: true })
    await expect(projectOperation(p.client, ledger(), input())).rejects.toMatchObject({ code: 'EISDIR' })
    expect(p.calls).toEqual([])
  })

  it('refuses a receipt whose request hash differs from the ledger record', async () => {
    const p = provider(), recorded = ledger()
    await projectOperation(p.client, recorded, input())
    const record = await recorded.find(KEY)
    if (record === undefined) throw new Error('Fixture operation did not create a ledger record')
    vi.spyOn(recorded, 'find').mockResolvedValue({ ...record, request_sha256: 'sha256:another-request' })
    await expect(projectOperation(p.client, recorded, input()))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED', detail: 'Operation receipt differs from the ledger request' })
    expect(p.calls).toHaveLength(1)
  })
})

describe('manuscript project binding files', () => {
  const binding = { manuscriptId: 73, productionType: 0 } as const
  const bindingPath = () => join(ledger().root, 'manuscript-project-bindings', '73-0.json')

  it.each([
    ['an array', '[]'],
    ['an unsupported version', JSON.stringify({ version: 2, manuscript_id: 73, production_type: 0, original_key: 'earlier' })],
    ['another manuscript', JSON.stringify({ version: 1, manuscript_id: 74, production_type: 0, original_key: 'earlier' })],
    ['another workbench', JSON.stringify({ version: 1, manuscript_id: 73, production_type: 1, original_key: 'earlier' })],
    ['a non-string original key', JSON.stringify({ version: 1, manuscript_id: 73, production_type: 0, original_key: 5 })],
    ['a blank original key', JSON.stringify({ version: 1, manuscript_id: 73, production_type: 0, original_key: '  ' })],
  ])('sends no project request when the binding file holds %s', async (_name, text) => {
    const p = provider()
    await writeAt(bindingPath(), text)
    await expect(projectOperation(p.client, ledger(), input({ binding })))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED', detail: 'Manuscript project binding is unreadable; no project request was sent' })
    expect(p.calls).toEqual([])
  })
})

describe('ledger and receipt consistency before a new write', () => {
  it('refuses a key already recorded for a different ledger method', async () => {
    const p = provider(), recorded = ledger()
    await recorded.begin({ idempotencyKey: KEY, method: 'project_share', requestSha256: 'sha256:other' })
    await expect(projectOperation(p.client, recorded, input()))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED', detail: 'Idempotency key belongs to a different ledger operation' })
    expect(p.calls).toEqual([])
  })

  it('refuses a key already recorded for a different project', async () => {
    const p = provider(), recorded = ledger()
    await recorded.begin({ idempotencyKey: KEY, method: 'project_create', requestSha256: 'sha256:other', scriptId: 9 })
    await expect(projectOperation(p.client, recorded, input()))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED', detail: 'Idempotency key belongs to a different ledger operation' })
    expect(p.calls).toEqual([])
  })

  it('records the project identity of a project-scoped write in the ledger', async () => {
    const p = provider()
    expect(await projectOperation(p.client, ledger(), input({ method: 'project_share', scriptId: 7 })))
      .toMatchObject({ replayed: false, outcome: 'accepted' })
    expect(await ledger().find(KEY)).toMatchObject({ method: 'project_share', script_id: 7, outcome: 'accepted' })
  })

  it('answers unknown without a second write when another writer claims the key during preparation', async () => {
    const p = provider(), recorded = ledger()
    const request = { method: 'POST', path: '/aigc/fixture', body: { name: 'fixture' } }
    await recorded.begin({ idempotencyKey: KEY, method: 'project_create', requestSha256: bodyHash(request) })
    vi.spyOn(recorded, 'find').mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
    expect(await projectOperation(p.client, recorded, input()))
      .toMatchObject({ replayed: true, outcome: 'unknown', data: null, receipt_status: 'recorded' })
    expect(p.calls).toEqual([])
  })
})

describe('read-only lookup of operation and document-upload receipts', () => {
  it('reports unknown for a document-upload ledger record whose receipt is gone', async () => {
    const recorded = ledger()
    await recorded.begin({ idempotencyKey: KEY, method: 'document_upload', requestSha256: 'sha256:upload' })
    expect(await readProjectOperationReceipt(recorded, KEY))
      .toMatchObject({ found: true, status: 'unknown', receipt_status: 'missing', uploaded: false })
  })

  describe('with a document-upload receipt but no ledger record', () => {
    const source = '/tmp/script.txt'
    const document = { material_url: 'https://media.example/script.txt', sha256: 'sha256:file' }
    async function seedUploadReceipt(): Promise<void> {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      await writeAt(join(ledger().root, 'document-upload-receipts', `${sha(KEY)}.json`), JSON.stringify({
        version: 1, method: 'document_upload', key_sha256: sha(KEY), source, document, uploaded: true,
        request_sha256: `sha256:${sha(JSON.stringify({ source, document }))}` }))
    }

    it('returns the upload evidence as the original operation', async () => {
      await seedUploadReceipt()
      expect(await readProjectOperationReceipt(ledger(), KEY))
        .toMatchObject({ found: true, status: 'unknown', original_source: source, receipt_status: 'recorded' })
    })

    it('refuses to reuse that key for a project operation', async () => {
      const p = provider()
      await seedUploadReceipt()
      await expect(projectOperation(p.client, ledger(), input()))
        .rejects.toMatchObject({ code: 'CONTRACT_CHANGED', detail: 'Idempotency key belongs to a recorded document upload' })
      expect(p.calls).toEqual([])
    })
  })

  it('refuses a receipt whose identity fields are invalid', async () => {
    await writeAt(projectOperationReceiptPath(ledger(), KEY), JSON.stringify({ version: 2 }))
    await expect(readProjectOperationReceipt(ledger(), KEY))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED', detail: 'Operation receipt identity or intent hash is invalid' })
  })

  it('reports unknown when the ledger record is gone but the receipt is intact', async () => {
    const p = provider(), recorded = ledger()
    const first = await projectOperation(p.client, recorded, input())
    for (const file of await recorded.files()) await rm(file)
    expect(await readProjectOperationReceipt(ledger(), KEY)).toMatchObject({ found: true, status: 'unknown', data: null,
      operation: null, receipt_path: first.receipt_path,
      reason: 'Original ledger record is missing; the receipt cannot be matched to its recorded operation.' })
  })

  it('returns the original intent, project identity and null data of an accepted response', async () => {
    const p = provider(null)
    await projectOperation(p.client, ledger(), input({ method: 'project_share', scriptId: 7 }))
    expect(await readProjectOperationReceipt(ledger(), KEY)).toMatchObject({ found: true, status: 'accepted', data: null,
      operation: { method: 'project_share', script_id: 7, intent: { operation: 'fixture' } } })
  })

  it('refuses a receipt whose response hash differs from the ledger response', async () => {
    const p = provider()
    const first = await projectOperation(p.client, ledger(), input())
    await rewriteReceipt(first.receipt_path, receipt => ({ ...receipt, response: { ...receipt.response,
      response_sha256: 'sha256:another-response' } }))
    await expect(readProjectOperationReceipt(ledger(), KEY))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED', detail: 'Operation receipt differs from the ledger response' })
  })

  it('reports unknown with no response data or hash when the provider request failed', async () => {
    const client = new JubianClient({ credential: async () => 'unit-test-credential', fetch: async () => {
      throw new Error('connection closed after dispatch')
    } })
    await expect(projectOperation(client, ledger(), input())).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(await readProjectOperationReceipt(ledger(), KEY)).toMatchObject({ found: true, status: 'unknown', data: null,
      response_sha256: null, operation: { method: 'project_create', script_id: null } })
  })

  it('marks an accepted response as settlement pending when the ledger never settled', async () => {
    const p = provider(), recorded = ledger()
    vi.spyOn(recorded, 'settle').mockRejectedValueOnce(new Error('settlement interrupted'))
    await expect(projectOperation(p.client, recorded, input())).rejects.toThrow('settlement interrupted')
    expect(await readProjectOperationReceipt(ledger(), KEY))
      .toMatchObject({ found: true, status: 'accepted', settlement_pending: true, data: { id: 1 } })
  })
})
