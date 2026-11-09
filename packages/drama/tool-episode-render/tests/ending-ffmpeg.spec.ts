/** Real offline evidence that explicit stretching spans the complete ending window. */
import { execFile, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { COVERAGE_TEST_TIMEOUT_ENV, parseCoverageTestTimeout } from '../../../../scripts/coverage-partitions.ts'
import { buildEndingClip, requireEndingEffectFits } from '../src/ending.ts'
import { describeCommand, MediaCommandError, runFfmpeg } from '../src/ffmpeg.ts'

const ffmpeg = process.env.MUSE_FFMPEG_EXECUTABLE || process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobe = process.env.FFPROBE_PATH || (isAbsolute(ffmpeg)
  ? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe')
const available = spawnSync(ffmpeg, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 }).status === 0
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const testBudgetMs = parseCoverageTestTimeout(process.env[COVERAGE_TEST_TIMEOUT_ENV]) ?? 60_000
const cleanupReserveMs = 10_000

interface InterruptionFacts {
  timedOut: boolean
  cancelled: boolean
  killed: boolean
  signal: string | null
  errorCode: string | number | null
  exitCode: number | null
  elapsedMs: number
  timeoutMs: number
  pid: number | undefined
}

class FixtureInterruption extends Error {
  readonly stderr: string

  constructor(readonly command: string, readonly args: readonly string[], stderr: string, readonly facts: InterruptionFacts) {
    super(`Ending fixture command interrupted: ${describeCommand(command, args)}; ${JSON.stringify(facts)}; ${stderr.slice(-4000)}`)
    this.name = 'FixtureInterruption'
    this.stderr = stderr.slice(-4000)
  }
}

/** One total command budget, with every interrupted child reaped before cleanup completes. */
function createRunner(budgetMs: number, signal?: AbortSignal) {
  const deadline = performance.now() + budgetMs
  const active = new Map<ChildProcess, { closed: Promise<void>; cancel: () => void }>()
  let disposed = false
  let disposal: Promise<void> | undefined
  const dispose = () => {
    if (disposal !== undefined) return disposal
    disposed = true
    const remaining = [...active]
    for (const [, child] of remaining) child.cancel()
    disposal = Promise.all(remaining.map(([, child]) => child.closed)).then(() => undefined)
    return disposal
  }
  cleanups.push(dispose)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key)))
  const run = async (command: string, args: readonly string[]) => await new Promise<{
    code: number
    stdout: string
    stderr: string
    interrupted: boolean
    signal: string | null
  }>((resolve, reject) => {
    if (disposed || signal?.aborted) throw new Error('Ending fixture already disposed or cancelled')
    const started = performance.now(), timeoutMs = Math.max(1, Math.floor(deadline - started))
    let timedOut = false, cancelled = false
    const child = execFile(command, [...args], { windowsHide: true, encoding: 'utf8', env: environment,
      maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const facts: InterruptionFacts = {
        timedOut, cancelled, killed: child.killed, signal: error?.signal ?? child.signalCode,
        errorCode: error?.code ?? null, exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        elapsedMs: Math.round(performance.now() - started), timeoutMs, pid: child.pid,
      }
      if (facts.timedOut || facts.cancelled || facts.killed || facts.signal !== null) {
        reject(new FixtureInterruption(command, args, stderr, facts))
        return
      }
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 127, stdout, stderr,
        interrupted: error?.killed ?? false, signal: error?.signal ?? null })
    })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    const cancel = () => { cancelled = true; clearTimeout(timer); child.kill() }
    signal?.addEventListener('abort', cancel, { once: true })
    const closed = new Promise<void>((done) => { child.once('close', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      active.delete(child)
      done()
    }) })
    active.set(child, { closed, cancel })
    if (signal?.aborted) cancel()
  })
  return { run, dispose }
}

it('reports its own child deadline through the media channel and reaps the child', async ({ signal }) => {
  const runner = createRunner(150, signal)
  const caught = await runFfmpeg({ ffmpeg: process.execPath, ffprobe: process.execPath, channel: runner },
    ['-e', 'setInterval(() => {}, 1000)']).catch((error: unknown) => error)
  expect(caught).toBeInstanceOf(FixtureInterruption)
  if (!(caught instanceof FixtureInterruption)) throw new Error('Missing fixture interruption')
  expect(caught.facts).toMatchObject({ timedOut: true, cancelled: false, killed: true })
  expect(caught.message).toContain('"signal":')
  expect(caught.message).toContain('"errorCode":')
  await runner.dispose()
  const pid = caught.facts.pid
  if (pid === undefined) throw new Error('Missing interrupted child PID')
  expect(() => process.kill(pid, 0)).toThrow()
}, testBudgetMs)

it('keeps an ordinary command failure distinct from a fixture interruption', async ({ task, signal }) => {
  const runner = createRunner(task.timeout - cleanupReserveMs, signal)
  const caught = await runFfmpeg({ ffmpeg: process.execPath, ffprobe: process.execPath, channel: runner },
    ['-e', 'process.stderr.write("ordinary fixture failure"); process.exit(7)']).catch((error: unknown) => error)
  expect(caught).toBeInstanceOf(MediaCommandError)
  expect(caught).toMatchObject({ code: 7, stderr: 'ordinary fixture failure' })
}, testBudgetMs)

it('distinguishes cancellation from expiry of the child deadline', async () => {
  const controller = new AbortController(), runner = createRunner(testBudgetMs - cleanupReserveMs, controller.signal)
  const pending = runner.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    .catch((error: unknown) => error)
  controller.abort()
  expect(await pending).toMatchObject({ facts: { timedOut: false, cancelled: true, killed: true } })
}, testBudgetMs)

it.skipIf(!available)('stretches all source motion across two seconds without a repeated or black-padded second half', async ({ task, signal }) => {
  // CI already grants 90 s to this case; reserve 10 s for reporting, child exit and directory cleanup.
  const runner = createRunner(task.timeout - cleanupReserveMs, signal)
  const project = await mkdtemp(join(tmpdir(), 'dsh-ending-fit-'))
  const toolkit = { ffmpeg, ffprobe, channel: runner }
  const { run } = runner
  const cleanup = async () => { await runner.dispose(); await rm(project, { recursive: true, force: true }) }
  cleanups.push(cleanup)
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
}, testBudgetMs)
