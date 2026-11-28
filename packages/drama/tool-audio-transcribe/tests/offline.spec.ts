/** Verify that local word timing retains measured intervals and rejects unmeasured words. */
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { offlineWordSpans, transcribeOffline } from '../src/offline.ts'
import { inspectPronunciation } from '../src/pronunciation.ts'
import * as speech from '../src/pronunciation-runtime.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdir: vi.fn(actual.mkdir) }
})

const measured = {
  start: 0.2, end: 1.8, text: '玻璃球。',
  words: [{ start: 0.3, end: 0.8, text: '玻璃' }, { start: 1.3, end: 1.7, text: '球。' }],
}

it('keeps the measured leading and internal gaps, and returns empty for no recognized words', () => {
  expect(offlineWordSpans(JSON.stringify([measured]), 2)).toEqual([measured])
  expect(offlineWordSpans('[]', 2)).toEqual([])
  expect(offlineWordSpans(JSON.stringify([{ ...measured, text: '。', words: [{ ...measured.words[0], text: '。' }] }]), 2))
    .toEqual([])
})

it('rejects zero-length, overlapping, or out-of-range timings', () => {
  const secondWord = measured.words[1]!
  const withSecondWord = (changes: Partial<typeof secondWord>) => JSON.stringify([
    { ...measured, words: [measured.words[0], { ...secondWord, ...changes }] },
  ])
  expect(() => offlineWordSpans(withSecondWord({ end: secondWord.start }), 2)).toThrow('OFFLINE_ASR_WORD_TIME')
  expect(() => offlineWordSpans(withSecondWord({ start: 0.7 }), 2)).toThrow('OFFLINE_ASR_INFERENCE')
  expect(() => offlineWordSpans(withSecondWord({ end: 1.9 }), 2)).toThrow('OFFLINE_ASR_INFERENCE')
  expect(() => offlineWordSpans(JSON.stringify([measured]), 1.75)).toThrow('OFFLINE_ASR_INFERENCE')
})

it.each(['{', '{}', JSON.stringify([{ ...measured, start: measured.end }]),
  JSON.stringify([{ ...measured, words: [] }])])('refuses malformed or unmeasured engine segments: %s', (raw) => {
  expect(() => offlineWordSpans(raw, 2)).toThrow('OFFLINE_ASR_INFERENCE')
})

const config = { ffmpegPath: 'fixture-ffmpeg', ffprobePath: 'unused', commandTimeoutMs: 1000,
  maxDurationSeconds: 30, maxAudioBytes: 128_000 }

async function withLocalSpeechFixture(test: (fixture: {
  project: string
  source: string
  runtime: speech.OfflineSpeechConfig
  signal: AbortSignal
}) => Promise<void>, filename = 'dialogue.wav'): Promise<void> {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'muse-offline-speech-fixture-')))
  const source = join(project, filename)
  const library = join(project, 'library')
  const models = join(project, 'models')
  const python = join(project, 'fixture-python')
  const signal = new AbortController().signal
  // Only deployment asset attestation is synthetic. Inputs, digests and publication use native files.
  const verifiedRuntime = vi.spyOn(speech, 'verifiedSpeechRuntime').mockResolvedValue({ python, library, models })
  const pinnedModel = vi.spyOn(speech, 'verifyPinnedSpeechModel').mockResolvedValue(undefined)
  try {
    await Promise.all([mkdir(library), mkdir(models), writeFile(source, 'original media')])
    const runtime = { pythonPath: python, libraryDir: library, modelDir: models,
      librarySha256: await speech.offlineLibraryDigest(library, signal) }
    await test({ project, source, runtime, signal })
  } finally {
    verifiedRuntime.mockRestore()
    pinnedModel.mockRestore()
    await rm(project, { recursive: true, force: true })
  }
}

it.each(['recognized', 'no words', 'source changed', 'pcm changed', 'model changed', 'invalid pcm'] as const)(
  'handles %s in the offline publication path', async (outcome) => {
    await withLocalSpeechFixture(async ({ project, source, runtime, signal }) => {
      await mkdir(join(project, 'transcript', 'offline'), { recursive: true })
      const command = vi.spyOn(speech, 'command').mockImplementation(async (executable, args) => {
        const pcm = args.at(-1)
        if (pcm === undefined) throw new Error('Missing PCM fixture path')
        if (executable === config.ffmpegPath) {
          expect(args).toContain(source)
          if (source.endsWith('.mp4')) expect(args).toContain('-enable_drefs')
          await writeFile(pcm, Buffer.alloc(outcome === 'invalid pcm' ? 3 : 64_000))
          return ''
        }
        expect(executable).toBe(runtime.pythonPath)
        expect(await readFile(pcm)).toHaveLength(64_000)
        if (outcome === 'source changed') await writeFile(source, 'changed during inference')
        if (outcome === 'pcm changed') await writeFile(pcm, Buffer.alloc(64_000, 1))
        if (outcome === 'model changed') await writeFile(join(runtime.libraryDir, 'added.py'), 'changed dependencies')
        return JSON.stringify(outcome === 'no words' ? [] : [measured])
      })
      try {
        const result = transcribeOffline(project, project, source, config, runtime, signal)
        if (outcome !== 'recognized' && outcome !== 'no words') {
          await expect(result).rejects.toThrow(outcome === 'invalid pcm' ? 'OFFLINE_ASR_MEDIA' : 'OFFLINE_ASR_CHANGED')
          expect(await readdir(join(project, 'transcript', 'offline'))).toEqual([])
          return
        }
        const transcript = await result
        expect(transcript).toMatchObject({ source: { path: source, sha256: await speech.digest(source, signal) },
          pcm: { samples: 32_000, sampleRate: 16_000 }, listening_verified: false })
        expect(transcript.recognition).toBe(outcome === 'no words' ? 'no_reliable_words' : undefined)
        expect(JSON.parse(await readFile(transcript.transcript.path, 'utf8'))).toEqual(outcome === 'no words' ? [] : [measured])
        expect(await speech.digest(transcript.transcript.path, signal)).toBe(transcript.transcript.sha256)
        expect(JSON.parse(await readFile(transcript.receipt, 'utf8'))).toEqual(transcript)
        expect((await readdir(dirname(transcript.receipt))).sort()).toEqual(['receipt.json', 'words.json'])
      } finally {
        command.mockRestore()
      }
    }, outcome === 'recognized' ? 'dialogue.mp4' : undefined)
  })

it('checks offline input and a configured runtime before starting media commands', async () => {
  await withLocalSpeechFixture(async ({ project, source, runtime, signal }) => {
    const command = vi.spyOn(speech, 'command')
    try {
      const unknown = join(project, 'dialogue.weird')
      await writeFile(unknown, 'unsupported media')
      const run = (input = source) => transcribeOffline(project, project, input, config, runtime, signal)
      await expect(run(unknown)).rejects.toThrow('OFFLINE_ASR_MEDIA')
      await writeFile(source, '')
      await expect(run()).rejects.toThrow('OFFLINE_ASR_MEDIA')
      await writeFile(source, 'local source')
      vi.mocked(speech.verifiedSpeechRuntime).mockRejectedValueOnce(new Error('runtime unavailable'))
      await expect(run()).rejects.toThrow('OFFLINE_ASR_UNAVAILABLE')
      expect(command).not.toHaveBeenCalled()
      expect(await readdir(project)).not.toContain('transcript')
    } finally {
      command.mockRestore()
    }
  })
})

it('preserves the source and reports a failed transcript directory creation before decoding', async () => {
  await withLocalSpeechFixture(async ({ project, source, runtime, signal }) => {
    const denied = Object.assign(new Error('offline output directory is not writable'), { code: 'EACCES' })
    const create = vi.mocked(mkdir).mockRejectedValueOnce(denied)
    const command = vi.spyOn(speech, 'command')
    try {
      await expect(transcribeOffline(project, project, source, config, runtime, signal)).rejects.toBe(denied)
      expect(create).toHaveBeenCalledWith(join(project, 'transcript'), { mode: 0o700 })
      expect(command).not.toHaveBeenCalled()
      expect(await readFile(source, 'utf8')).toBe('original media')
      expect(await readdir(project)).not.toContain('transcript')
    } finally {
      create.mockRestore()
      command.mockRestore()
    }
  })
})

it('refuses unprovisioned pronunciation data, unsupported readings and empty audio before decoding', async () => {
  await withLocalSpeechFixture(async ({ project, source, runtime, signal }) => {
    const request = { tokens: ['wo3', 'dai4', 'ding4'], target_index: 1, alternative: 'zai4',
      windows: [{ start: 2.2, end: 3.4 }, { start: 2, end: 3.5 }] }
    const command = vi.spyOn(speech, 'command')
    try {
      const open = (options: Parameters<typeof inspectPronunciation>[5] = runtime) =>
        inspectPronunciation(project, project, source, request, config, options, signal)
      await expect(open({ ...runtime, minimumMargin: 2 })).rejects.toThrow('OFFLINE_PRONUNCIATION_UNAVAILABLE')
      const vocabulary = join(runtime.modelDir, 'vocab_pinyin.json')
      await writeFile(vocabulary, '[]')
      await expect(open()).rejects.toThrow('Invalid pinned syllable vocabulary')
      await writeFile(vocabulary, '{"wo3":0,"dai4":1,"ding4":2}')
      await expect(open()).rejects.toThrow('Pinned model lacks zai4')
      await writeFile(source, '')
      await expect(open()).rejects.toThrow('OFFLINE_PRONUNCIATION_MEDIA')
      expect(command).not.toHaveBeenCalled()
    } finally {
      command.mockRestore()
    }
  })
})

it.each(['observed', 'no observation', 'malformed output', 'wrong result count', 'invalid observation', 'short capture',
  'source changed', 'pcm changed', 'model changed'] as const)(
  'handles %s on the pronunciation clock and deletes the temporary PCM', async (outcome) => {
    await withLocalSpeechFixture(async ({ project, source, runtime, signal }) => {
      const tokens = ['wo3', 'dai4', 'ding4']
      await writeFile(join(runtime.modelDir, 'vocab_pinyin.json'), '{"wo3":0,"dai4":1,"ding4":2,"zai4":3}')
      const windows = [{ start: 2.2, end: 3.4 }, { start: 2, end: 3.5 }]
      const captured: string[] = []
      const command = vi.spyOn(speech, 'command').mockImplementation(async (executable, args) => {
        if (executable === config.ffmpegPath) {
          const pcm = args.at(-1)
          if (pcm === undefined) throw new Error('Missing PCM fixture path')
          captured.push(pcm)
          const duration = Number(args[args.indexOf('-t') + 1])
          await writeFile(pcm, Buffer.alloc(outcome === 'short capture' ? 2 : Math.round(duration * 16_000) * 2))
          return ''
        }
        expect(executable).toBe(runtime.pythonPath)
        expect(args.slice(-2)).toEqual(captured)
        if (outcome === 'malformed output') return '{'
        if (outcome === 'wrong result count') return '[]'
        if (outcome === 'invalid observation') return JSON.stringify([{ anchor: 'zai4', frame: 1000, margin: 10 }, null])
        if (outcome === 'source changed') await writeFile(source, 'changed source')
        if (outcome === 'pcm changed') await writeFile(captured[0]!, 'changed capture')
        if (outcome === 'model changed') await writeFile(join(runtime.libraryDir, 'added.py'), 'changed dependencies')
        if (outcome === 'no observation') return '[null,null]'
        return JSON.stringify([{ anchor: 'zai4', frame: 13, margin: 10 }, { anchor: 'zai4', frame: 16, margin: 12 }])
      })
      try {
        const task = inspectPronunciation(project, project, source, { tokens, target_index: 1, alternative: 'zai4', windows },
          config, runtime, signal)
        if (outcome !== 'observed' && outcome !== 'no observation') {
          const expected = outcome === 'short capture' ? 'OFFLINE_PRONUNCIATION_MEDIA'
            : outcome.endsWith('changed') ? 'OFFLINE_PRONUNCIATION_CHANGED' : 'OFFLINE_PRONUNCIATION_INFERENCE'
          await expect(task).rejects.toThrow(expected)
          expect(captured.length).toBeGreaterThan(0)
          await expect(readdir(dirname(captured[0]!))).rejects.toMatchObject({ code: 'ENOENT' })
          return
        }
        const result = await task
        if (outcome === 'no observation') {
          expect(result.offline_pronunciation.status).toBe('uncertain')
          expect(result.offline_pronunciation.windows.map(window => window.observed)).toEqual([undefined, undefined])
        } else {
          expect(result.offline_pronunciation).toMatchObject({ source: { path: source, sha256: await speech.digest(source, signal) },
            status: 'suspected_mismatch', expected: 'dai4', alternative: 'zai4', listening_verified: false, windows: [
              { ...windows[0], observed: 'zai4', target_seconds: 2.993, pcm: { samples: 19_200, sampleRate: 16_000 } },
              { ...windows[1], observed: 'zai4', target_seconds: 2.973, pcm: { samples: 24_000, sampleRate: 16_000 } },
            ] })
        }
        expect(captured).toHaveLength(2)
        await expect(readdir(dirname(captured[0]!))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(source, 'utf8')).toBe('original media')
      } finally {
        command.mockRestore()
      }
    })
  })
