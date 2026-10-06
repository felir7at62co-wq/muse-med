/** File-capture cleanup retains the original I/O failure after the child exits. */
import { access, rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createFileCaptureChannel } from '../src/ffmpeg.ts'

const injected = vi.hoisted(() => ({
  failure: Object.assign(new Error('capture descriptor close failed'), { code: 'EIO' }),
  directories: [] as string[],
  descriptors: [] as { closeCalls: number; fd: () => number }[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const directory = await actual.mkdtemp(...args)
      if (typeof directory !== 'string') throw new Error('expected UTF-8 capture directory')
      injected.directories.push(directory)
      return directory
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const close = handle.close.bind(handle)
      const observed = { closeCalls: 0, fd: () => handle.fd }
      injected.descriptors.push(observed)
      handle.close = async () => {
        observed.closeCalls++
        await close()
        throw injected.failure
      }
      return handle
    },
  }
})

afterEach(async () => {
  for (const directory of injected.directories.splice(0)) await rm(directory, { recursive: true, force: true })
  injected.descriptors.splice(0)
})

it('closes both owned descriptors and removes only its capture directory after a close error', async () => {
  await expect(createFileCaptureChannel().run(process.execPath, ['-e', "process.stdout.write('done')"]))
    .rejects.toBe(injected.failure)
  expect(injected.descriptors).toHaveLength(2)
  expect(injected.descriptors.map(handle => handle.fd())).toEqual([-1, -1])
  expect(injected.descriptors.map(handle => handle.closeCalls)).toEqual([2, 1])
  expect(injected.directories).toHaveLength(1)
  for (const directory of injected.directories) await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})
