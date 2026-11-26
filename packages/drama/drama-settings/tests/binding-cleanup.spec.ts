import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ cleanup: false, link: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    link: async (...args: Parameters<typeof fs.link>) => {
      if (faults.link) throw new Error('hard links unsupported')
      return fs.link(...args)
    },
    unlink: async (path: Parameters<typeof fs.unlink>[0]) => {
      if (faults.cleanup && String(path).includes('.project-binding-')) throw new Error('cleanup failed')
      return fs.unlink(path)
    },
  }
})

import { createProjectBinding } from '../src/project-bible.ts'

const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
async function root(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'dsh-binding-cleanup-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  faults.cleanup = false
  faults.link = false
  for (const path of roots.splice(0)) await fs.rm(path, { recursive: true, force: true })
})

it('reports that the config was committed if temporary cleanup fails', async () => {
  const path = await root()
  faults.cleanup = true
  await expect(createProjectBinding(path, 6682)).rejects.toThrow('binding was created but cleanup failed')
  expect(JSON.parse(await fs.readFile(join(path, 'project_config.json'), 'utf8'))).toEqual({ jubian_script_id: 6682 })
  await expect(fs.access(join(path, '.project-bible.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('leaves no config or lock when hard links are unavailable', async () => {
  const path = await root()
  faults.link = true
  await expect(createProjectBinding(path, 6682)).rejects.toThrow('hard links unsupported')
  expect(await fs.readdir(path)).toEqual([])
})
