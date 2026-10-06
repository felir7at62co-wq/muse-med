/** Project discovery stops at the filesystem root without reading unrelated parent paths. */
import { readFile } from 'node:fs/promises'
import { join, parse } from 'node:path'
import { expect, it, vi } from 'vitest'
import { readProjectDelivery } from '../src/delivery.ts'

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('no project config'), { code: 'ENOENT' })),
}))

it('ends config discovery at the filesystem root when no project declares requirements', async () => {
  const filesystemRoot = parse(process.cwd()).root
  expect(await readProjectDelivery(join(filesystemRoot, 'unconfigured-shot.txt'))).toBeUndefined()
  expect(readFile).toHaveBeenCalledExactlyOnceWith(join(filesystemRoot, 'project_config.json'), 'utf8')
})
