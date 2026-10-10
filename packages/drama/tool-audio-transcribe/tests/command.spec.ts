/** Real media child processes enforce timeout and cumulative output limits before paid submission. */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AudioAccount } from '../src/runner.ts'
import { startAudioTranscription } from '../src/runner.ts'

const adapter = vi.hoisted(() => ({
  probe: "process.stdout.write('30');process.stderr.write('probe diagnostic')",
  encode: "require('node:fs').writeFileSync(process.argv.at(-1), 'audio')",
  children: [] as { closed: Promise<void>; isClosed: () => boolean; terminate: () => void }[],
  onReady: undefined as (() => void) | undefined,
  onSpawn: undefined as (() => void) | undefined,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => {
    const child = command === 'missing-media-binary'
      ? actual.spawn(command, args, options)
      : actual.spawn(process.execPath, ['-e', command === 'fixture-probe' ? adapter.probe : adapter.encode, '--', ...args], options)
    if (command === 'fixture-encode') child.stdout?.once('data', () => { adapter.onReady?.() })
    let closed = false
    adapter.children.push({ closed: new Promise<void>(resolve => child.once('close', () => { closed = true; resolve() })),
      isClosed: () => closed,
      terminate: () => { child.kill() } })
    adapter.onSpawn?.()
    return child
  } }
})

const roots: string[] = []
afterEach(async () => {
  const children = adapter.children.splice(0)
  for (const child of children) child.terminate()
  await Promise.all(children.map(child => child.closed))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  adapter.probe = "process.stdout.write('30');process.stderr.write('probe diagnostic')"
  adapter.encode = "require('node:fs').writeFileSync(process.argv.at(-1), 'audio')"
  adapter.onReady = undefined
  adapter.onSpawn = undefined
  vi.useRealTimers()
})

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'audio-command-'))
  roots.push(project)
  const input = join(project, 'input.mp4')
  await writeFile(input, 'video')
  const submissions: string[] = []
  const account: AudioAccount = {
    status: async () => ({ state: 'signed-in', username: 'fixture', verified: false }),
    submitAudio: async (_file, id) => { submissions.push(id); return { id, status: 'processing' } },
    audioStatus: async () => { throw new Error('unexpected status query') },
  }
  const config = { ffprobePath: 'fixture-probe', ffmpegPath: 'fixture-encode', commandTimeoutMs: 2_000,
    maxDurationSeconds: 100, maxAudioBytes: 1_024 }
  return { project, input, account, config, submissions }
}

it('extracts through the configured media executables before submitting one receipt', async () => {
  const f = await fixture()
  const result = await startAudioTranscription(f.project, f.input, 'zh', f.account, f.config)
  expect(result.status).toBe('processing')
  expect(f.submissions).toEqual([result.job_id])
})

it('extracts each long-media range through the configured executable before submitting durable parts', async () => {
  const f = await fixture()
  const result = await startAudioTranscription(f.project, f.input, 'zh', f.account, { ...f.config, chunkSeconds: 10 })
  expect(result.status).toBe('processing')
  expect(f.submissions).toHaveLength(3)
  expect(new Set(f.submissions).size).toBe(3)
  expect(f.submissions).not.toContain(result.job_id)
})

it('reports a missing configured executable without submitting or retaining staged audio', async () => {
  const f = await fixture()
  await expect(startAudioTranscription(f.project, f.input, 'zh', f.account,
    { ...f.config, ffprobePath: 'missing-media-binary' })).rejects.toThrow('unavailable')
  expect(f.submissions).toEqual([])
  expect(await readdir(join(f.project, 'transcript', 'jobs'))).toEqual([])
})

it.each(['stdout', 'stderr'] as const)('rejects cumulative %s overflow even when the child handles termination with exit 0', async (kind) => {
  const f = await fixture()
  adapter.encode = `process.on('SIGTERM', () => process.exit(0));setInterval(() => process.${kind}.write('x'.repeat(16384)), 1)`
  await expect(startAudioTranscription(f.project, f.input, 'zh', f.account,
    f.config)).rejects.toThrow('Media extraction or probe failed')
  expect(f.submissions).toEqual([])
  expect(await readdir(join(f.project, 'transcript', 'jobs'))).toEqual([])
})

it('rejects a command deadline after its termination handler is ready', async () => {
  const f = await fixture()
  adapter.encode = "process.on('SIGTERM', () => process.exit(0));process.stdout.write('ready');setInterval(() => {}, 1000)"
  const ready = new Promise<void>((resolve) => { adapter.onReady = resolve })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const rejection = expect(startAudioTranscription(f.project, f.input, 'zh', f.account,
    f.config)).rejects.toThrow('Media extraction or probe failed')
  await ready
  await vi.advanceTimersByTimeAsync(f.config.commandTimeoutMs)
  await rejection
  expect(f.submissions).toEqual([])
  expect(await readdir(join(f.project, 'transcript', 'jobs'))).toEqual([])
})


it('kills an active extraction and waits for process close before cancelling and removing staging', async () => {
  const f = await fixture(), controller = new AbortController(), reason = new Error('cancelled extraction')
  adapter.encode = "process.on('SIGTERM', () => process.exit(0));process.stdout.write('ready');setInterval(() => {}, 1000)"
  const ready = new Promise<void>((resolve) => { adapter.onReady = resolve })
  const task = startAudioTranscription(f.project, f.input, 'zh', f.account, f.config, undefined, undefined, controller.signal)
  const rejection = expect(task).rejects.toBe(reason)
  await ready
  controller.abort(reason)
  await rejection
  expect(adapter.children.every(child => child.isClosed())).toBe(true)
  expect(f.submissions).toEqual([])
  expect(await readdir(join(f.project, 'transcript', 'jobs'))).toEqual([])
})

it('preserves a cancellation arriving during spawn before the abort listener is installed', async () => {
  const f = await fixture(), controller = new AbortController(), reason = 'cancel during spawn'
  adapter.onSpawn = () => { controller.abort(reason) }
  await expect(startAudioTranscription(f.project, f.input, 'zh', f.account, f.config,
    undefined, undefined, controller.signal)).rejects.toBe(reason)
  expect(adapter.children.every(child => child.isClosed())).toBe(true)
  expect(f.submissions).toEqual([])
  expect(await readdir(join(f.project, 'transcript', 'jobs'))).toEqual([])
})
