/** Verify an independently encoded export against the approved source. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as streams from 'node:fs'
import { writeFileSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, unlink } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MEDIA_LIMITS } from '@deepseek-ai/dsh-jubian-api'
import { verifyApprovedClipExport } from '../src/approved-clip-export.ts'

const ffmpeg = process.env.MUSE_RECOVERY_TEST_FFMPEG ?? process.env.DSH_FFMPEG_PATH
const execute = promisify(execFile)

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

async function fixture(audio = 'sine=frequency=421:sample_rate=32000') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-approved-export-')))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }) })
  const project = join(root, 'project')
  await mkdir(project)
  const source = join(project, 'approved.mp4')
  const target = 'exports/rendered.mp4'
  const rendered = join(project, target)
  await mkdir(join(project, 'exports'))
  const encode = async (args: string[]) => {
    await execute(ffmpeg!, ['-nostdin', '-v', 'error', '-y', ...args], {
      env: { SystemRoot: process.env.SystemRoot }, timeout: 10_000, windowsHide: true,
    })
  }
  await encode([
    '-f', 'lavfi', '-i', 'testsrc2=size=96x54:rate=24', '-f', 'lavfi', '-i', audio,
    '-t', '2', '-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'aac', source,
  ])
  const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
  const approvedSha256 = await hash(source)
  const verify = () => verifyApprovedClipExport(project, source, approvedSha256, target,
    ffmpeg!, 10_000, new AbortController().signal)
  await copyFile(source, rendered)
  return { root, project, source, target, rendered, encode, hash, approvedSha256, verify }
}

it.skipIf(!ffmpeg)('accepts the same picture and sound after encoding and rejects unrelated tracks', async () => {
  const { source, target, rendered, encode, hash, approvedSha256, verify } = await fixture()

  await encode(['-i', source, '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac', '-ar', '44100', rendered])
  const renderedSha256 = await hash(rendered)
  expect(renderedSha256).not.toBe(approvedSha256)
  const result = await verify()
  expect(result).toMatchObject({ path: target, sha256: renderedSha256 })
  expect(result.videoSimilarity).toBeGreaterThan(0.94)
  expect(result.audioSimilarity).toBeGreaterThan(0.95)

  await encode(['-i', source, '-vf', 'negate', '-c:v', 'mpeg4', '-c:a', 'copy', rendered])
  await expect(verify()).rejects.toThrow('Exported picture or audio does not match the approved video')

  await encode([
    '-i', source, '-f', 'lavfi', '-i', 'sine=frequency=713:sample_rate=32000', '-map', '0:v:0', '-map', '1:a:0',
    '-t', '2', '-c:v', 'copy', '-c:a', 'aac', rendered,
  ])
  await expect(verify()).rejects.toThrow('Exported picture or audio does not match the approved video')
  expect(await hash(source)).toBe(approvedSha256)
})

it.each(['../outside.mp4', 'exports/con.mp4', 'exports/LPT1.mp4', 'exports/.hidden.mp4',
  'exports/nested/rendered.mp4', 'exports/audio.wav'])('rejects an invalid export name before file access (%s)', async (path) => {
  await expect(verifyApprovedClipExport('/unopened-fixture', '/unopened-source', 'a'.repeat(64), path,
    'ffmpeg', 10_000, new AbortController().signal)).rejects.toThrow('MP4 directly inside')
})

it.skipIf(!ffmpeg)('rejects linked, oversized and aliased exports', async () => {
  const f = await fixture()
  await unlink(f.rendered)
  await symlink(f.source, f.rendered, 'file')
  await expect(f.verify()).rejects.toThrow('regular export file')
  await unlink(f.rendered)
  await copyFile(f.source, f.rendered)
  await truncate(f.rendered, MEDIA_LIMITS.video + 1)
  await expect(f.verify()).rejects.toThrow('regular export file')
  await copyFile(f.source, f.rendered)
  const alias = join(f.root, 'project-alias')
  await symlink(f.project, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(verifyApprovedClipExport(alias, f.source, f.approvedSha256, f.target,
    ffmpeg!, 10_000, new AbortController().signal)).rejects.toThrow('regular export file')
  const observedFile = await lstat(f.source)
  const inspect = vi.spyOn(files, 'lstat').mockResolvedValueOnce(observedFile)
  try { await expect(f.verify()).rejects.toThrow('regular export file') }
  finally { inspect.mockRestore() }
})

it.skipIf(!ffmpeg)('rejects changed approved bytes and source streams beyond the media limit', async () => {
  const f = await fixture()
  await expect(verifyApprovedClipExport(f.project, f.source, '0'.repeat(64), f.target,
    ffmpeg!, 10_000, new AbortController().signal)).rejects.toThrow('Approved media changed')
  await truncate(f.source, MEDIA_LIMITS.video + 1)
  await expect(f.verify()).rejects.toThrow('Export exceeds the video size limit')
})

it.skipIf(!ffmpeg)('rejects a file reader that supplies decoded text in place of video bytes', async () => {
  const f = await fixture()
  const open = streams.createReadStream
  const reader = vi.spyOn(streams, 'createReadStream').mockImplementation((path, options) => {
    const stream = open(path, options)
    stream.setEncoding('utf8')
    return stream
  })
  try { await expect(f.verify()).rejects.toThrow('Expected video bytes') }
  finally { reader.mockRestore() }
})

it.skipIf(!ffmpeg).each(['video', 'audio'] as const)('requires a decodable %s track', async (missing) => {
  const f = await fixture()
  await f.encode(['-i', f.source, '-map', missing === 'video' ? '0:a:0' : '0:v:0', '-c', 'copy', f.rendered])
  await expect(f.verify()).rejects.toThrow('decodable video and audio')
})

it.skipIf(!ffmpeg).each(['0.1', '1'])('rejects picture and audio sample lengths from a shorter export (%s)', async (duration) => {
  const f = await fixture()
  await f.encode(['-i', f.source, '-t', duration, '-c:v', 'mpeg4', '-c:a', 'aac', f.rendered])
  await expect(f.verify()).rejects.toThrow('picture or audio does not match')
})

it.skipIf(!ffmpeg)('retains matching silent audio', async () => {
  const f = await fixture('anullsrc=r=32000:cl=mono')
  expect((await f.verify()).audioSimilarity).toBe(1)
})

it.skipIf(!ffmpeg).each([true, false])('rejects a silent track replacing voiced audio, silent source=%s', async (silentSource) => {
  const f = await fixture(silentSource ? 'anullsrc=r=32000:cl=mono' : undefined)
  await f.encode(['-i', f.source, '-f', 'lavfi', '-i', silentSource
    ? 'sine=frequency=421:sample_rate=32000' : 'anullsrc=r=32000:cl=mono',
  '-map', '0:v:0', '-map', '1:a:0', '-t', '2', '-c:v', 'copy', '-c:a', 'aac', f.rendered])
  await expect(f.verify()).rejects.toThrow('picture or audio does not match')
})

it.skipIf(!ffmpeg).each(['0.1', '3'])('rejects an out-of-range audio gain (%s)', async (gain) => {
  const f = await fixture()
  await f.encode(['-i', f.source, '-af', 'volume=' + gain, '-c:v', 'copy', '-c:a', 'aac', f.rendered])
  await expect(f.verify()).rejects.toThrow('picture or audio does not match')
})

it.skipIf(!ffmpeg).each(['source', 'export'] as const)('detects %s bytes changed after decoding', async (changed) => {
  const f = await fixture()
  const open = streams.createReadStream
  let hashes = 0
  const reader = vi.spyOn(streams, 'createReadStream').mockImplementation((path, options) => {
    hashes += 1
    if (hashes === (changed === 'source' ? 3 : 4)) writeFileSync(changed === 'source' ? f.source : f.rendered, 'changed')
    return open(path, options)
  })
  try { await expect(f.verify()).rejects.toThrow('changed during verification') }
  finally { reader.mockRestore() }
})
