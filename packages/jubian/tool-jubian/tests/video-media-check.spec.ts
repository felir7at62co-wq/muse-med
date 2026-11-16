/** Real bundled FFmpeg decoding and managed-range cancellation. */
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { downloadMedia } from '@deepseek-ai/dsh-jubian-api'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { checkVideoMedia, decodeVideoFile, VideoMediaDrainError, type VideoMediaDecoder } from '../src/video-media-check.ts'

vi.mock('@deepseek-ai/dsh-jubian-api', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-jubian-api')>(), downloadMedia: vi.fn(),
}))

const ffmpeg = process.env.MUSE_RECOVERY_TEST_FFMPEG ?? process.env.DSH_FFMPEG_PATH
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture(audio = true, duration = '0.3') {
  if (ffmpeg === undefined) throw new Error('Set MUSE_RECOVERY_TEST_FFMPEG to the bundled native decoder')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-managed-decoder-')))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(SubprocessLocal)
  const path = join(root, 'captured.mp4')
  const executable = await ctx.subprocess.resolveExecutable(ffmpeg)
  const handle = ctx.subprocess.spawn({ argv: [executable, '-nostdin', '-v', 'error', '-f', 'lavfi',
    '-i', 'color=black:size=32x32:rate=10', ...(audio ? ['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono'] : []),
    '-t', duration, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : ['-an']), path],
  cwd: root, graceMs: 100, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
  const outcome = await handle.done
  expect(await handle.waitForExit()).toBe(true)
  expect(outcome.exitCode, handle.collected.stderr?.readFrom(0).text).toBe(0)
  const decoder: VideoMediaDecoder = { subprocess: ctx.subprocess, ffmpegPath: executable,
    timeoutMs: 5000, graceMs: 100, maxOutputBytes: 4096 }
  return { root, ctx, path, decoder }
}

it.skipIf(ffmpeg === undefined)('decodes exact video and audio tracks and refuses missing tracks or malformed input', async () => {
  const f = await fixture()
  expect(await decodeVideoFile(f.path, f.decoder, new AbortController().signal)).toEqual({ video: true, audio: true })
  const silent = await fixture(false)
  expect(await decodeVideoFile(silent.path, silent.decoder, new AbortController().signal)).toEqual({ video: true, audio: false })
  const corrupt = join(f.root, 'corrupt.mp4')
  await writeFile(corrupt, 'not an MP4')
  expect(await decodeVideoFile(corrupt, f.decoder, new AbortController().signal)).toEqual({ video: false, audio: false })
})

it.skipIf(ffmpeg === undefined)('does not settle cancellation before the actual managed decoder range drains', async () => {
  const f = await fixture(true, '10')
  const entered = Promise.withResolvers<undefined>(), joined = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  vi.stubEnv('MUSE_TEST_COOKIE', 'private-fixture-cookie')
  const probe = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    expect(spec.argv).toContain('file')
    expect(spec.env).toHaveProperty('MUSE_TEST_COOKIE', undefined)
    const handle = spawn({ ...spec, argv: [spec.argv[0]!, '-re', ...spec.argv.slice(1)] })
    const wait = handle.waitForExit.bind(handle)
    handle.waitForExit = async (signal) => {
      expect(signal).toBeUndefined()
      expect(await wait()).toBe(true)
      joined.resolve(undefined); await release.promise; return true
    }
    entered.resolve(undefined)
    return handle
  })
  const cancellation = new AbortController()
  let settled = false
  const operation = decodeVideoFile(f.path, f.decoder, cancellation.signal).finally(() => { settled = true })
  const rejected = expect(operation).rejects.toThrow('user cancelled decoder')
  await entered.promise
  cancellation.abort(new Error('user cancelled decoder'))
  expect(await Promise.race([joined.promise.then(() => 'joined'), operation.catch(() => 'settled')])).toBe('joined')
  expect(settled).toBe(false)
  release.resolve(undefined)
  await rejected
  expect(probe).toHaveBeenCalledTimes(1)
})

it.skipIf(ffmpeg === undefined)('reports a deadline-cut decode as failed after its native process exits', async () => {
  const f = await fixture(true, '10')
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation(spec => spawn({ ...spec, argv: [spec.argv[0]!, '-re', ...spec.argv.slice(1)] }))
  expect(await decodeVideoFile(f.path, { ...f.decoder, timeoutMs: 1 }, new AbortController().signal))
    .toEqual({ video: false, audio: false })
})


it.skipIf(ffmpeg === undefined)('downloads exact bytes, decodes both tracks and removes its captured temporary input', async () => {
  const f = await fixture()
  const bytes = await readFile(f.path), sha256 = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
  vi.mocked(downloadMedia).mockResolvedValueOnce({ bytes, sha256, kind: 'video', media_type: 'video/mp4' })
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  let capture = ''
  vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => { capture = spec.cwd; return spawn(spec) })
  expect(await checkVideoMedia('https://fixture.invalid/video.mp4', f.decoder, new AbortController().signal))
    .toEqual({ sha256, video: true, audio: true })
  await expect(lstat(capture)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(ffmpeg === undefined).each(['spawn-failure', 'lost-observation', 'false-join'] as const)(
  'retains input only when native decoder teardown is unconfirmed: %s', async (mode) => {
    const f = await fixture(), bytes = await readFile(f.path)
    vi.mocked(downloadMedia).mockResolvedValueOnce({ bytes, sha256: 'sha256:fixture', kind: 'video', media_type: 'video/mp4' })
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    let capture = ''
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      capture = spec.cwd
      if (mode === 'spawn-failure') throw new Error('decoder startup failed')
      const handle = spawn(spec), wait = handle.waitForExit.bind(handle)
      handle.waitForExit = async () => {
        expect(await wait()).toBe(true)
        if (mode === 'lost-observation') throw new Error('provider observation lost')
        return false
      }
      return handle
    })
    const result = checkVideoMedia('https://fixture.invalid/video.mp4', f.decoder, new AbortController().signal)
    if (mode === 'spawn-failure') {
      await expect(result).rejects.toThrow('startup failed')
      await expect(lstat(capture)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await expect(result).rejects.toBeInstanceOf(VideoMediaDrainError)
      expect((await lstat(join(capture, 'output.mp4'))).isFile()).toBe(true)
      await rm(capture, { recursive: true })
    }
  },
)

it.skipIf(ffmpeg === undefined).each(['failure', 'deadline', 'cancel'] as const)(
  'joins a real native range when the provider rejects its outcome: %s', async (mode) => {
    const f = await fixture(true, '10'), cancellation = new AbortController(), entered = Promise.withResolvers<undefined>()
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = spawn({ ...spec, argv: [spec.argv[0]!, '-re', ...spec.argv.slice(1)] })
      const done: SubprocessHandle['done'] = mode === 'failure' ? Promise.reject(new Error('provider outcome unavailable'))
        : new Promise((_resolve, reject) => { spec.signal?.addEventListener('abort', () => { reject(new Error('fixture decode cancelled', { cause: spec.signal?.reason })) }, { once: true }) })
      entered.resolve(undefined)
      return { ...handle, done }
    })
    const operation = decodeVideoFile(f.path, { ...f.decoder, timeoutMs: mode === 'deadline' ? 1 : 5000 }, cancellation.signal)
    if (mode === 'cancel') {
      const rejected = expect(operation).rejects.toThrow('cancel provider run')
      await entered.promise; cancellation.abort(new Error('cancel provider run')); await rejected
    } else if (mode === 'deadline') expect(await operation).toEqual({ video: false, audio: false })
    else await expect(operation).rejects.toThrow('provider outcome unavailable')
  },
)
