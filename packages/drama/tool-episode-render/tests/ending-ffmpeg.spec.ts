/** Real offline evidence that explicit stretching spans the complete ending window. */
import { execFile, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildEndingClip, requireEndingEffectFits } from '../src/ending.ts'

const ffmpeg = process.env.MUSE_FFMPEG_EXECUTABLE || process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobe = process.env.FFPROBE_PATH || (isAbsolute(ffmpeg)
  ? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe')
const available = spawnSync(ffmpeg, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 }).status === 0
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

it.skipIf(!available)('stretches all source motion across two seconds without a repeated or black-padded second half', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ending-fit-'))
  const active = new Map<ChildProcess, Promise<void>>()
  let disposed = false
  const cleanup = async () => {
    if (disposed) return
    disposed = true
    const remaining = [...active]
    for (const [child] of remaining) child.kill()
    await Promise.all(remaining.map(([, closed]) => closed))
    await rm(project, { recursive: true, force: true })
  }
  cleanups.push(cleanup)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key)))
  const run = async (command: string, args: readonly string[]) => await new Promise<{
    code: number
    stdout: string
    stderr: string
    interrupted: boolean
    signal: string | null
  }>((resolve) => {
    if (disposed) throw new Error('Ending fixture already disposed')
    const child = execFile(command, [...args], { windowsHide: true, encoding: 'utf8', env: environment,
      timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 127, stdout, stderr,
        interrupted: error?.killed ?? false, signal: error?.signal ?? null })
    })
    const closed = new Promise<void>((done) => { child.once('close', () => { active.delete(child); done() }) })
    active.set(child, closed)
  })
  const toolkit = { ffmpeg, ffprobe, channel: { run } }
  const command = async (args: string[]) => {
    const result = await run(ffmpeg, args)
    expect(result.interrupted, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBeNull()
    expect(result.code, result.stderr).toBe(0)
    return result
  }
  try {
    const source = join(project, 'effect.mp4'), base = join(project, 'base.png'), output = join(project, 'ending.mp4')
    await command(['-n', '-v', 'error', '-f', 'lavfi', '-i', 'color=white:s=64x64:r=50:d=1.02',
      '-vf', 'fade=t=in:st=0:d=1.02', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source])
    await command(['-n', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.1', '-frames:v', '1', base])
    const timing = await requireEndingEffectFits(toolkit, source, 'stretch_to_window')
    expect(timing).toEqual({ fit: 'stretch_to_window', sourceDurationSeconds: 1.02, targetDurationSeconds: 2, speed: 0.51 })
    await buildEndingClip(toolkit, base, source, output, 'libx264', ['-preset', 'ultrafast'],
      { width: 64, height: 64, fps: 24 }, timing)
    const probed = await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=duration,nb_frames', '-of', 'json', output])
    expect(probed.interrupted, probed.stderr).toBe(false)
    expect(probed.signal, probed.stderr).toBeNull()
    expect(probed.code, probed.stderr).toBe(0)
    expect(JSON.parse(probed.stdout)).toMatchObject({ streams: [{ duration: '2.000000', nb_frames: '48' }] })
    const means: number[] = []
    for (const start of [0.2, 0.8, 1.4, 1.8]) {
      const measured = await command(['-v', 'error', '-ss', String(start), '-i', output, '-frames:v', '1',
        '-vf', 'signalstats,metadata=mode=print:file=-', '-f', 'null', '-'])
      const match = /lavfi\.signalstats\.YAVG=([\d.]+)/u.exec(measured.stdout)
      if (match === null) throw new Error('Missing decoded brightness measurement')
      means.push(Number(match[1]))
    }
    for (let index = 1; index < means.length; index++) {
      const current = means[index], previous = means[index - 1]
      if (current === undefined || previous === undefined) throw new Error('Missing ending observation')
      expect(current - previous).toBeGreaterThan(15)
    }
  } finally {
    await cleanup()
  }
// This case performs a real optical-flow render; every child has its own 30 s deadline.
}, 60_000)
