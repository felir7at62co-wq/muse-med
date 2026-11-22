/** Packed speech tracks reuse the receipt decoding and a plain PCM WAV layout. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { extractSpeechPcm, readPublishedSegments, SPEECH_SAMPLE_RATE, speechWavHeader } from '../src/runner-api.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const ffmpeg = process.env.DSH_FFMPEG_PATH ?? 'ffmpeg'
const hasFfmpeg = (() => { try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()

it('writes a 16 kHz mono 16-bit RIFF header for the given payload', () => {
  const header = speechWavHeader(32_000)
  expect(header.length).toBe(44)
  expect(header.toString('ascii', 0, 4)).toBe('RIFF')
  expect(header.readUInt32LE(4)).toBe(36 + 32_000)
  expect([header.readUInt16LE(22), header.readUInt32LE(24), header.readUInt16LE(34)]).toEqual([1, SPEECH_SAMPLE_RATE, 16])
  expect(header.readUInt32LE(40)).toBe(32_000)
  expect(() => speechWavHeader(3)).toThrow('Invalid speech PCM length')
})

it.runIf(hasFfmpeg)('decodes a media track to raw PCM samples at the staging rate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-speech-pcm-'))
  directories.push(root)
  const source = join(root, 'tone.wav'), target = join(root, 'tone.pcm')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5', source])
  await extractSpeechPcm(source, target, { ffmpegPath: ffmpeg, ffprobePath: 'ffprobe', commandTimeoutMs: 30_000,
    maxDurationSeconds: 60, maxAudioBytes: 1_000_000 })
  expect((await stat(target)).size).toBe(SPEECH_SAMPLE_RATE * 2 / 2)
})

it('reads published segments and rejects anything else', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-speech-json-'))
  directories.push(root)
  const file = join(root, 'out.json')
  const rows = [{ start: 0, end: 1, text: '你好', speaker_id: 's1', words: [{ start: 0, end: 0.5, text: '你' }] }]
  await writeFile(file, JSON.stringify(rows))
  await expect(readPublishedSegments(file)).resolves.toEqual(rows)
  for (const bad of [[], {}, [{ start: 0, end: 1 }], [{ start: 0, end: 1, text: 'x', words: 'none' }]]) {
    await writeFile(file, JSON.stringify(bad))
    await expect(readPublishedSegments(file)).rejects.toThrow('not a list of timed segments')
  }
  expect(await readFile(file, 'utf8')).toContain('none')
})
