import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fixtureHistoryClient } from './fixtures/history-write-client.ts'
import type { Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { uploadDocumentMethod } from '../src/document-upload.ts'

/** Source file whose handle reports faulty `stat` results, and the mutation applied to each `stat` call. */
const faults = vi.hoisted(() => ({ target: '', onStat: (_stats: Stats, _call: number): void => {} }))

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (args[0] !== faults.target) return handle
    let calls = 0
    return new Proxy(handle, { get(target, property) {
      if (property === 'stat') {
        return async () => {
          const stats = await target.stat()
          calls += 1
          faults.onStat(stats, calls)
          return stats
        }
      }
      const member: unknown = Reflect.get(target, property)
      return typeof member === 'function' ? (...args: unknown[]): unknown => Reflect.apply(member, target, args) : member
    } })
  } }
})

let root: string
let network: ReturnType<typeof vi.fn<typeof fetch>>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-document-read-faults-'))
  network = vi.fn<typeof fetch>(async () => { throw new Error('the provider must not be contacted') })
})
afterEach(async () => {
  faults.target = ''
  faults.onStat = () => {}
  await rm(root, { recursive: true, force: true })
})

async function source(): Promise<string> {
  const path = join(root, 'script.txt')
  await writeFile(path, '第1集\n张三：回家。\n')
  faults.target = path
  return path
}

const upload = (document_path: string, signal?: AbortSignal) => uploadDocumentMethod(fixtureHistoryClient(), new JubianLedger({ root }),
  { document_path, idempotency_key: 'read-fault' }, { maxBytes: 1024, signal }, { fetch: network })

describe('upload_document source reads that change underneath the upload', () => {
  it('rejects a source that is longer than its first reported size before any provider request', async () => {
    const path = await source()
    faults.onStat = (stats, call) => { if (call === 1) stats.size = 4 }
    await expect(upload(path)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT',
      detail: 'Document changed while being read; no upload was attempted' })
    expect(network).not.toHaveBeenCalled()
  })

  it('rejects a source whose modification time changes while it is read', async () => {
    const path = await source()
    faults.onStat = (stats, call) => { if (call === 2) stats.mtimeMs += 1 }
    await expect(upload(path)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT',
      detail: 'Document changed while being read; no upload was attempted' })
    expect(network).not.toHaveBeenCalled()
  })

  it('rejects a source whose status-change time moves while it is read', async () => {
    const path = await source()
    faults.onStat = (stats, call) => { if (call === 2) stats.ctimeMs += 1 }
    await expect(upload(path)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT',
      detail: 'Document changed while being read; no upload was attempted' })
    expect(network).not.toHaveBeenCalled()
  })

  it('rejects a source whose size changes between the two stat calls', async () => {
    const path = await source()
    faults.onStat = (stats, call) => { if (call === 2) stats.size += 1 }
    await expect(upload(path)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT',
      detail: 'Document changed while being read; no upload was attempted' })
    expect(network).not.toHaveBeenCalled()
  })

  it('reports the caller cancellation reason when the signal aborts while the source is being read', async () => {
    const path = await source(), controller = new AbortController()
    faults.onStat = (_stats, call) => { if (call === 1) controller.abort(new Error('user cancelled')) }
    await expect(upload(path, controller.signal)).rejects.toThrow('user cancelled')
    expect(network).not.toHaveBeenCalled()
  })
})
