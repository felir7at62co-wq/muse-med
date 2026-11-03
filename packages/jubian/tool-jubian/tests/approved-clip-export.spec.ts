/** Verify an independently encoded export against the approved source. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'
import { verifyApprovedClipExport } from '../src/approved-clip-export.ts'

const ffmpeg = process.env.MUSE_RECOVERY_TEST_FFMPEG ?? process.env.DSH_FFMPEG_PATH
const execute = promisify(execFile)

it.skipIf(!ffmpeg)('accepts the same picture and sound after encoding and rejects unrelated tracks', async () => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'muse-approved-export-')))
  onTestFinished(async () => { await rm(project, { recursive: true, force: true, maxRetries: 3 }) })
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
    '-f', 'lavfi', '-i', 'testsrc2=size=96x54:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=421:sample_rate=32000',
    '-t', '2', '-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'aac', source,
  ])
  const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
  const approvedSha256 = await hash(source)
  const verify = () => verifyApprovedClipExport(project, source, approvedSha256, target,
    ffmpeg!, 10_000, new AbortController().signal)

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
