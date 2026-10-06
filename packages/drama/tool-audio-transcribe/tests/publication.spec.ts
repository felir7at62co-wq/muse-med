/** Publication tolerates a concurrently removed SRT and uses native Windows file permissions. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { finishAudioTranscription, startAudioTranscription } from '../src/runner.ts'
import type { AudioAccount } from '../src/runner.ts'

const observation = vi.hoisted(() => ({ chmod: [] as string[], removeSrt: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    chmod: async (...args: Parameters<typeof actual.chmod>) => { observation.chmod.push(String(args[0])); await actual.chmod(...args) },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const path = String(args[0])
      if (observation.removeSrt && path.endsWith('.srt')) { observation.removeSrt = false; await actual.unlink(path) }
      return await actual.stat(...args)
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  observation.chmod = []; observation.removeSrt = false
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'audio-publication-')), input = join(project, 'source.mp4')
  roots.push(project)
  await writeFile(input, 'video')
  const account: AudioAccount = {
    status: async () => ({ state: 'signed-in', username: 'alice', verified: false }),
    submitAudio: async (_file, id) => ({ id, status: 'processing' }),
    audioStatus: async id => ({ id, status: 'complete', segments: [{ start: 0, end: 1, text: 'speech' }] }),
  }
  const config = { ffmpegPath: 'fixture', ffprobePath: 'fixture', commandTimeoutMs: 1_000, maxDurationSeconds: 60, maxAudioBytes: 1_024 }
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  return { project, input, account, config, media }
}

it('reports the existing TXT and JSON when another process removes the SRT after publication', async () => {
  const f = await fixture()
  const started = await startAudioTranscription(f.project, f.input, 'zh', f.account, f.config, f.media)
  observation.removeSrt = true
  const result = await finishAudioTranscription(f.project, started.receipt, f.account)
  expect(result.status).toBe('complete')
  expect(typeof result.output_txt).toBe('string')
  expect(typeof result.output_json).toBe('string')
  expect(result).not.toHaveProperty('output_srt')
  expect((JSON.parse(await readFile(result.receipt, 'utf8')) as { status: string }).status).toBe('complete')
})

it('publishes on the Windows path without issuing Unix chmod operations', async () => {
  const f = await fixture()
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (descriptor === undefined) throw new Error('missing process platform descriptor')
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    const started = await startAudioTranscription(f.project, f.input, 'zh', f.account, f.config, f.media)
    expect((await finishAudioTranscription(f.project, started.receipt, f.account)).status).toBe('complete')
    expect(observation.chmod).toEqual([])
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})
