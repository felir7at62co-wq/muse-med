import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executeUpload, publicUrl, resolveUpload, type FileKind, type Platform, type RemoteObject, type TosUploadClient, type UploadLimits, type UploadLocation, type UploadRequest } from '../src/upload.ts'

const LOCATION: UploadLocation = {
  bucket: 'muse',
  rootFolder: 'download-video-date',
  publicBaseUrl: 'https://muse.tos-cn-beijing.volces.com',
  timeZone: 'Asia/Shanghai',
}
const LIMITS: UploadLimits = { maxFiles: 10, maxFileBytes: 1_000, maxTotalBytes: 2_000 }
// 2026-11-14T17:30:00Z is already 2026-11-15 in Asia/Shanghai.
const NOW = new Date('2026-11-14T17:30:00.123Z')
const DIRECTORY = 'download-video-date/hongguo/20261115/7470000000000000001/'
const UNKNOWN_PLATFORM: string = 'douyin'

let root: string

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'drama-tos-upload-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function file(name: string, content: string): Promise<string> {
  const path = join(root, name)
  await writeFile(path, content)
  return path
}

function request(overrides: Partial<UploadRequest> = {}): UploadRequest {
  return { platform: 'hongguo', workId: '7470000000000000001', files: [], ...overrides }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

/** In-memory bucket that records calls and refuses overwrites like the real binding. */
class FakeBucket implements TosUploadClient {
  readonly objects = new Map<string, RemoteObject & { body?: string }>()
  readonly calls: string[] = []
  corruptNextUpload = false

  head(key: string): Promise<RemoteObject | null> {
    this.calls.push(`head ${key}`)
    const object = this.objects.get(key)
    return Promise.resolve(object === undefined ? null : { bytes: object.bytes, sha256: object.sha256 })
  }

  async uploadFile(key: string, path: string, digest: string): Promise<void> {
    this.calls.push(`upload ${key}`)
    const body = await readFile(path, 'utf8')
    this.objects.set(key, { bytes: this.corruptNextUpload ? body.length + 1 : body.length, sha256: digest })
    this.corruptNextUpload = false
  }

  putJson(key: string, body: Uint8Array, digest: string): Promise<void> {
    this.calls.push(`put ${key}`)
    this.objects.set(key, { bytes: body.byteLength, sha256: digest, body: new TextDecoder().decode(body) })
    return Promise.resolve()
  }
}

describe('resolveUpload', () => {
  it('plans dated keys, hashes local bytes and uses today in the configured time zone', async () => {
    const video = await file('001.mp4', 'video-1')
    const script = await file('剧本.docx', 'docx')
    const plan = await resolveUpload(request({
      title: '  万物有声鉴宝天骄  ',
      files: [{ path: video, kind: 'video' }, { path: script, kind: 'scripts', name: '万物有声鉴宝天骄_完整剧本.docx' }],
      removeLocal: true,
    }), LOCATION, LIMITS, NOW, signal())

    expect(plan).toEqual({
      platform: 'hongguo',
      workId: '7470000000000000001',
      title: '万物有声鉴宝天骄',
      date: '20261115',
      directory: DIRECTORY,
      removeLocal: true,
      files: [
        { path: video, kind: 'video', key: `${DIRECTORY}video/001.mp4`, bytes: 7, sha256: sha256('video-1'), contentType: 'video/mp4' },
        { path: script, kind: 'scripts', key: `${DIRECTORY}scripts/万物有声鉴宝天骄_完整剧本.docx`, bytes: 4, sha256: sha256('docx'),
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      ],
    })
  })

  it('keeps an explicit date, drops a blank title and types unknown extensions as binary', async () => {
    const asr = await file('001.json', '{}')
    const extra = await file('notes.bin', 'x')
    const plan = await resolveUpload(request({ title: '   ', date: '20240229', files: [{ path: asr, kind: 'asr' }, { path: extra, kind: 'ocr' }] }),
      LOCATION, LIMITS, NOW, signal())
    expect(plan.title).toBeNull()
    expect(plan.date).toBe('20240229')
    expect(plan.removeLocal).toBe(false)
    expect(plan.files.map(entry => entry.contentType)).toEqual(['application/json', 'application/octet-stream'])
  })

  it.each([
    ['an unknown platform', { platform: UNKNOWN_PLATFORM as Platform }, 'TOS_UPLOAD_INVALID_REQUEST'],
    ['a non-numeric work id', { workId: '74x' }, 'TOS_UPLOAD_INVALID_REQUEST'],
    ['an over-long title', { title: '剧'.repeat(201) }, 'TOS_UPLOAD_INVALID_REQUEST'],
    ['a malformed date', { date: '2026-11-15' }, 'TOS_UPLOAD_INVALID_REQUEST'],
    ['an impossible date', { date: '20260230' }, 'TOS_UPLOAD_INVALID_REQUEST'],
    ['no files', { files: [] }, 'TOS_UPLOAD_INVALID_REQUEST'],
  ])('rejects %s', async (_label, overrides, code) => {
    await expect(resolveUpload(request(overrides), LOCATION, LIMITS, NOW, signal())).rejects.toMatchObject({ code })
  })

  it('rejects more files than the deployment allows', async () => {
    const path = await file('a.txt', 'a')
    const files = Array.from({ length: 11 }, (_, index) => ({ path, kind: 'asr' as const, name: `${index}.txt` }))
    await expect(resolveUpload(request({ files }), LOCATION, LIMITS, NOW, signal())).rejects.toMatchObject({ code: 'TOS_UPLOAD_LIMIT' })
  })

  it('rejects relative paths, unknown kinds and duplicate destinations', async () => {
    const path = await file('a.txt', 'a')
    await expect(resolveUpload(request({ files: [{ path: 'a.txt', kind: 'asr' }] }), LOCATION, LIMITS, NOW, signal()))
      .rejects.toMatchObject({ code: 'TOS_UPLOAD_INVALID_REQUEST' })
    const unknownKind: string = 'audio'
    await expect(resolveUpload(request({ files: [{ path, kind: unknownKind as FileKind }] }), LOCATION, LIMITS, NOW, signal()))
      .rejects.toThrow('kind 只能是')
    await expect(resolveUpload(request({ files: [{ path, kind: 'asr' }, { path, kind: 'asr' }] }), LOCATION, LIMITS, NOW, signal()))
      .rejects.toThrow('两个文件会写到同一位置')
  })

  it.each([
    ['empty', ''],
    ['dot-leading', '.hidden'],
    ['control character', 'a\u0001b'],
    ['delete character', 'a\u007fb'],
    ['slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['over-long', '名'.repeat(67)],
  ])('rejects an unsafe %s object name', async (_label, name) => {
    const path = await file('a.txt', 'a')
    await expect(resolveUpload(request({ files: [{ path, kind: 'asr', name }] }), LOCATION, LIMITS, NOW, signal()))
      .rejects.toThrow('文件名不能为空')
  })

  it('rejects directories, symbolic links and oversized input', async () => {
    const directory = join(root, 'folder')
    await mkdir(directory)
    const target = await file('target.txt', 'a')
    const link = join(root, 'link.txt')
    await symlink(target, link)
    const big = await file('big.mp4', 'x'.repeat(1_001))
    const half = await file('half.mp4', 'x'.repeat(900))
    for (const path of [directory, link]) {
      await expect(resolveUpload(request({ files: [{ path, kind: 'video' }] }), LOCATION, LIMITS, NOW, signal()))
        .rejects.toThrow('只能上传普通文件')
    }
    await expect(resolveUpload(request({ files: [{ path: big, kind: 'video' }] }), LOCATION, LIMITS, NOW, signal()))
      .rejects.toMatchObject({ code: 'TOS_UPLOAD_LIMIT' })
    const files = [0, 1, 2].map(index => ({ path: half, kind: 'video' as const, name: `${index}.mp4` }))
    await expect(resolveUpload(request({ files }), LOCATION, LIMITS, NOW, signal())).rejects.toThrow('一次上传总量不能超过')
  })

  it('places a 番茄 novel and its screenplay below the fanqie folder', async () => {
    const novel = await file('book.txt', '第一章')
    const plan = await resolveUpload({ platform: 'fanqie', workId: '7001', files: [{ path: novel, kind: 'novel' }] }, LOCATION, LIMITS, NOW, signal())
    expect(plan.directory).toBe('download-video-date/fanqie/20261115/7001/')
    expect(plan.files.map(entry => [entry.key, entry.contentType])).toEqual([['download-video-date/fanqie/20261115/7001/novel/book.txt', 'text/plain; charset=utf-8']])
  })

  it('stops before reading local files when the call is cancelled', async () => {
    const path = await file('a.txt', 'a')
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(resolveUpload(request({ files: [{ path, kind: 'asr' }] }), LOCATION, LIMITS, NOW, controller.signal)).rejects.toThrow('stopped')
  })
})

describe('executeUpload', () => {
  it('uploads, verifies, writes a manifest and keeps local files by default', async () => {
    const video = await file('001.mp4', 'video-1')
    const plan = await resolveUpload(request({ title: '剧名', files: [{ path: video, kind: 'video' }] }), LOCATION, LIMITS, NOW, signal())
    const bucket = new FakeBucket()

    const result = await executeUpload(plan, bucket, LOCATION, NOW, signal())

    const manifestKey = `${DIRECTORY}manifest-20261114T173000123Z.json`
    expect(result).toEqual({
      bucket: 'muse',
      date: '20261115',
      directory: DIRECTORY,
      directory_url: `https://muse.tos-cn-beijing.volces.com/${DIRECTORY}`,
      objects: [{ kind: 'video', path: video, key: `${DIRECTORY}video/001.mp4`,
        url: `https://muse.tos-cn-beijing.volces.com/${DIRECTORY}video/001.mp4`, bytes: 7, sha256: sha256('video-1'), status: 'uploaded' }],
      manifest: { key: manifestKey, url: `https://muse.tos-cn-beijing.volces.com/${manifestKey}` },
      removed_local: [],
      kept_local: [{ path: video, reason: 'remove_local 未开启' }],
    })
    expect(bucket.calls).toEqual([`head ${DIRECTORY}video/001.mp4`, `upload ${DIRECTORY}video/001.mp4`, `head ${DIRECTORY}video/001.mp4`, `put ${manifestKey}`])
    expect(JSON.parse(bucket.objects.get(manifestKey)?.body ?? '')).toEqual({
      version: 1, platform: 'hongguo', work_id: '7470000000000000001', title: '剧名', date: '20261115', created_at: NOW.toISOString(),
      objects: [{ kind: 'video', key: `${DIRECTORY}video/001.mp4`, bytes: 7, sha256: sha256('video-1') }],
    })
    await expect(readFile(video, 'utf8')).resolves.toBe('video-1')
  })

  it('recognises an identical earlier upload and deletes local copies only after every object is verified', async () => {
    const first = await file('001.mp4', 'video-1')
    const second = await file('002.mp4', 'video-2')
    const plan = await resolveUpload(request({ files: [{ path: first, kind: 'video' }, { path: second, kind: 'video' }], removeLocal: true }),
      LOCATION, LIMITS, NOW, signal())
    const bucket = new FakeBucket()
    bucket.objects.set(`${DIRECTORY}video/001.mp4`, { bytes: 7, sha256: sha256('video-1') })

    const result = await executeUpload(plan, bucket, LOCATION, NOW, signal())

    expect(result.objects.map(object => object.status)).toEqual(['already_present', 'uploaded'])
    expect(result.removed_local).toEqual([first, second])
    expect(result.kept_local).toEqual([])
    await expect(readFile(first)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a local file whose deletion fails and reports why', async () => {
    const video = await file('001.mp4', 'video-1')
    const plan = await resolveUpload(request({ files: [{ path: video, kind: 'video' }], removeLocal: true }), LOCATION, LIMITS, NOW, signal())
    await rm(video)
    const bucket = new FakeBucket()
    bucket.objects.set(`${DIRECTORY}video/001.mp4`, { bytes: 7, sha256: sha256('video-1') })

    const result = await executeUpload(plan, bucket, LOCATION, NOW, signal())

    expect(result.removed_local).toEqual([])
    expect(result.kept_local.map(entry => entry.path)).toEqual([video])
    expect(result.kept_local[0]?.reason).toContain('删除本地文件失败：Error: ENOENT')
  })

  it('refuses to replace a different remote object and reports an unverified upload', async () => {
    const video = await file('001.mp4', 'video-1')
    const plan = await resolveUpload(request({ files: [{ path: video, kind: 'video' }], removeLocal: true }), LOCATION, LIMITS, NOW, signal())
    const conflicting = new FakeBucket()
    conflicting.objects.set(`${DIRECTORY}video/001.mp4`, { bytes: 7, sha256: sha256('other') })
    await expect(executeUpload(plan, conflicting, LOCATION, NOW, signal())).rejects.toMatchObject({ code: 'TOS_UPLOAD_CONFLICT' })
    expect(conflicting.calls).toEqual([`head ${DIRECTORY}video/001.mp4`])

    const corrupt = new FakeBucket()
    corrupt.corruptNextUpload = true
    await expect(executeUpload(plan, corrupt, LOCATION, NOW, signal())).rejects.toMatchObject({ code: 'TOS_UPLOAD_UNVERIFIED' })
    await expect(readFile(video, 'utf8')).resolves.toBe('video-1')
  })

  it('stops before the next remote request when cancelled', async () => {
    const video = await file('001.mp4', 'video-1')
    const plan = await resolveUpload(request({ files: [{ path: video, kind: 'video' }] }), LOCATION, LIMITS, NOW, signal())
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    const bucket = new FakeBucket()
    await expect(executeUpload(plan, bucket, LOCATION, NOW, controller.signal)).rejects.toThrow('stopped')
    expect(bucket.calls).toEqual([])
  })
})

it('percent-encodes each key segment in public URLs', () => {
  expect(publicUrl('https://muse.tos-cn-beijing.volces.com', 'download-video-date/hongguo/20261115/1/scripts/剧 本#1.docx'))
    .toBe('https://muse.tos-cn-beijing.volces.com/download-video-date/hongguo/20261115/1/scripts/%E5%89%A7%20%E6%9C%AC%231.docx')
})
