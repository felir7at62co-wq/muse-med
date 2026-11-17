import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { foldVideoSources, publicJubianVideo, type VideoSourceState } from '../src/sources.ts'
import { facts, shotRanges, command } from '../src/media.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionVideoSourceId } from '../src/types.ts'

const bounds = { maxSources: 10, maxResultBytes: 10000 }
const empty = (): VideoSourceState => ({ sources: [], calls: [], complete: true, issues: [] })

describe('recorded video inventory', () => {
  it('uses explicit user file coordinates and deliveries while ignoring assistant prose and unrelated file types', () => {
    const user = foldVideoSources(empty(), { seq: 1, type: 'user/message', data: { content: [
      { type: 'text', text: '@clip.mp4 @"folder/second clip.mov" @notes.txt' },
      { type: 'file', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'upload.webm', bytes: 20 } },
    ] } }, bounds)
    expect(user.sources.map(source => [source.origin, source.path, source.attachment?.name])).toEqual([
      ['workspace', 'clip.mp4', undefined], ['workspace', 'folder/second clip.mov', undefined], ['attachment', null, 'upload.webm'],
    ])
    const presented = foldVideoSources(user, { seq: 2, type: 'deliverables/presented', data: { files: [{ path: 'notes.txt' }, { path: 'result.mp4' }] } }, bounds)
    expect(presented.sources.at(-1)).toMatchObject({ origin: 'presented', eventSeq: 2, presentedIndex: 1, path: 'result.mp4' })
    expect(foldVideoSources(presented, { seq: 3, type: 'assistant/message', data: { content: [{ type: 'text', text: '@invented.mp4' }] } }, bounds)).toBe(presented)
    expect(user.sources).toHaveLength(3)
  })

  it('accepts only successful Jubian child results belonging to the recorded task', () => {
    const call = foldVideoSources(empty(), { seq: 1, type: 'tool/call', data: { callId: 'call', name: 'jubian_video', arguments: '{"method":"subtasks","task_id":7}' } }, bounds)
    const rows = [
      { parent_task_id: 7, status: 'completed', video_url: 'https://101.aigc.jubianai.net/good.mp4' },
      { parent_task_id: 8, status: 'completed', video_url: 'https://101.aigc.jubianai.net/other.mp4' },
      { parent_task_id: 7, status: 'pending', video_url: 'https://101.aigc.jubianai.net/pending.mp4' },
    ]
    const result = foldVideoSources(call, { seq: 2, type: 'tool/result', data: { message: { toolCallId: 'call', content: [{ type: 'text', text: JSON.stringify({ subtasks: { rows } }) }] } } }, bounds)
    expect(result.sources.map(source => source.remoteUrl)).toEqual(['https://101.aigc.jubianai.net/good.mp4'])
    expect(call.sources).toEqual([])
    expect(result.calls).toEqual([])
    expect(publicJubianVideo('https://101.aigc.jubianai.net/good.mp4')).toBe(true)
    for (const url of ['file:///tmp/private.mp4', 'http://127.0.0.1/private.mp4', 'https://101.aigc.jubianai.net.evil.test/a.mp4', 'https://user:pass@101.aigc.jubianai.net/a.mp4']) expect(publicJubianVideo(url)).toBe(false)
  })

  it('reports incomplete inventory instead of presenting a bounded prefix as complete', () => {
    const state = foldVideoSources(empty(), { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '@one.mp4 @two.mp4' }] } }, { ...bounds, maxSources: 1 })
    expect(state.sources).toHaveLength(1)
    expect(state.complete).toBe(false)
    expect(state.issues).toContain('video source inventory limit reached')
  })

  it('uses persisted subscription presentation metadata and bounds unsettled tool calls', () => {
    const call = foldVideoSources(empty(), { seq: 1, type: 'tool/call', data: {
      callId: 'subscription', name: 'video_generate', arguments: '{}' } }, bounds)
    const result = foldVideoSources(call, { seq: 2, type: 'tool/result', data: { meta: { fileName: 'generated.mp4' },
      message: { toolCallId: 'subscription', content: [] } } }, bounds)
    expect(result.sources).toMatchObject([{ origin: 'generated', callId: 'subscription', eventSeq: 2 }])
    expect(result.sources[0]?.path?.replaceAll('\\', '/')).toContain('/plugins/subscriptions/videos/generated.mp4')
    const invalid = foldVideoSources(call, { seq: 2, type: 'tool/result', data: { meta: { fileName: '../outside.mp4' },
      message: { toolCallId: 'subscription', content: [] } } }, bounds)
    expect(invalid.sources).toEqual([])
    const overflow = foldVideoSources(call, { seq: 3, type: 'tool/call', data: {
      callId: 'extra', name: 'video_generate', arguments: '{}' } }, { ...bounds, maxSources: 1 })
    expect(overflow.complete).toBe(false)
    expect(overflow.calls).toHaveLength(1)
    expect(call.complete).toBe(true)
    expect(call.sources).toEqual([])
  })


  it('ignores malformed durable events and preserves the previous inventory', () => {
    const previous = empty()
    for (const data of [null, [], 7, 'text']) {
      expect(foldVideoSources(previous, { seq: 1, type: 'user/message', data }, bounds)).toBe(previous)
    }
    for (const event of [
      { type: 'deliverables/presented', data: { files: [null, {}, { path: 42 }] } },
      { type: 'user/message', data: { content: [null, { type: 'image' }, { type: 'file', attachment: {} },
        { type: 'text', text: '@https://example.test/unrecorded.mp4 @bad\0.mp4' }] } },
      { type: 'tool/result', data: { message: { toolCallId: 'unrecorded', content: [] } } },
    ]) expect(foldVideoSources(previous, { seq: 1, ...event }, bounds)).toBe(previous)
  })

  it('keeps Windows filenames and one inventory-limit diagnostic when several sources overflow', () => {
    const result = foldVideoSources(empty(), { seq: 1, type: 'deliverables/presented', data: {
      files: [{ path: 'C:\\video\\first.MP4' }, { path: 'second.mp4' }, { path: 'third.mp4' }],
    } }, { ...bounds, maxSources: 1 })
    expect(result.sources).toMatchObject([{ label: 'first.MP4', path: 'C:\\video\\first.MP4', presentedIndex: 0 }])
    expect(result.issues).toEqual(['video source inventory limit reached'])
    expect(result.complete).toBe(false)
  })

  it('labels each source from its recorded coordinate and omits provider URL queries', () => {
    const user = foldVideoSources(empty(), { seq: 1, type: 'user/message', data: { content: [
      { type: 'text', text: '@"shots/local take.mp4"' },
      { type: 'file', attachment: { attachmentId: `sha256:${'b'.repeat(64)}`, name: '上传.webm', bytes: 20 } },
    ] } }, bounds)
    const call = foldVideoSources(user, { seq: 2, type: 'tool/call', data: {
      callId: 'sources', name: 'jubian_video', arguments: {} } }, bounds)
    const result = foldVideoSources(call, { seq: 3, type: 'tool/result', data: { message: {
      toolCallId: 'sources', content: [{ type: 'text', text: JSON.stringify({ sources: { sources: [{
        status: 'succeeded', video_url: 'https://101.aigc.jubianai.net/remote.mp4?download=1',
      }] } }) }],
    } } }, bounds)
    expect(result.sources.map(source => source.label)).toEqual(['local take.mp4', '上传.webm', 'remote.mp4'])
    expect(result.sources[2]?.remoteUrl).toBe('https://101.aigc.jubianai.net/remote.mp4?download=1')
  })

  it('settles failed video calls without accepting their apparent successful output', () => {
    const call = foldVideoSources(empty(), { seq: 1, type: 'tool/call', data: {
      callId: 'cut', name: 'ffmpeg_cut', arguments: {} } }, bounds)
    for (const message of [
      { toolCallId: 'cut', isError: true, content: [{ type: 'text', text: '{"output":"failed.mp4"}' }] },
      { toolCallId: 'cut', content: null },
    ]) {
      const result = foldVideoSources(call, { seq: 2, type: 'tool/result', data: { message } }, bounds)
      expect(result.calls).toEqual([])
      expect(result.sources).toEqual([])
      expect(call.calls).toHaveLength(1)
    }
  })

  it('records supported local generated and edited videos from their own tool results', () => {
    for (const [name, args, output, origin] of [
      ['jubian_media', { media_kind: 'video' }, { path: 'downloaded.mp4' }, 'generated'],
      ['ffmpeg_concat', {}, { output: 'joined.mov' }, 'workspace'],
    ] as const) {
      const call = foldVideoSources(empty(), { seq: 1, type: 'tool/call', data: {
        callId: name, name, arguments: args } }, bounds)
      const result = foldVideoSources(call, { seq: 2, type: 'tool/result', data: { message: {
        toolCallId: name, content: [{ type: 'text', text: output }],
      } } }, bounds)
      expect(result.sources).toMatchObject([{ origin, callId: name, eventSeq: 2, remoteUrl: null }])
      expect(result.calls).toEqual([])
    }
  })

  it('ignores malformed result blocks and reports overlarge tool output without losing a later valid source', () => {
    const call = foldVideoSources(empty(), { seq: 1, type: 'tool/call', data: {
      callId: 'cut', name: 'ffmpeg_cut', arguments: '{bad json' } }, bounds)
    const result = foldVideoSources(call, { seq: 2, type: 'tool/result', data: { message: { toolCallId: 'cut', content: [
      null, { type: 'image' }, { type: 'text', text: '{bad json' }, { type: 'text', text: 'x'.repeat(101) },
      { type: 'text', text: '{"output":"retained.mp4"}' },
    ] } } }, { ...bounds, maxResultBytes: 100 })
    expect(result.sources).toMatchObject([{ path: 'retained.mp4' }])
    expect(result.complete).toBe(false)
    expect(result.issues).toEqual(['video tool result exceeds parsing limit'])
    expect(result.calls).toEqual([])
  })

  it('does not parse overlarge call arguments or multiply unsettled-call diagnostics', () => {
    const call = foldVideoSources(empty(), { seq: 1, type: 'tool/call', data: {
      callId: 'large', name: 'jubian_video', arguments: ' '.repeat(bounds.maxResultBytes + 1) } }, bounds)
    expect(call.calls).toMatchObject([{ id: 'large', taskId: null, mediaKind: null }])
    const event = { seq: 2, type: 'tool/call', data: { callId: 'extra', name: 'jubian_video', arguments: '{}' } }
    const overflow = foldVideoSources(call, event, { ...bounds, maxSources: 1 })
    const again = foldVideoSources(overflow, event, { ...bounds, maxSources: 1 })
    expect(again.calls).toEqual(call.calls)
    expect(again.complete).toBe(false)
    expect(again.issues).toEqual(['unsettled video call limit reached'])
  })

  it('accepts source-list results and ignores invalid or unbound Jubian child rows', () => {
    const call = foldVideoSources(empty(), { seq: 1, type: 'tool/call', data: {
      callId: 'sources', name: 'jubian_video', arguments: '{}' } }, bounds)
    const settle = (value: unknown) => foldVideoSources(call, { seq: 2, type: 'tool/result', data: { message: {
      toolCallId: 'sources', content: [{ type: 'text', text: JSON.stringify(value) }],
    } } }, bounds)
    const row = { status: 'SUCCESS', video_url: 'https://101.aigc.jubianai.net/source.mp4' }
    expect(settle({ sources: { sources: [null, {}, { video_url: 42, status: 'success' }, row] } }).sources)
      .toMatchObject([{ remoteUrl: row.video_url, label: 'source.mp4' }])
    expect(settle({ subtasks: { rows: [{ ...row, parent_task_id: 7 }] } }).sources).toEqual([])
    expect(settle({}).sources).toEqual([])
  })

  it('rejects malformed, oversized and fragment-bearing provider media addresses', () => {
    for (const url of ['https://[', 'not a url', 'https://101.aigc.jubianai.net/a.mp4#fragment',
      'https://101.aigc.jubianai.net/a mp4', 'https://101.aigc.jubianai.net/\ud800.mp4', 'x'.repeat(16385)]) {
      expect(publicJubianVideo(url)).toBe(false)
    }
  })
})

describe('complete cut ranges', () => {
  const id = brandString<SessionVideoSourceId>('fixture')
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
  it('covers the full video in source order with stable version-bound ids', () => {
    const result = shotRanges(bytes('frame:1 pts:10 pts_time:1\nframe:2 pts:20 pts_time:2\n'), 3, id, 'v1', 0.08, 10)
    expect(result.map(shot => [shot.index, shot.startSeconds, shot.endSeconds])).toEqual([[1, 0, 1], [2, 1, 2], [3, 2, 3]])
    expect(shotRanges(bytes('pts_time:1\npts_time:2\n'), 3, id, 'v1', 0.08, 10)).toEqual(result)
    expect(shotRanges(bytes('pts_time:1\npts_time:2\n'), 3, id, 'v2', 0.08, 10)[0]?.id).not.toBe(result[0]?.id)
  })
  it('keeps a continuous video as one shot and refuses malformed or overflowing detections', () => {
    expect(shotRanges(bytes(''), 3, id, 'v1', 0.08, 10)).toMatchObject([{ startSeconds: 0, endSeconds: 3 }])
    expect(() => shotRanges(bytes('pts_time:NaN'), 3, id, 'v1', 0.08, 10)).toThrow('invalid source timestamp')
    expect(() => shotRanges(bytes('pts_time:1\npts_time:2'), 3, id, 'v1', 0.08, 2)).toThrow('configured limit')
    expect(() => facts(bytes('{"format":{"duration":"NaN"},"streams":[]}'))).toThrow('valid video')
  })


  it('merges near-end, near-start and duplicate scene markers into complete nonempty shots', () => {
    const result = shotRanges(bytes('pts_time:2.99\npts_time:0.01\npts_time:1\npts_time:1\npts_time:1.01'), 3, id, 'v1', 0.08, 10)
    expect(result.map(shot => [shot.startSeconds, shot.endSeconds])).toEqual([[0, 1], [1, 3]])
    for (const marker of ['-1', '3', 'Infinity']) {
      expect(() => shotRanges(bytes(`pts_time:${marker}`), 3, id, 'v1', 0.08, 10)).toThrow('invalid source timestamp')
    }
  })

  it('requires a positive duration and complete integer dimensions from an actual video track', () => {
    expect(facts(bytes(JSON.stringify({ format: { duration: '3.25' }, streams: [
      { codec_type: 'audio' }, { codec_type: 'video', width: 640, height: 360 },
    ] })))).toEqual({ durationSeconds: 3.25, width: 640, height: 360 })
    for (const value of [null, {}, { format: { duration: 0 }, streams: [] },
      { format: { duration: 1 }, streams: [{ codec_type: 'video', width: 0, height: 20 }] },
      { format: { duration: 1 }, streams: [{ codec_type: 'video', width: 20, height: 1.5 }] },
      { format: { duration: 1 }, streams: [{ codec_type: 'video', width: 20, height: 0 }] }]) {
      expect(() => facts(bytes(JSON.stringify(value)))).toThrow('valid video')
    }
    expect(() => facts(new Uint8Array([0xff]))).toThrow()
    expect(() => facts(bytes('{invalid JSON'))).toThrow()
  })
})

describe('owned video command output', () => {
  const limits = { commandTimeoutMs: 10000, graceMs: 1000, maxOutputBytes: 4 }
  const policy = { mode: 'danger-full-access', workspaceRoot: process.cwd() } as const

  it('retains complete binary output exactly at the byte limit and waits for the real process', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(Subprocess).await()
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      const bytes = await command(ctx, [process.execPath, '-e', 'process.stdout.write(Buffer.from([0,1,254,255]))'],
        policy, new AbortController().signal, limits)
      expect([...bytes]).toEqual([0, 1, 254, 255])
      const child = spawn.mock.results[0]
      if (child?.type !== 'return') throw Error('Expected real video subprocess')
      expect(await child.value.done).toMatchObject({ exitCode: 0 })
      await child.value.waitForExit()
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses complete output above its byte limit and joins the process before rejecting', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(Subprocess).await()
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      await expect(command(ctx, [process.execPath, '-e', 'process.stdout.write("12345")'],
        policy, new AbortController().signal, limits)).rejects.toThrow('Video detection output exceeds its limit')
      const child = spawn.mock.results[0]
      if (child?.type !== 'return') throw Error('Expected real video subprocess')
      await child.value.waitForExit()
      expect(await child.value.done).toHaveProperty('exitCode')
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves the actual failed exit and stderr while refusing its apparent output', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(Subprocess).await()
      await expect(command(ctx, [process.execPath, '-e', 'process.stdout.write("ok");process.stderr.write("bad");process.exitCode=7'],
        policy, new AbortController().signal, limits)).rejects.toThrow('Video process failed (7): bad')
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses confined execution when no sandbox provider is installed', async () => {
    const ctx = new Context()
    try {
      await expect(command(ctx, [process.execPath, '-e', ''], { ...policy, mode: 'read-only' },
        new AbortController().signal, limits)).rejects.toBeInstanceOf(SandboxUnavailableError)
    } finally { await ctx.fiber.dispose() }
  })

  it('propagates a real executable launch failure after its owned process settles', async () => {
    const ctx = new Context(), root = await mkdtemp(join(tmpdir(), 'video-command-'))
    try {
      await ctx.plugin(Subprocess).await()
      await expect(command(ctx, [join(root, 'missing-analyzer')], { ...policy, workspaceRoot: root },
        new AbortController().signal, limits)).rejects.toThrow(/ENOENT|not found|cannot find/iu)
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })
})
