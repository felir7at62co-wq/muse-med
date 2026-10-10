/** Publication cancellation waits for the current write, then preserves the receipt and staged audio. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { finishAudioTranscription, startAudioTranscription, type AudioAccount } from '../src/runner.ts'

const io = vi.hoisted(() => ({
  pause: undefined as ((operation: string, path: string) => Promise<void>) | undefined,
  writes: [] as string[], links: [] as string[], renames: [] as string[],
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args)
      await io.pause?.('mkdir', String(args[0]))
      return result
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      io.writes.push(String(args[0]))
      await actual.writeFile(...args)
      await io.pause?.('write', String(args[0]))
    },
    link: async (...args: Parameters<typeof actual.link>) => { io.links.push(String(args[1])); await actual.link(...args) },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      io.renames.push(String(args[1])); await actual.rename(...args); await io.pause?.('rename', String(args[1]))
    },
  }
})
const roots: string[] = []
afterEach(async () => {
  io.pause = undefined; io.writes = []; io.links = []; io.renames = []
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it.each([5, 25].flatMap(duration => ['mkdir', 'output-write', 'receipt-write', 'receipt-rename'].map(phase => ({ duration, phase }))))(
  'stops $duration-second publication after an aborted $phase without discarding recovery audio', async ({ duration, phase }) => {
    const project = await mkdtemp(join(tmpdir(), 'audio-publish-cancel-')), input = join(project, 'clip.mp4')
    roots.push(project)
    await writeFile(input, 'video')
    const account: AudioAccount = {
      status: async () => ({ state: 'signed-in', username: 'alice', verified: false }),
      submitAudio: async (_file, id) => ({ id, status: 'processing' }),
      audioStatus: async id => ({ id, status: 'complete', segments: [{ start: 0, end: 1, text: 'speech' }] }),
    }
    const config = { ffmpegPath: 'unused', ffprobePath: 'unused', commandTimeoutMs: 1000,
      maxDurationSeconds: 100, maxAudioBytes: 1024, chunkSeconds: 10 }
    const media = { probe: async () => duration, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
    const first = await startAudioTranscription(project, input, 'zh', account, config, media)
    const before = await readFile(first.receipt, 'utf8')
    const receipt = JSON.parse(before) as { mp3: string; parts?: { mp3: string }[] }
    const staged = receipt.parts?.map(part => part.mp3) ?? [receipt.mp3]
    const raw = join(project, 'transcript', 'raw')
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    io.writes = []; io.links = []; io.renames = []
    io.pause = async (operation, path) => {
      if (phase === 'mkdir' ? operation === 'mkdir' && path === raw
        : phase === 'output-write' ? operation === 'write' && dirname(path) === raw
          : phase === 'receipt-write' ? operation === 'write' && path.startsWith(`${first.receipt}.`)
            : operation === 'rename' && path === first.receipt) {
        entered.resolve(undefined); await release.promise
      }
    }
    const controller = new AbortController(), reason = new Error('cancelled publication')
    let settled = false
    const task = finishAudioTranscription(project, first.receipt, account, controller.signal)
    const observed = task.then(() => { settled = true }, () => { settled = true })
    try {
      await entered.promise
      controller.abort(reason)
      await Promise.resolve()
      expect(settled).toBe(false)
    } finally { release.resolve(undefined); await observed }
    await expect(task).rejects.toBe(reason)
    expect(io.links).toHaveLength(phase.startsWith('receipt-') ? 3 : 0)
    expect(io.writes).toHaveLength(phase === 'mkdir' ? 0 : phase === 'output-write' ? 1 : 4)
    expect(io.renames).toEqual(phase === 'receipt-rename' ? [first.receipt] : [])
    const after = await readFile(first.receipt, 'utf8')
    if (phase === 'receipt-rename') expect(JSON.parse(after)).toMatchObject({ status: 'complete' })
    else expect(after).toBe(before)
    for (const file of staged) expect(await readFile(file, 'utf8')).toBe('audio')
    expect(await readdir(raw)).toEqual(phase.startsWith('receipt-') ? ['clip-v1.json', 'clip-v1.srt', 'clip-v1.txt'] : [])
    expect((await readdir(dirname(first.receipt))).some(file => file.endsWith('.tmp'))).toBe(false)
  },
)
