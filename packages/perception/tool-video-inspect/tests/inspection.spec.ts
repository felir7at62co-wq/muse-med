/** Video inspection uses the real filesystem, attachment store and managed FFmpeg subprocesses. */
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import * as VideoInspect from '../src/index.ts'
import { runMedia, parseVideoMetadata } from '../src/media.ts'

const contexts: Context[] = [], roots: string[] = []
afterEach(async () => {
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
  const agent = (model: string) => ({ options: {}, session: { header: { cwd: root },
    requestHeader: () => ({ config: { provider: 'test', model } }), deriveMessages: () => [], append: () => undefined } })
  return { ctx, root, input, config, video,
    call: (args: Record<string, unknown>, model = 'vision') => ctx.tools.execute({ callId: ToolCallId(`video-${++count}`), name: 'video_inspect',
      arguments: { file_path: input, ...args }, signal: new AbortController().signal, agent: agent(model) as never }),
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
