/** Cancellation stops new media/cloud work and waits for owned work before cleaning staging. */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MuseAsrError } from '@deepseek-ai/dsh-muse-account'
import { finishAudioTranscription, startAudioTranscription, type AudioAccount } from '../src/runner.ts'

const hashing = vi.hoisted(() => ({ onOpen: undefined as ((stream: import('node:fs').ReadStream) => void) | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
    const stream = actual.createReadStream(...args)
    hashing.onOpen?.(stream)
    return stream
  } }
})

const roots: string[] = []
afterEach(async () => {
  hashing.onOpen = undefined
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const config = { ffmpegPath: 'unused', ffprobePath: 'unused', commandTimeoutMs: 1000, maxDurationSeconds: 100,
  maxAudioBytes: 1024, chunkSeconds: 10 }

async function fixture(duration = 25) {
  const project = await mkdtemp(join(tmpdir(), 'audio-cancel-'))
  roots.push(project)
  const input = join(project, 'clip.mp4')
  await writeFile(input, 'media')
  const status = vi.fn<AudioAccount['status']>(async () => ({ state: 'signed-in', username: 'alice', verified: false }))
  const submitAudio = vi.fn<AudioAccount['submitAudio']>(async (_file, id) => ({ id, status: 'processing' }))
  const audioStatus = vi.fn<AudioAccount['audioStatus']>(async id => ({ id, status: 'processing' }))
  const account: AudioAccount = { status, submitAudio, audioStatus }
  const media = { probe: async () => duration, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  return { project, input, account, media, status, submitAudio, audioStatus, jobs: join(project, 'transcript', 'jobs') }
}

it('rejects a pre-cancelled start before identity lookup or local staging', async () => {
  const f = await fixture(), controller = new AbortController(), reason = new Error('cancelled start')
  controller.abort(reason)
  await expect(startAudioTranscription(f.project, f.input, 'zh', f.account, config, f.media, undefined, controller.signal)).rejects.toBe(reason)
  expect(f.status).not.toHaveBeenCalled()
  await expect(stat(f.jobs)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([5, 25])('waits for a %ss encoder to settle before deleting unreceipted audio', async (duration) => {
  const f = await fixture(duration), controller = new AbortController(), reason = new Error('cancelled extraction')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let settled = false, target = ''
  const encode = vi.fn(async (_source: string, file: string) => {
    target = file; entered.resolve(undefined); await release.promise; await writeFile(file, 'last encoder write')
  })
  const task = startAudioTranscription(f.project, f.input, 'zh', f.account, config,
    { ...f.media, encode }, undefined, controller.signal)
  const observed = task.then(() => { settled = true }, () => { settled = true })
  try {
    await entered.promise
    controller.abort(reason)
    await Promise.resolve(undefined)
    expect(settled).toBe(false)
    expect(await stat(target)).toBeDefined()
  } finally { release.resolve(undefined); await observed }
  await expect(task).rejects.toBe(reason)
  expect(encode).toHaveBeenCalledTimes(1)
  expect(f.submitAudio).not.toHaveBeenCalled()
  expect(await readdir(f.jobs)).toEqual([])
})

it('awaits an interrupted upload, retains its prepared receipt, and never submits remaining parts', async () => {
  const f = await fixture(), controller = new AbortController(), reason = new Error('cancelled upload')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let settled = false
  f.submitAudio.mockImplementation(async (_file, id) => { entered.resolve(undefined); await release.promise; return { id, status: 'processing' } })
  const task = startAudioTranscription(f.project, f.input, 'zh', f.account, config, f.media, undefined, controller.signal)
  const observed = task.then(() => { settled = true }, () => { settled = true })
  try {
    await entered.promise
    controller.abort(reason)
    await Promise.resolve(undefined)
    expect(settled).toBe(false)
  } finally { release.resolve(undefined); await observed }
  await expect(task).rejects.toBe(reason)
  expect(f.submitAudio).toHaveBeenCalledTimes(1)
  expect(f.submitAudio.mock.calls[0]?.[5]).toBe(controller.signal)
  const receipt = JSON.parse(await readFile(join(f.jobs, 'clip-v1.json'), 'utf8')) as { status: string; parts: { mp3: string }[] }
  expect(receipt.status).toBe('prepared')
  expect(receipt.parts).toHaveLength(3)
  for (const part of receipt.parts) expect(await readFile(part.mp3, 'utf8')).toBe('audio')
})

it.each([5, 25].flatMap(duration => ['processing', 'preparing', 'missing', 'complete'].map(status => ({ duration, status }))))(
  'stops a cancelled $duration-second status query before $status recovery or publication', async ({ duration, status }) => {
    const f = await fixture(duration), controller = new AbortController(), reason = new Error('cancelled query')
    const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, f.media)
    const initial = JSON.parse(await readFile(first.receipt, 'utf8')) as Record<string, unknown>
    await writeFile(first.receipt, JSON.stringify({ ...initial, status: 'prepared' }))
    const before = await readFile(first.receipt, 'utf8')
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    f.audioStatus.mockImplementation(async (id) => {
      entered.resolve(undefined); await release.promise
      if (status === 'missing') throw new MuseAsrError('job-not-found')
      if (status === 'complete') return { id, status, segments: [{ start: 0, end: 1, text: 'speech' }] }
      return { id, status: status === 'preparing' ? 'preparing' : 'processing' }
    })
    f.submitAudio.mockClear()
    const task = finishAudioTranscription(f.project, first.receipt, f.account, controller.signal)
    const observed = task.catch(() => {})
    try { await entered.promise; controller.abort(reason) }
    finally { release.resolve(undefined); await observed }
    await expect(task).rejects.toBe(reason)
    expect(f.audioStatus).toHaveBeenCalledTimes(1)
    expect(f.audioStatus.mock.calls[0]?.[1]).toBe(controller.signal)
    expect(f.submitAudio).not.toHaveBeenCalled()
    expect(await readFile(first.receipt, 'utf8')).toBe(before)
    await expect(stat(join(f.project, 'transcript', 'raw'))).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it('rejects a pre-cancelled status without reading a receipt or querying the account', async () => {
  const f = await fixture(), controller = new AbortController(), reason = new Error('cancelled status')
  controller.abort(reason)
  await mkdir(f.jobs, { recursive: true })
  await expect(finishAudioTranscription(f.project, join(f.jobs, 'missing-v1.json'), f.account, controller.signal)).rejects.toBe(reason)
  expect(f.status).not.toHaveBeenCalled()
  expect(f.audioStatus).not.toHaveBeenCalled()
})

it.each(['cancel', 'read-error'] as const)('settles a source hash interrupted by %s before any paid submission', async (failure) => {
  const f = await fixture(5), controller = new AbortController(), reason = new Error('source hash interrupted')
  let stream: import('node:fs').ReadStream | undefined
  hashing.onOpen = (opened) => {
    stream = opened
    if (failure === 'cancel') controller.abort(reason)
    else opened.destroy(reason)
  }
  await expect(startAudioTranscription(f.project, f.input, 'zh', f.account, config,
    f.media, undefined, controller.signal)).rejects.toBe(reason)
  expect(stream?.closed).toBe(true)
  expect(f.submitAudio).not.toHaveBeenCalled()
  expect(await readdir(f.jobs)).toEqual([])
})
