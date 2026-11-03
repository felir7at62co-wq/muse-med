/** Re-resolve the original provider media before publishing an approved local copy. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import { materializeApprovedProviderVideo } from '../src/video-recovery.ts'

const taskId = 42
const mediaUrl = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture.mp4'
const mediaBytes = Buffer.from('000000106674797069736f6d00000000', 'hex')
const approvedHash = createHash('sha256').update(mediaBytes).digest('hex')

it('publishes only the unique output matching the approval and rehashes the cache before reuse', async () => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'muse-approved-provider-')))
  onTestFinished(async () => {
    vi.unstubAllGlobals()
    await rm(project, { recursive: true, force: true, maxRetries: 3 })
  })
  const reviewDir = join(project, 'video_tasks', 'review')
  await mkdir(reviewDir, { recursive: true })
  const taskPath = '/admin/aigc/video/task/42'
  const childrenPath = '/admin/aigc/video/task/sub/list'
  const rows = [51, 52].map(id => ({
    id, aigcVideoTaskId: taskId, taskStatus: 'succeeded',
    resultList: [{ firstResultId: id + 100, taskType: 1, resultStatus: 'succeeded',
      tosVideoUrl: mediaUrl }],
  }))
  let children = rows
  const calls: string[] = []
  const client = new JubianClient({ credential: async () => 'fixture', fetch: async (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const path = url.pathname.replace(/^\/prod-api/, '')
    calls.push(String(options?.method) + ' ' + path)
    if (path !== taskPath && path !== childrenPath) throw new Error('Unexpected provider request')
    const data = path === taskPath
      ? { id: taskId, taskType: 1, taskStatus: 'succeeded' }
      : { total: children.length, rows: children }
    return Response.json({ code: 200, data })
  } })
  let downloaded = new Uint8Array(Buffer.concat([mediaBytes, Buffer.from('changed')]))
  const fetchMedia = vi.fn(async (input: string) => {
    expect(input).toBe(mediaUrl)
    return new Response(downloaded)
  })
  vi.stubGlobal('fetch', fetchMedia)
  const materialize = () => materializeApprovedProviderVideo(project, taskId, approvedHash, () => client,
    new AbortController().signal)

  await expect(materialize()).rejects.toThrow('one verified provider output')
  expect(fetchMedia).not.toHaveBeenCalled()
  expect(await readdir(reviewDir)).toEqual([])
  children = rows.slice(0, 1)
  await expect(materialize()).rejects.toThrow('Provider video bytes differ')
  expect(await readdir(reviewDir)).toEqual([])

  downloaded = new Uint8Array(mediaBytes)
  const saved = await materialize()
  expect(saved).toBe(join(reviewDir, 'original-' + approvedHash + '.mp4'))
  expect(await readFile(saved)).toEqual(mediaBytes)
  expect(calls).toEqual(Array.from({ length: 3 }, () => ['GET ' + taskPath, 'POST ' + childrenPath]).flat())
  expect(fetchMedia).toHaveBeenCalledTimes(2)
  await expect(materialize()).resolves.toBe(saved)
  expect(calls).toHaveLength(6)
  expect(fetchMedia).toHaveBeenCalledTimes(2)
  await writeFile(saved, 'corrupted')
  await expect(materialize()).rejects.toThrow('Managed video bytes differ')
  expect(calls).toHaveLength(6)
  expect(fetchMedia).toHaveBeenCalledTimes(2)
})
