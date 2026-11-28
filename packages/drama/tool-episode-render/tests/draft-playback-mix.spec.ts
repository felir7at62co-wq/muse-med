import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { prepareRenderedDraftMix, verifyRenderedDraftMix } from '../src/draft-playback-mix.ts'
import { stubChannel, type StubHandler } from './harness.ts'

const pcmSha = 'a'.repeat(64)
const audioStream = {
  codec_name: 'aac', sample_rate: '48000', channels: 2, time_base: '1/48000', start_pts: 0, duration_ts: 48_000,
}

async function fixture(before?: (source: string, target: string) => StubHandler) {
  const root = await mkdtemp(join(tmpdir(), 'muse-draft-playback-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source.mp4')
  const target = join(root, 'mix.wav')
  await writeFile(source, 'rendered media fixture')
  const expectedSha = await fileSha256(source)
  const probe = (stream: object) => ({ stdout: JSON.stringify({ streams: [stream] }) })
  const { channel, calls } = stubChannel([
    ...(before === undefined ? [] : [before(source, target)]),
    ({ command, args }) => command === 'ffprobe'
      ? probe(args.at(-1) === source ? audioStream : { ...audioStream, codec_name: 'pcm_s16le', start_pts: undefined })
      : undefined,
    ({ args }) => args.at(-1) === target
      ? { after: async () => { await writeFile(target, 'retained playable fixture') } }
      : { stdout: `SHA256=${pcmSha}\n` },
  ])
  const toolkit = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel }
  return { root, source, target, expectedSha, toolkit, calls }
}

it.each([
  { label: 'failed probe', outcome: { code: 1 }, error: '无法核对剪映播放混音的声道和样本时间' },
  { label: 'missing stream fields', outcome: { stdout: '{}' }, error: '起点为零且可测量的单条' },
  { label: 'unbounded sample count', outcome: { stdout: JSON.stringify({ streams: [{ ...audioStream, duration_ts: 0 }] }) },
    error: '起点为零且可测量的单条' },
])('rejects $label before retaining draft audio', async ({ outcome, error }) => {
  const f = await fixture(() => ({ command }) => command === 'ffprobe' ? outcome : undefined)
  await expect(prepareRenderedDraftMix(f.toolkit, f.source, f.expectedSha, f.target)).rejects.toThrow(error)
  expect(f.calls.every(call => call.command === 'ffprobe')).toBe(true)
  await expect(readFile(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects directory inputs and unverifiable decoded PCM', async () => {
  const f = await fixture(() => ({ command, args }) => command === 'ffmpeg' && args.includes('hash')
    ? { code: 1, stdout: `SHA256=${pcmSha}` } : undefined)
  const directory = join(f.root, 'directory')
  await mkdir(directory)
  await expect(prepareRenderedDraftMix(f.toolkit, directory, f.expectedSha, f.target)).rejects.toThrow('真实的本地音视频文件')
  await expect(prepareRenderedDraftMix(f.toolkit, f.source, '0'.repeat(64), f.target)).rejects.toThrow('成片已变化')
  await expect(prepareRenderedDraftMix(f.toolkit, f.source, f.expectedSha, f.target)).rejects.toThrow('无法核对剪映播放混音的实际 PCM')
  expect(await fileSha256(f.source)).toBe(f.expectedSha)
})

it('refuses a render changed while it extracts the draft playback track', async () => {
  const f = await fixture((source, target) => ({ command, args }) => command === 'ffmpeg' && args.at(-1) === target
    ? { after: async () => { await writeFile(target, 'staged track'); await writeFile(source, 'replacement render') } }
    : undefined)
  await expect(prepareRenderedDraftMix(f.toolkit, f.source, f.expectedSha, f.target)).rejects.toThrow('成片或音轨时钟发生变化')
})

it('rechecks retained WAV bytes after probing both audio streams', async () => {
  let rechecking = false
  const f = await fixture((_source, target) => ({ command, args }) => rechecking && command === 'ffmpeg' && args.includes('hash')
    && args.includes(target)
    ? { stdout: `SHA256=${pcmSha}`, after: async () => { await writeFile(target, 'different track') } }
    : undefined)
  const mix = await prepareRenderedDraftMix(f.toolkit, f.source, f.expectedSha, f.target)
  await expect(verifyRenderedDraftMix(f.toolkit, f.source, mix)).resolves.toBeUndefined()
  await expect(verifyRenderedDraftMix(f.toolkit, f.source, { ...mix, duration_us: 1 })).rejects.toThrow('文件或样本数不一致')
  rechecking = true
  await expect(verifyRenderedDraftMix(f.toolkit, f.source, mix)).rejects.toThrow('实际解码的 PCM 不一致')
})
