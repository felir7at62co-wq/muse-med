import { appendFile, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { JsonStorageBackend } from '../src/index.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) }
})

const descriptor = { name: 'workspace', version: 2, hasGlobal: true, tables: ['workspaces'] }
const document = JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: null, tables: { workspaces: {} } })

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-json-source-fault-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  const path = await backend.sourcePath(descriptor)
  await writeFile(path, document)
  return { backend, path }
}

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`synthetic ${code}`), { code })
}

/** Run `duringRead` after the migration source's next whole-file read completes but before it is validated. */
async function interleave(duringRead: (path: string, backend: JsonStorageBackend) => Promise<void>) {
  const { backend, path } = await harness()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementationOnce(async (target, flags) => {
    const handle = await actual.open(target, flags)
    const read = handle.readFile.bind(handle)
    Object.defineProperty(handle, 'readFile', { value: async () => {
      const text = await read('utf8')
      await duringRead(path, backend)
      return text
    } })
    return handle
  })
  return backend
}

describe('JSON migration source filesystem faults', () => {
  it('rejects a document that is rewritten while it is being read', async () => {
    const backend = await interleave(path => appendFile(path, '\n'))
    await expect(backend.readSource(descriptor)).rejects.toThrow('changed while reading')
  })

  it('rejects a document read by a backend that closes before the read returns', async () => {
    const backend = await interleave((_path, owner) => owner.close())
    await expect(backend.readSource(descriptor)).rejects.toThrow('closed while reading')
  })

  it('reports a root that cannot be resolved for a reason other than absence instead of treating it as absent', async () => {
    const { backend } = await harness()
    vi.mocked(realpath).mockRejectedValueOnce(failure('ENOTDIR'))
    await expect(backend.sourcePath(descriptor)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('reports an unreadable unit file instead of treating it as missing', async () => {
    const { backend } = await harness()
    vi.mocked(open).mockRejectedValueOnce(failure('EACCES'))
    await expect(backend.readSource(descriptor)).rejects.toMatchObject({ code: 'EACCES' })
  })
})
