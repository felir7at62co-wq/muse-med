/** Durable video coordinates retain only explicitly recorded, bounded source facts. */
import { expect, it } from 'vitest'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { foldVideoSources, publicJubianVideo, type VideoSourceState } from '../src/sources.ts'

const bounds = { maxSources: 10, maxResultBytes: 10_000 }
const empty = (): VideoSourceState => ({ sources: [], calls: [], complete: true, issues: [] })
const call = (name: string, args: unknown = {}) => foldVideoSources(empty(), {
  seq: 1, type: 'tool/call', data: { callId: 'original-call', name, arguments: args },
}, bounds)
const result = (state: VideoSourceState, content: unknown, meta?: unknown) => foldVideoSources(state, {
  seq: 2, type: 'tool/result', data: { meta, message: { toolCallId: 'original-call', content } },
}, bounds)

it.each([null, [], 1, 'unstructured event'])('ignores non-record durable event data: %j', (data) => {
  const previous = empty()
  expect(foldVideoSources(previous, { seq: 1, type: 'user/message', data }, bounds)).toBe(previous)
})

it.each(['x'.repeat(16_385), '\ud800', 'https://101.aigc.jubianai.net/a.mp4\n',
  'https://101.aigc.jubianai.net/a.mp4#private', 'not a URL', 'not-a-URL'])
('rejects an unsafe provider address: %j', (url) => { expect(publicJubianVideo(url)).toBe(false) })

it('keeps valid presented coordinates and Windows labels without inventing missing paths', () => {
  const previous = empty()
  const next = foldVideoSources(previous, { seq: 1, type: 'deliverables/presented', data: {
    files: [null, {}, { path: 1 }, { path: 'notes.txt' }, { path: 'C:\\clips\\场景.mp4' }],
  } }, bounds)
  expect(next.sources).toMatchObject([{ label: '场景.mp4', origin: 'presented', presentedIndex: 4 }])
  expect(previous).toEqual(empty())
})

it('ignores malformed attachments and remote chips while retaining explicit local video chips', () => {
  const next = foldVideoSources(empty(), { seq: 1, type: 'user/message', data: { content: [
    null, { type: 'file', attachment: {} },
    { type: 'file', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'notes.txt', bytes: 1 } },
    { type: 'text', text: 42 }, { type: 'text', text: '@https://101.aigc.jubianai.net/private.mp4 @"local clip.mov"' },
  ] } }, bounds)
  expect(next.sources).toMatchObject([{ origin: 'workspace', path: 'local clip.mov', label: 'local clip.mov' }])
})

it('retains one source-limit issue and one unsettled-call-limit issue without mutating prior states', () => {
  const limits = { ...bounds, maxSources: 1 }
  const full = foldVideoSources(empty(), { seq: 1, type: 'deliverables/presented', data: {
    files: [{ path: 'one.mp4' }, { path: 'two.mp4' }, { path: 'three.mp4' }],
  } }, limits)
  expect(full.sources).toHaveLength(1)
  expect(full).toMatchObject({ complete: false, issues: ['video source inventory limit reached'] })
  const pending = call('jubian_video')
  const extra = { seq: 2, type: 'tool/call', data: { callId: 'second-call', name: 'jubian_video', arguments: '{}' } }
  const rejected = foldVideoSources(pending, extra, limits)
  const repeated = foldVideoSources(rejected, { ...extra, seq: 3 }, limits)
  expect(repeated).toMatchObject({ complete: false, issues: ['unsettled video call limit reached'] })
  expect(repeated.calls).toEqual(pending.calls)
  expect(pending.complete).toBe(true)
})

it.each(['{', 'x'.repeat(10_001), null])('does not infer task identity from invalid recorded arguments: %j', (args) => {
  const state = call('jubian_video', args)
  expect(state.calls).toMatchObject([{ taskId: null, mediaKind: null }])
  expect(result(state, [{ type: 'text', text: JSON.stringify({ subtasks: { rows: [
    { parent_task_id: 7, status: 'completed', video_url: 'https://101.aigc.jubianai.net/other.mp4' },
  ] } }) }]).sources).toEqual([])
})

it.each([undefined, null, [], 'invalid message'])('does not settle a call without a recorded message identity: %j', (message) => {
  const state = call('ffmpeg_cut')
  expect(foldVideoSources(state, { seq: 2, type: 'tool/result', data: { message } }, bounds)).toBe(state)
})

it('does not attach a result to a different recorded call', () => {
  const state = call('ffmpeg_cut')
  expect(foldVideoSources(state, { seq: 2, type: 'tool/result', data: {
    message: { toolCallId: 'other-call', content: [] },
  } }, bounds)).toBe(state)
})

it.each([{ isError: true, content: [] }, { content: null }])('settles failed or unstructured results without adding sources: %j', (fields) => {
  const state = call('ffmpeg_cut')
  const next = foldVideoSources(state, { seq: 2, type: 'tool/result', data: { message: {
    toolCallId: 'original-call', ...fields,
  } } }, bounds)
  expect(next.calls).toEqual([])
  expect(next.sources).toEqual([])
  expect(state.calls).toHaveLength(1)
})

it.each(['result.mp4', '../result.mp4', 'not-video.txt', null])('accepts only a subscription-owned generated filename: %j', (fileName) => {
  const next = result(call('video_generate'), [], { fileName })
  expect(next.sources).toEqual(fileName === 'result.mp4' ? [expect.objectContaining({
    path: dshHomePath('plugins', 'subscriptions', 'videos', fileName), origin: 'generated', callId: 'original-call',
  })] : [])
})

it('reads supported local outputs and marks oversized structured results incomplete', () => {
  const media = result(call('jubian_media', { media_kind: 'video' }), [{ type: 'text', text: { path: 'original.mp4' } }])
  expect(media.sources).toMatchObject([{ path: 'original.mp4', origin: 'generated' }])
  const encoded = result(call('ffmpeg_encode'), [null, { type: 'image' }, { type: 'text', text: '{' },
    { type: 'text', text: 'x'.repeat(10_001) }, { type: 'text', text: JSON.stringify({ output: 'encoded.webm' }) }])
  expect(encoded).toMatchObject({ complete: false, issues: ['video tool result exceeds parsing limit'],
    sources: [{ path: 'encoded.webm', origin: 'workspace', callId: 'original-call' }] })
})

it('accepts successful provider source rows and strips query parameters from their labels', () => {
  const state = call('jubian_video', '{"task_id":7}')
  const next = result(state, [{ type: 'text', text: JSON.stringify({ sources: { sources: [
    null, {}, { video_url: 1, status: 'completed' }, { video_url: 'pending.mp4', status: 'pending' },
    { video_url: 'https://101.aigc.jubianai.net/one.mp4?token=value', status: 'SUCCEEDED' },
    { video_url: 'https://101.aigc.jubianai.net/two.mp4', status: 'success' },
  ] } }) }])
  expect(next.sources.map(source => [source.label, source.callId])).toEqual([
    ['one.mp4', 'original-call'], ['two.mp4', 'original-call'],
  ])
  expect(result(call('jubian_video'), [{ type: 'text', text: '{}' }]).sources).toEqual([])
})
