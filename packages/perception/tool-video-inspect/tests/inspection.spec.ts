/** Video inspection uses the real filesystem, attachment store and managed FFmpeg subprocesses. */
import { mkdtemp, rm, readFile, appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import * as VideoInspect from '../src/index.ts'
import { runMedia, parseVideoMetadata } from '../src/media.ts'
import * as Media from '../src/media.ts'

const contexts: Context[] = [], roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(options: Partial<VideoInspect.Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-video-inspect-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await()
  await ctx.plugin(LocalFileSystem, { cwd: root }).await()
  await ctx.plugin(LocalSubprocessRuntime).await()
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, '.state') }).await()
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) } as never)
  ctx.provide('llm', { resolveModelInfo: async (_provider: string, model: string) => ({ inputModalities: model === 'vision' ? ['text', 'image'] : ['text'] }) } as never)
  const config = VideoInspect.Config(options)
  const video = ctx.plugin(VideoInspect, config)
  await video.await()
  const ffmpeg = await ctx.subprocess.resolveExecutable(config.ffmpegPath)
  const input = join(root, 'red-blue.mp4')
  await runMedia(ctx, [ffmpeg, '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=64x48:rate=10:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:size=64x48:rate=10:d=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', input],
  { mode: 'danger-full-access', workspaceRoot: root }, undefined, { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  let count = 0
  const agent = (model: string, options: boolean) => ({ options: options ? { provider: 'test', model } : {}, session: { header: { cwd: root },
    requestHeader: () => options ? undefined : ({ config: { provider: 'test', model } }), deriveMessages: () => [], append: () => undefined } })
  return { ctx, root, input, config, video,
    call: (args: Record<string, unknown>, model = 'vision', route: 'header' | 'options' | 'none' = 'header') => ctx.tools.execute({ callId: ToolCallId(`video-${++count}`), name: 'video_inspect',
      arguments: { file_path: input, ...args }, signal: new AbortController().signal, ...route === 'none' ? {} : { agent: agent(model, route === 'options') as never } }),
  }
}

it('returns decoded source frames with original timestamps, durable image references and a verified manifest', async () => {
  const h = await setup()
  const result = await h.call({ start_seconds: 0, end_seconds: 4, timestamps_seconds: [0.5, 2.5], manifest_path: 'qa/inspection.json' })
  expect(result.isError).toBe(false)
  const images = result.content.filter(block => block.type === 'image')
  expect(images).toHaveLength(2)
  expect(images[0]!.attachment.attachmentId).not.toBe(images[1]!.attachment.attachmentId)
  for (const image of images) {
    expect(image.attachment).toMatchObject({ width: 64, height: 48 })
    const stored = await h.ctx.attachments.readImage(image.attachment)
    expect(stored.data.byteLength).toBe(image.attachment.bytes)
  }
  const manifest: unknown = JSON.parse(await readFile(join(h.root, 'qa/inspection.json'), 'utf8'))
  expect(manifest).toMatchObject({ duration_seconds: 4, has_audio: false, inspection: 'sampled_frames', verified_readback: true,
    frames: [{ requested_seconds: 0.5, timestamp_seconds: 0.5 }, { requested_seconds: 2.5, timestamp_seconds: 2.5 }] })
  expect(result.content.some(block => block.type === 'text' && block.text.includes('not continuous viewing'))).toBe(true)
  const repeated = await h.call({ timestamps_seconds: [1], end_seconds: 4, manifest_path: 'qa/inspection.json' })
  expect(repeated.isError).toBe(true)
  const retained = JSON.parse(await readFile(join(h.root, 'qa/inspection.json'), 'utf8')) as { frames: unknown[] }
  expect(retained.frames).toHaveLength(2)
}, 30_000)

it('rejects a text-only model before filesystem or media work while permitting metadata-only reads', async () => {
  const h = await setup()
  const resolve = vi.spyOn(h.ctx.fs, 'resolve')
  const call = await h.call({}, 'text')
  expect(call.isError).toBe(true)
  expect(resolve).not.toHaveBeenCalled()
  const metadata = await h.call({ method: 'metadata', manifest_path: 'qa/metadata.json' }, 'text')
  expect(metadata.isError).toBe(false)
  expect(metadata.content.every(block => block.type === 'text')).toBe(true)
}, 30_000)

it('refuses out-of-workspace manifest paths and detects source mutation before publication', async () => {
  const h = await setup()
  const outside = await h.call({ method: 'metadata', manifest_path: '../outside.json' })
  expect(outside.isError).toBe(true)
  const original = h.ctx.attachments.saveImage.bind(h.ctx.attachments)
  vi.spyOn(h.ctx.attachments, 'saveImage').mockImplementation(async (input) => {
    const ref = await original(input)
    await appendFile(h.input, 'changed')
    return ref
  })
  const changed = await h.call({ timestamps_seconds: [1], end_seconds: 4, manifest_path: 'qa/changed.json' })
  expect(changed.isError).toBe(true)
  expect(changed.content.some(block => block.type === 'text' && block.text.includes('changed'))).toBe(true)
}, 30_000)

it('refuses source limits before starting FFprobe', async () => {
  const h = await setup({ maxSourceBytes: 1 })
  const spawn = vi.spyOn(h.ctx.subprocess, 'spawn')
  expect((await h.call({ method: 'metadata' })).isError).toBe(true)
  expect(spawn).not.toHaveBeenCalled()
}, 30_000)

it('validates probe payloads instead of inferring dimensions or duration', () => {
  for (const raw of [{}, { format: { duration: 'bad' }, streams: [] }, { format: { duration: '4' }, streams: [{ codec_type: 'audio' }] }]) {
    expect(() => parseVideoMetadata(Buffer.from(JSON.stringify(raw)))).toThrow()
  }
})

it('refuses source image areas above the deployment limit before extracting frames', async () => {
  const h = await setup({ maxSourcePixels: 1 })
  const spawn = vi.spyOn(h.ctx.subprocess, 'spawn')
  const result = await h.call({ timestamps_seconds: [1], end_seconds: 4 })
  expect(result.isError).toBe(true)
  expect(result.content.some(block => block.type === 'text' && block.text.includes('dimensions exceed'))).toBe(true)
  expect(spawn).toHaveBeenCalledOnce()
}, 30_000)

it('bounds concurrent inspections and waits for owned cancellation when the plugin is removed', async () => {
  const h = await setup({ maxConcurrent: 1 })
  const entered = Promise.withResolvers<undefined>()
  vi.spyOn(h.ctx.llm, 'resolveModelInfo').mockImplementationOnce(async (_provider, _model, signal) => {
    if (!signal) throw new Error('inspection cancellation signal missing')
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new Error(String(reason)))
      }, { once: true })
      entered.resolve(undefined)
    })
  })
  const first = h.call({})
  await entered.promise
  const second = await h.call({ method: 'metadata' })
  expect(second.isError).toBe(true)
  expect(second.content.some(block => block.type === 'text' && block.text.includes('busy'))).toBe(true)
  await h.video.dispose()
  expect((await first).isError).toBe(true)
}, 30_000)

it('rejects an unresolved image route, while metadata remains callable without an agent', async () => {
  const h = await setup()
  const resolve = vi.spyOn(h.ctx.fs, 'resolve')
  const unresolved = await h.call({}, 'vision', 'none')
  expect(unresolved.isError).toBe(true)
  expect(resolve).not.toHaveBeenCalled()
  vi.spyOn(h.ctx.llm, 'resolveModelInfo').mockResolvedValueOnce({ provider: 'test', id: 'vision', name: 'vision' })
  expect((await h.call({})).isError).toBe(true)
  expect(resolve).not.toHaveBeenCalled()
  expect((await h.call({ method: 'metadata' }, 'vision', 'none')).isError).toBe(false)
}, 30_000)

it('uses agent options when no request route is materialized and marks the next uninspected interval', async () => {
  const h = await setup({ maxRangeSeconds: 1, defaultFrames: 1, maxFrames: 1 })
  const result = await h.call({ start_seconds: 1 }, 'vision', 'options')
  expect(result.isError).toBe(false)
  expect(result.value).toMatchObject({ interval: { start_seconds: 1, end_seconds: 2 }, next_start_seconds: 2 })
  expect(result.meta).toMatchObject({ frameCount: 1, interval: { start_seconds: 1, end_seconds: 2 } })
  const tool = h.ctx.tools.get('video_inspect')
  expect(tool?.isConcurrencySafe?.({ file_path: h.input })).toBe(true)
}, 30_000)

it('reports an actual audio stream with separate speech-transcription advice', async () => {
  const h = await setup()
  const ffmpeg = await h.ctx.subprocess.resolveExecutable(h.config.ffmpegPath)
  await runMedia(h.ctx, [ffmpeg, '-y', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=64x48:rate=10:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', h.input],
  { mode: 'danger-full-access', workspaceRoot: h.root }, undefined, { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  const result = await h.call({ method: 'metadata' })
  expect(result.value).toMatchObject({ has_audio: true })
  expect(result.content.some(block => block.type === 'text' && block.text.includes('Discover audio_transcribe'))).toBe(true)
}, 30_000)

it('rejects non-file and unknown-size sources before probing', async () => {
  const h = await setup()
  const spawn = vi.spyOn(h.ctx.subprocess, 'spawn')
  for (const file_path of [h.root, 'missing.mp4']) expect((await h.call({ method: 'metadata', file_path })).isError).toBe(true)
  const original = h.ctx.fs.stat.bind(h.ctx.fs)
  vi.spyOn(h.ctx.fs, 'stat').mockImplementationOnce(async (...args) => {
    const info = await original(...args)
    if (!info) throw new Error('fixture video stat unavailable')
    const { size: _size, ...unknownSize } = info
    return unknownSize
  })
  expect((await h.call({ method: 'metadata' })).isError).toBe(true)
  expect(spawn).not.toHaveBeenCalled()
}, 30_000)

it('refuses source duration beyond the configured maximum before decoding', async () => {
  const h = await setup({ maxDurationSeconds: 1 })
  const spawn = vi.spyOn(h.ctx.subprocess, 'spawn')
  const result = await h.call({})
  expect(result.content.some(block => block.type === 'text' && block.text.includes('duration exceeds'))).toBe(true)
  expect(spawn).toHaveBeenCalledOnce()
}, 30_000)

it.each(['missing-timestamp', 'negative-timestamp', 'past-end', 'invalid-number', 'missing-image'] as const)(
  'refuses %s extraction output without publishing a manifest', async (mode) => {
    const h = await setup()
    const original = Media.runMedia
    vi.spyOn(Media, 'runMedia').mockImplementation(async (...args) => {
      if (args[1][0] !== h.config.ffmpegPath && !args[1].includes('-frames:v')) return await original(...args)
      const diagnostic = { 'missing-timestamp': '', 'negative-timestamp': 'pts_time:-1', 'past-end': 'pts_time:4',
        'invalid-number': 'pts_time:1e999', 'missing-image': 'pts_time:1' }[mode]
      return { bytes: mode === 'missing-image' ? Buffer.alloc(0) : Buffer.from('unverified image'), diagnostic }
    })
    const result = await h.call({ timestamps_seconds: [1], end_seconds: 4, manifest_path: 'qa/refused.json' })
    expect(result.content.some(block => block.type === 'text' && block.text.includes('verifiable source timestamp'))).toBe(true)
    await expect(readFile(join(h.root, 'qa/refused.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

it('fails publication when manifest readback differs from the written inspection', async () => {
  const h = await setup()
  vi.spyOn(h.ctx.fs, 'readText').mockResolvedValueOnce('changed externally')
  const result = await h.call({ method: 'metadata', manifest_path: 'qa/readback.json' })
  expect(result.content.some(block => block.type === 'text' && block.text.includes('readback did not match'))).toBe(true)
  expect(JSON.parse(await readFile(join(h.root, 'qa/readback.json'), 'utf8'))).toMatchObject({ inspection: 'metadata' })
}, 30_000)

it('refuses a prepared inspection after its plugin has been unloaded', async () => {
  const h = await setup()
  const tool = h.ctx.tools.get('video_inspect')
  if (!tool) throw new Error('video tool unavailable')
  const args = { method: 'metadata', file_path: h.input }
  const prepared = await h.ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare({ callId: ToolCallId('prepared-video'),
    name: 'video_inspect', arguments: args, signal: new AbortController().signal })
  if (prepared.kind !== 'dispatch') throw new Error('video call was not prepared')
  await h.video.dispose()
  await expect(tool.execute(args, prepared.exec)).rejects.toThrow('unavailable')
}, 30_000)

it('rejects an inconsistent default sample count at plugin load', async () => {
  await expect(setup({ maxFrames: 1, defaultFrames: 2 })).rejects.toThrow('defaultFrames')
})


it('uses actual cut detection and ASR timing to sample a clip while persisting all deferred observations', async () => {
  const h = await setup({ maxFrames: 2, defaultFrames: 2, sceneThreshold: 0.01 })
  const transcript = join(h.root, 'transcript.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '红画面说话', speaker_id: 'job-a:0' },
    { start: 2, end: 3, text: '蓝画面说话', speaker_id: 'job-a:1' }]))
  const result = await h.call({ strategy: 'scene_dialogue', transcript_path: transcript, start_seconds: 0, end_seconds: 4, manifest_path: 'qa/adaptive.json' })
  expect(result.isError).toBe(false)
  const saved = JSON.parse(await readFile(join(h.root, 'qa/adaptive.json'), 'utf8')) as VideoInspect.VideoInspection
  expect(saved.frames).toHaveLength(2)
  expect(saved.sampling_plan?.selected.map(point => point.reasons)).toEqual([['before_scene_cut'], ['after_scene_cut']])
  expect(saved.sampling_plan?.deferred.map(point => point.time)).toEqual([0.5, 1, 2.5, 3])
  expect(saved.transcript_source?.path).toBe(transcript)
  expect(saved.frames[0]!.timestamp_seconds).toBeLessThan(2)
  expect(saved.frames[1]!.timestamp_seconds).toBeGreaterThanOrEqual(2)
  const followup = await h.call({ start_seconds: 0, end_seconds: 2, timestamps_seconds: [0.5, 1] })
  expect(followup.isError).toBe(false)
  expect(followup.content.filter(block => block.type === 'image')).toHaveLength(2)
}, 30_000)

it('rejects incompatible adaptive inputs, missing transcripts and source mutation during extraction', async () => {
  const h = await setup()
  for (const args of [{ method: 'metadata', strategy: 'scene_dialogue' }, { strategy: 'scene_dialogue', timestamps_seconds: [1] },
    { transcript_path: 'no-file.json' }, { strategy: 'scene_dialogue', transcript_path: 'no-file.json' }]) expect((await h.call(args)).isError).toBe(true)
  const transcript = join(h.root, 'transcript.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '台词' }]))
  const original = h.ctx.attachments.saveImage.bind(h.ctx.attachments)
  vi.spyOn(h.ctx.attachments, 'saveImage').mockImplementation(async (input) => {
    const image = await original(input)
    await appendFile(transcript, ' ')
    return image
  })
  const result = await h.call({ strategy: 'scene_dialogue', transcript_path: transcript, end_seconds: 4 })
  expect(result.isError).toBe(true)
  expect(result.content.some(block => block.type === 'text' && block.text.includes('Transcript changed'))).toBe(true)
}, 30_000)


it('samples actual later scene intervals without a transcript and rejects a transcript changed while it is read', async () => {
  const h = await setup()
  const later = await h.call({ strategy: 'scene_dialogue', start_seconds: 2, end_seconds: 4 })
  expect(later.isError).toBe(false)
  const images = later.content.filter(block => block.type === 'image')
  expect(images).toHaveLength(6)
  const transcript = join(h.root, 'read-race.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '台词' }]))
  const original = h.ctx.fs.readBytes.bind(h.ctx.fs)
  vi.spyOn(h.ctx.fs, 'readBytes').mockImplementation(async (target, signal, maxBytes) => {
    const result = await original(target, signal, maxBytes)
    await appendFile(transcript, ' ')
    return result
  })
  const raced = await h.call({ strategy: 'scene_dialogue', transcript_path: transcript, end_seconds: 4 })
  expect(raced.isError).toBe(true)
  expect(raced.content.some(block => block.type === 'text' && block.text.includes('Transcript changed during adaptive planning'))).toBe(true)
}, 30_000)

it('excludes a real cut at the requested interval end before detector metadata is emitted', async () => {
  const h = await setup({ maxFrames: 2, defaultFrames: 2, sceneThreshold: 0.01 })
  const result = await h.call({ strategy: 'scene_dialogue', start_seconds: 0, end_seconds: 2, manifest_path: 'qa/boundary.json' })
  expect(result.isError).toBe(false)
  const saved = JSON.parse(await readFile(join(h.root, 'qa/boundary.json'), 'utf8')) as VideoInspect.VideoInspection
  expect(saved.sampling_plan?.selected.map(point => point.reasons)).toEqual([['uniform_checkpoint'], ['uniform_checkpoint']])
  expect(saved.sampling_plan?.deferred).toEqual([])
  expect(saved.frames.every(frame => frame.timestamp_seconds < 2)).toBe(true)
}, 30_000)
