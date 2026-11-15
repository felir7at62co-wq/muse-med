/** Resumable local copies preserve changed files and stop on storage failure or cancellation. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { downloadedMediaPath, resumeMediaDownload } from '../src/media-download.ts'

const faults = vi.hoisted(() => ({ read: '', stat: '', write: '', cancelOnDirectory: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const denied = () => Object.assign(new Error('storage access denied'), { code: 'EACCES' })
  return { ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === faults.read) throw denied()
      return await fs.readFile(...args)
    },
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === faults.stat) throw denied()
      return await fs.lstat(...args)
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (args[0] === faults.write) throw denied()
      await fs.writeFile(...args)
    },
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      const value = await fs.mkdir(...args)
      faults.cancelOnDirectory?.()
      return value
    },
  }
})

let root: string
const source = 'https://jubian-aigc.tos-cn-beijing.volces.com/offline/clip.mp4'
const bytes = Buffer.from('000000106674797069736f6d00000000', 'hex')
const digest = createHash('sha256').update(source).digest('hex')
const receipt = () => join(root, `clip.mp4.jubian-video-${digest.slice(0, 16)}.json`)
const target = () => join(root, 'clip.mp4')
const download = (signal?: AbortSignal) => resumeMediaDownload(source, 'video', target(), signal)
const response = vi.fn(() => Promise.resolve(new Response(bytes)))
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'muse-media-download-'))
  faults.read = ''; faults.stat = ''; faults.write = ''; faults.cancelOnDirectory = undefined
  response.mockClear()
  vi.stubGlobal('fetch', response)
})
afterEach(async () => {
  faults.read = ''; faults.stat = ''; faults.write = ''; faults.cancelOnDirectory = undefined
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

it.each(['{', '{"version":1}'])('replaces an unreadable receipt without overwriting an existing media file (%s)', async (text) => {
  await writeFile(receipt(), text)
  await writeFile(target(), 'previous file')
  const result = await download()
  expect(result).toMatchObject({ reused: false, path: join(root, `clip-resume-${digest.slice(0, 12)}-1.mp4`) })
  expect(await readFile(target(), 'utf8')).toBe('previous file')
  expect(response).toHaveBeenCalledTimes(1)
})

it('does not hide a receipt storage error as permission to fetch a replacement', async () => {
  faults.read = receipt()
  await expect(download()).rejects.toMatchObject({ code: 'EACCES' })
  expect(response).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

it('does not hide a saved-media storage error as an invalid or missing copy', async () => {
  await download()
  faults.stat = target()
  await expect(download()).rejects.toMatchObject({ code: 'EACCES' })
  expect(response).toHaveBeenCalledTimes(1)
})

it('reuses a verified copy with caller cancellation attached without fetching again', async () => {
  const first = await download()
  expect(await download(new AbortController().signal)).toMatchObject({ reused: true, sha256: first.sha256 })
  expect(response).toHaveBeenCalledTimes(1)
})

it('propagates a target write error without publishing a download receipt', async () => {
  faults.write = target()
  await expect(download()).rejects.toMatchObject({ code: 'EACCES' })
  expect(await readdir(root)).toEqual([])
})

it.each(['missing', 'directory', 'shorter'])('redownloads after a saved copy becomes %s and keeps conflicting paths', async (change) => {
  await download()
  await rm(target())
  if (change === 'directory') await mkdir(target())
  if (change === 'shorter') await writeFile(target(), 'short')
  const replaced = await download(new AbortController().signal)
  expect(replaced.reused).toBe(false)
  expect(response).toHaveBeenCalledTimes(2)
  expect(await download()).toMatchObject({ reused: true, path: replaced.path })
  expect(response).toHaveBeenCalledTimes(2)
})

it('ignores a receipt pointing outside the deterministic candidate names', async () => {
  await download()
  const saved = JSON.parse(await readFile(receipt(), 'utf8')) as Record<string, unknown>
  const unrelated = join(root, 'someone-elses-copy.mp4')
  await writeFile(unrelated, bytes)
  await writeFile(receipt(), JSON.stringify({ ...saved, path: unrelated }))
  const replaced = await download()
  expect(replaced).toMatchObject({ reused: false, path: join(root, `clip-resume-${digest.slice(0, 12)}-1.mp4`) })
  expect(await readFile(unrelated)).toEqual(bytes)
})

it('stops when every bounded candidate path exists instead of overwriting or looping', async () => {
  await Promise.all(Array.from({ length: 100 }, (_, attempt) => writeFile(attempt === 0 ? target()
    : join(root, `clip-resume-${digest.slice(0, 12)}-${attempt}.mp4`), 'occupied')))
  await expect(download()).rejects.toThrow('找不到可用的下载候选路径')
  expect(await readdir(root)).toHaveLength(100)
  expect(await readFile(target(), 'utf8')).toBe('occupied')
})

it('checks cancellation after creating the directory and does not fetch or leave a lock', async () => {
  const controller = new AbortController()
  faults.cancelOnDirectory = () => { controller.abort(new Error('user stopped download')) }
  await expect(download(controller.signal)).rejects.toThrow('user stopped download')
  expect(response).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

it('retains JPG spelling when the decoded format is JPEG', () => {
  expect(downloadedMediaPath(join(root, 'cover.JPG'), 'image/jpeg')).toBe(join(root, 'cover.JPG'))
})
