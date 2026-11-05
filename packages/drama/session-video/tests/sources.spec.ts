import { describe, expect, it } from 'vitest'
import { foldVideoSources, publicJubianVideo, type VideoSourceState } from '../src/sources.ts'
import { facts, shotRanges } from '../src/media.ts'
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
})
