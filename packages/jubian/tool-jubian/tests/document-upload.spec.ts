import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { uploadDocumentMethod, readDocumentUploadReceipt } from '../src/document-upload.ts'

const HTML = '<html><script src="/static/js/app.fixture.js"></script></html>'
const APP = 'var modules={{"6c3d":function(e,t,n){var o=(t.default,"AKIDEXAMPLE");'
  + 'var s="SECRETEXAMPLE";var r="cn-beijing";var u="jubian-aigc";'
  + 'var l="tos-cn-beijing.volces.com";return 1}},"6ea0":function(){return 1}}'
const LIMIT = { maxBytes: 1024 }
const CLOCK = () => new Date(2026, 9, 26, 12, 0, 0)

function transport(status = 200): { fetch: typeof fetch; calls: { url: string; init?: RequestInit | undefined }[] } {
  const calls: { url: string; init?: RequestInit | undefined }[] = []
  const stub: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    if (url === 'https://web.jubianai.net/') return new Response(HTML)
    if (url.endsWith('/static/js/app.fixture.js')) return new Response(APP)
    return new Response(null, { status })
  }
  return { fetch: stub, calls }
}

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-document-upload-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

async function file(name: string, bytes: Uint8Array): Promise<string> {
  const path = join(root, name)
  await writeFile(path, bytes)
  return path
}

function upload(args: { document_path?: string; idempotency_key?: string }, options = LIMIT,
  deps: Parameters<typeof uploadDocumentMethod>[3] = {}) {
  return uploadDocumentMethod(new JubianLedger({ root }), { idempotency_key: 'upload-test', ...args }, options, deps)
}

describe('upload_document', () => {
  it.each([
    { name: '剧本.txt', bytes: Buffer.from('第1集\n张三：回家。\n'), type: 'text/plain; charset=utf-8', format: 'txt' },
    { name: '剧本.doc', bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), type: 'application/msword', format: 'doc' },
    { name: '剧本.DOCX', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', format: 'docx' },
  ])('uploads unchanged $format container bytes and returns a document receipt', async ({ name, bytes, type, format }) => {
    const stub = transport()
    const result = await upload({ document_path: await file(name, bytes) }, LIMIT,
      { fetch: stub.fetch, now: CLOCK })
    expect(stub.calls).toHaveLength(3)
    expect(await new JubianLedger({ root }).find('upload-test'))
      .toMatchObject({ method: 'document_upload', outcome: 'accepted', http_status: 200, application_code: null })
    const uploaded = stub.calls[2]!
    expect(uploaded.url).toMatch(new RegExp(`/prod/sys-material-video/2026/10/26/[0-9a-f]{32}\\.${format}$`))
    expect(uploaded.init?.method).toBe('PUT')
    expect(uploaded.init?.body).toEqual(new Uint8Array(bytes))
    expect(uploaded.init?.headers).toMatchObject({ 'content-type': type })
    expect(result).toMatchObject({ uploaded: true, material_url: uploaded.url, file_name: name,
      bytes: bytes.byteLength, content_type: type, format, format_validation: 'container_signature', paidRequests: 0,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })
    expect(uploaded.url.endsWith(String(result.object_key))).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/AKIDEXAMPLE|SECRETEXAMPLE|Authorization/)
  })

  it.each([
    { name: 'fake.doc', bytes: Buffer.from('ordinary text') },
    { name: 'fake.docx', bytes: Buffer.from('ordinary text') },
    { name: 'broken.txt', bytes: new Uint8Array([0xff, 0xfe, 0xfa]) },
    { name: 'binary.txt', bytes: new Uint8Array([0x41, 0, 0x42]) },
    { name: 'blank.txt', bytes: Buffer.from('\n \t\n') },
    { name: 'empty.docx', bytes: new Uint8Array() },
    { name: 'image.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    { name: 'large.txt', bytes: Buffer.alloc(1025, 65) },
  ])('rejects $name before loading any upload configuration', async ({ name, bytes }) => {
    const stub = transport()
    await expect(upload({ document_path: await file(name, bytes) }, LIMIT, { fetch: stub.fetch }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(stub.calls).toHaveLength(0)
  })

  it.each([{}, { document_path: '' }, { document_path: ' ' }])('requires a local document path: %j', async (args) => {
    const stub = transport()
    await expect(upload(args, LIMIT, { fetch: stub.fetch })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(stub.calls).toHaveLength(0)
  })

  it('refuses missing files, directories and invalid deployment limits before network calls', async () => {
    const stub = transport()
    const directory = join(root, 'directory.docx')
    await mkdir(directory)
    for (const path of [join(root, 'missing.docx'), directory]) {
      await expect(upload({ document_path: path }, LIMIT, { fetch: stub.fetch }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
      await expect(upload({ document_path: join(root, 'script.txt') }, { maxBytes }, { fetch: stub.fetch }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    expect(stub.calls).toHaveLength(0)
  })

  it('does not retry or register a project after an object-storage refusal', async () => {
    const stub = transport(403)
    await expect(upload({ document_path: await file('script.txt', Buffer.from('第1集')) }, LIMIT,
      { fetch: stub.fetch, now: CLOCK })).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(stub.calls.map(call => call.init?.method ?? 'GET')).toEqual(['GET', 'GET', 'PUT'])
    expect(stub.calls.some(call => call.url.includes('/aigc/script'))).toBe(false)
  })

  it('supports the ordinary transport without changing document content', async () => {
    const stub = transport()
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(stub.fetch)
    try {
      expect(await upload({ document_path: await file('script.txt', Buffer.from('第1集')) }, LIMIT))
        .toMatchObject({ format: 'txt', uploaded: true })
    } finally {
      spy.mockRestore()
    }
    expect(stub.calls).toHaveLength(3)
  })

  it('replays the original upload after source replacement without reopening it or sending network requests', async () => {
    const stub = transport(), path = await file('original.txt', Buffer.from('原始剧本'))
    const first = await upload({ document_path: path }, LIMIT, { fetch: stub.fetch })
    await writeFile(path, '替换后的剧本')
    const replay = await upload({ document_path: path }, LIMIT, { fetch: stub.fetch })
    expect(replay).toMatchObject({ uploaded: true, outcome: 'accepted', replayed: true, sha256: first.sha256,
      source_reread: false, material_url: first.material_url })
    expect(stub.calls).toHaveLength(3)
    expect(await readDocumentUploadReceipt(new JubianLedger({ root }), 'upload-test'))
      .toMatchObject({ uploaded: true, sha256: first.sha256 })
  })

  it('rejects the same key for another source path without reading or uploading it', async () => {
    const stub = transport()
    await upload({ document_path: await file('first.txt', Buffer.from('原始剧本')) }, LIMIT, { fetch: stub.fetch })
    await expect(upload({ document_path: join(root, 'different.txt') }, LIMIT, { fetch: stub.fetch }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(stub.calls).toHaveLength(3)
  })

  it('retains an unknown upload after a lost response and never sends a second PUT', async () => {
    const stub = transport(), path = await file('unknown.txt', Buffer.from('原始剧本'))
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method === 'PUT') {
        await stub.fetch(url, init)
        throw new Error('response lost after upload')
      }
      return await stub.fetch(url, init)
    }
    await expect(upload({ document_path: path }, LIMIT, { fetch: fetcher })).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(await upload({ document_path: path }, LIMIT, { fetch: fetcher }))
      .toMatchObject({ uploaded: false, outcome: 'unknown', replayed: true })
    expect(stub.calls).toHaveLength(3)
  })

  it('serializes concurrent use of one key into a single object upload', async () => {
    const stub = transport(), path = await file('concurrent.txt', Buffer.from('原始剧本'))
    const results = await Promise.all([1, 2, 3].map(() => upload({ document_path: path }, LIMIT, { fetch: stub.fetch })))
    expect(results.every(result => result.uploaded)).toBe(true)
    expect(stub.calls).toHaveLength(3)
  })

  it('requires an upload key before loading the source or sending network requests', async () => {
    const stub = transport()
    await expect(uploadDocumentMethod(new JubianLedger({ root }), { document_path: '/missing.txt' }, LIMIT, { fetch: stub.fetch }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(stub.calls).toHaveLength(0)
  })


  it('does not repeat upload when its response receipt was deleted', async () => {
    const stub = transport(), path = await file('receipt.txt', Buffer.from('剧本'))
    const first = await upload({ document_path: path }, LIMIT, { fetch: stub.fetch })
    await rm(String(first.receipt_path))
    await rm(path)
    expect(await upload({ document_path: path }, LIMIT, { fetch: stub.fetch }))
      .toMatchObject({ uploaded: false, outcome: 'unknown', receipt_status: 'missing' })
    expect(stub.calls).toHaveLength(3)
  })

  it('rejects changed receipt metadata without another request', async () => {
    const stub = transport(), path = await file('changed.txt', Buffer.from('剧本'))
    const first = await upload({ document_path: path }, LIMIT, { fetch: stub.fetch })
    const receipt = JSON.parse(await readFile(String(first.receipt_path), 'utf8')) as { document: { material_url: string } }
    receipt.document.material_url = 'https://different.example/changed.docx'
    await writeFile(String(first.receipt_path), JSON.stringify(receipt))
    await expect(upload({ document_path: path }, LIMIT, { fetch: stub.fetch }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(stub.calls).toHaveLength(3)
  })

  it('preserves successful object evidence when writing the ledger settlement fails', async () => {
    const stub = transport(), path = await file('settlement.txt', Buffer.from('剧本'))
    const ledger = new JubianLedger({ root })
    vi.spyOn(ledger, 'settle').mockRejectedValueOnce(new Error('settlement interrupted'))
    await expect(uploadDocumentMethod(ledger, { document_path: path, idempotency_key: 'settlement' }, LIMIT,
      { fetch: stub.fetch })).rejects.toThrow('settlement interrupted')
    expect(await uploadDocumentMethod(new JubianLedger({ root }), { document_path: path, idempotency_key: 'settlement' }, LIMIT,
      { fetch: stub.fetch })).toMatchObject({ uploaded: true, replayed: true, outcome: 'accepted', settlement_pending: true })
    expect(stub.calls).toHaveLength(3)
  })

  it('refuses a key already used by a different ledger method before reading the source', async () => {
    const stub = transport(), ledger = new JubianLedger({ root })
    await ledger.begin({ method: 'project_create', idempotencyKey: 'upload-test', requestSha256: 'sha256:other' })
    await expect(upload({ document_path: join(root, 'missing.txt') }, LIMIT, { fetch: stub.fetch }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(stub.calls).toHaveLength(0)
  })


  it('requires an absolute source path to avoid resolving against the Host launch directory', async () => {
    const stub = transport()
    await expect(upload({ document_path: 'relative.txt' }, LIMIT, { fetch: stub.fetch }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(stub.calls).toHaveLength(0)
  })

  it('stops before configuration lookup when the caller already cancelled', async () => {
    const stub = transport(), controller = new AbortController()
    controller.abort(new Error('user cancelled'))
    await expect(uploadDocumentMethod(new JubianLedger({ root }), { document_path: join(root, 'missing.txt'), idempotency_key: 'cancelled' },
      { ...LIMIT, signal: controller.signal }, { fetch: stub.fetch })).rejects.toThrow('user cancelled')
    expect(stub.calls).toHaveLength(0)
  })

  it('forwards cancellation to configuration fetch and never begins a PUT after cancellation', async () => {
    const stub = transport(), controller = new AbortController(), path = await file('cancel-before-put.txt', Buffer.from('剧本'))
    const fetcher: typeof fetch = async (url, init) => {
      expect(init?.signal).toBe(controller.signal)
      const response = await stub.fetch(url, init)
      controller.abort(new Error('user cancelled'))
      return response
    }
    await expect(uploadDocumentMethod(new JubianLedger({ root }), { document_path: path, idempotency_key: 'cancel-config' },
      { ...LIMIT, signal: controller.signal }, { fetch: fetcher })).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls.some(call => call.init?.method === 'PUT')).toBe(false)
  })

  it.each(['caller', 'timeout'] as const)('keeps a %s-aborted PUT unknown and never retries it', async (kind) => {
    const stub = transport(), controller = new AbortController(), path = await file('cancel-put.txt', Buffer.from('剧本'))
    const started = Promise.withResolvers<undefined>()
    const timeoutController = new AbortController()
    const timeoutSpy = kind === 'timeout' ? vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal) : undefined
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method !== 'PUT') return await stub.fetch(url, init)
      await stub.fetch(url, init)
      started.resolve(undefined)
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init.signal
        if (!signal) throw new Error('Expected cancellation on the object upload')
        const abort = () => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error ? reason : new Error('Object upload aborted'))
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    }
    const ledger = new JubianLedger({ root }), args = { document_path: path, idempotency_key: 'abort-put' }
    const pending = uploadDocumentMethod(ledger, args,
      { ...LIMIT, signal: controller.signal, ...(kind === 'timeout' ? { timeoutMs: 100 } : {}) }, { fetch: fetcher })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    await started.promise
    if (kind === 'caller') controller.abort(new Error('user cancelled'))
    else timeoutController.abort(new DOMException('Upload timed out', 'TimeoutError'))
    await rejected
    if (kind === 'timeout') expect(timeoutSpy).toHaveBeenCalledWith(100)
    expect(await uploadDocumentMethod(new JubianLedger({ root }), args, LIMIT, { fetch: fetcher }))
      .toMatchObject({ uploaded: false, outcome: 'unknown', replayed: true })
    expect(stub.calls).toHaveLength(3)
  })

})
