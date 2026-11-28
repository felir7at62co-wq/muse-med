/** Delivery sidecars distinguish missing, corrupt and unreadable records without replacing them. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readCacheIdentity } from '../src/cache.ts'
import { readSourceRecord, SOURCE_RECORD_VERSION } from '../src/source-record.ts'
import { cleanup, tempProject } from './harness.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => cleanup(root))) })

it.each(['{truncated', '{"version":2,"output":{"sha256":"old"}}', '{"version":1,"output":{}}'])(
  'refuses a damaged delivery sidecar and retains its bytes: %s', async (bytes) => {
    const project = await tempProject()
    roots.push(project)
    const sidecar = join(project, 'delivery.source-record.json')
    await writeFile(sidecar, bytes)
    await expect(readSourceRecord(sidecar)).rejects.toThrow(/JSON|version/u)
    expect(await readFile(sidecar, 'utf8')).toBe(bytes)
  },
)

it('propagates unreadable sidecars instead of treating them as absent delivery or cache records', async () => {
  const project = await tempProject()
  roots.push(project)
  const directory = join(project, 'sidecar.json')
  await mkdir(directory)
  await expect(readSourceRecord(directory)).rejects.toMatchObject({ code: 'EISDIR' })
  await expect(readCacheIdentity(directory)).rejects.toMatchObject({ code: 'EISDIR' })
  await expect(readSourceRecord(join(project, 'missing'))).resolves.toBeUndefined()
})

it('refuses a present but contradictory picture clock in an otherwise current source record', async () => {
  const project = await tempProject()
  roots.push(project)
  const sidecar = join(project, 'delivery.source-record.json')
  const bytes = JSON.stringify({ version: SOURCE_RECORD_VERSION, output: { sha256: 'a'.repeat(64) },
    delivery_inputs: { picture_clock: { status: 'verified_cfr', total_frames: 24, body_end_frame: 25 } } })
  await writeFile(sidecar, bytes)
  await expect(readSourceRecord(sidecar)).rejects.toThrow('成片画面时钟回执无效')
  expect(await readFile(sidecar, 'utf8')).toBe(bytes)
})
