/** Pure issuance folds prove restoration and reject unrelated, failed or unbound tool output. */
import { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import Sessions, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import { installSourceQaState, sourceQaStateOf, sourceQaOwnsReview } from '../src/source-qa-state.ts'
import { VideoReviewId } from '../src/review-state.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  const readSourceQa = await installSourceQaState(ctx)
  const session = ctx.sessions.create(SessionId('source-qa-projection'))
  let counter = 0
  const result = (name: string, value: Record<string, JsonValue>, isError = false) => {
    const id = ToolCallId(`call-${++counter}`)
    session.append('tool/call', { turn: 1, step: 1, callId: id, name, arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, meta: { [TOOL_BODY_META_KEY]: value }, message: createToolResultMessage({ callId: id,
      content: [{ type: 'text', text: JSON.stringify(value) }], isError }) }, { surfaceOp: 'append' })
  }
  return { ctx, readSourceQa, session, result }
}

it('restores compact successful native OCR and observation issuance from the same Session', async () => {
  const h = await fixture(), sha = 'a'.repeat(64)
  h.result('video_ocr', { path: 'video.mp4', source_version: 'v1', raw_json_path: 'ocr.json', raw_json_sha256: sha })
  h.result('video_inspect', { complete: true, path: 'video.mp4', source_version: 'v1', review_id: 'review-1',
    observation_report: 'review.json', observation_report_sha256: sha, observation_session_id: h.session.id })
  const expected = sourceQaStateOf(h.readSourceQa, h.session)
  expect(expected.ocr['ocr.json']).toEqual({ path: 'video.mp4', source_version: 'v1', sha256: sha })
  expect(expected.reviews['review.json']).toMatchObject({ review_id: 'review-1', session_id: h.session.id, sha256: sha })
  expect(expected.native).toEqual({})
  const restored = Session.create(h.session.id, h.session.snapshotEvents(), h.session.header)
  expect(sourceQaStateOf(h.readSourceQa, restored)).toEqual(expected)
})

it('owns only the exact source review started by this Session and retains ownership after progress updates', async () => {
  const h = await fixture(), id = VideoReviewId('owned-source-review'), path = 'source.mp4'
  expect(sourceQaOwnsReview(h.readSourceQa, h.session, id, path)).toBe(false)
  h.session.append('video/review', { kind: 'start', review: { id, path, episode: 'episode-1', source_version: 'v1',
    duration: 1, scanned_until: 0, scan_complete: false, frames: [] } })
  expect(sourceQaOwnsReview(h.readSourceQa, h.session, id, path)).toBe(true)
  expect(sourceQaOwnsReview(h.readSourceQa, h.session, 'another-review', path)).toBe(false)
  expect(sourceQaOwnsReview(h.readSourceQa, h.session, id, 'other.mp4')).toBe(false)
  h.session.append('video/review', { kind: 'update', path, id, frames: [], frame_count: 0,
    scanned_until: 1, scan_complete: true })
  expect(sourceQaOwnsReview(h.readSourceQa, h.session, id, path)).toBe(true)
  const restored = Session.create(h.session.id, h.session.snapshotEvents(), h.session.header)
  expect(sourceQaOwnsReview(h.readSourceQa, restored, id, path)).toBe(true)
})

it('ignores errors, other tool names, incomplete reviews and old OCR without the complete artifact hash', async () => {
  const h = await fixture(), value = { path: 'v.mp4', source_version: 'v1', raw_json_path: 'ocr.json', raw_json_sha256: 'b'.repeat(64) }
  h.result('run_command', value)
  h.result('video_ocr', value, true)
  const { raw_json_sha256: _hash, ...legacy } = value
  h.result('video_ocr', legacy)
  h.result('video_inspect', { complete: false, path: 'v.mp4', observation_report: 'review.json' })
  expect(sourceQaStateOf(h.readSourceQa, h.session)).toEqual({ native: {}, nested: {}, ocr: {}, reviews: {} })
})

it('accepts a successful PTC sub-dispatch only with its matching actual start', async () => {
  const h = await fixture(), sha = 'c'.repeat(64), data = { rootCallId: ToolCallId('root'), parentCallId: ToolCallId('root'),
    subCallId: ToolCallId('sub'), name: 'video_ocr', arguments: {} }
  const value = { path: 'v.mp4', source_version: 'v1', raw_json_path: 'ocr.json', raw_json_sha256: sha }
  const content = [{ type: 'text' as const, text: JSON.stringify(value) }]
  const meta = { [TOOL_BODY_META_KEY]: value }
  h.session.append('tool/ptc-dispatch', { ...data, isError: false, content, meta })
  expect(sourceQaStateOf(h.readSourceQa, h.session).ocr).toEqual({})
  h.session.append('tool/ptc-dispatch-start', data)
  h.session.append('tool/ptc-dispatch', { ...data, isError: false, content, meta })
  expect(sourceQaStateOf(h.readSourceQa, h.session).ocr['ocr.json']?.sha256).toBe(sha)
  expect(sourceQaStateOf(h.readSourceQa, h.session).nested).toEqual({})
})

it('retains camel-case native presentation metadata from the complete source-review tool', async () => {
  const h = await fixture(), sha = 'd'.repeat(64)
  h.result('video_source_review', { complete: true, videoReviewEvidence: { path: 'v.mp4', sourceVersion: 'v2',
    reviewId: 'review-2', sessionId: h.session.id, observationReport: 'report.json', sha256: sha } })
  expect(sourceQaStateOf(h.readSourceQa, h.session).reviews['report.json']).toMatchObject({ path: 'v.mp4',
    source_version: 'v2', review_id: 'review-2', sha256: sha })
  h.result('video_ocr', { path: 'v.mp4', sourceVersion: 'v2', rawJsonPath: 'camel-ocr.json', rawJsonSha256: sha })
  expect(sourceQaStateOf(h.readSourceQa, h.session).ocr['camel-ocr.json']).toEqual({ path: 'v.mp4', source_version: 'v2', sha256: sha })
  h.result('video_inspect', { complete: true, path: 'v.mp4', observation_report: 'missing-hash.json' })
  expect(sourceQaStateOf(h.readSourceQa, h.session).reviews).not.toHaveProperty('missing-hash.json')
})

it('retains successful OCR issuance from durable result metadata without reparsing display text', async () => {
  const h = await fixture(), id = ToolCallId('metadata-ocr'), sha = 'e'.repeat(64)
  h.session.append('tool/call', { turn: 1, step: 1, callId: id, name: 'video_ocr', arguments: '{}' })
  h.session.append('tool/result', { turn: 1, step: 1,
    meta: { [TOOL_BODY_META_KEY]: { path: 'source.mp4', source_version: 'original', raw_json_path: 'issued.json', raw_json_sha256: sha } },
    message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: 'OCR scan complete' }], isError: false }),
  }, { surfaceOp: 'append' })
  expect(sourceQaStateOf(h.readSourceQa, h.session).ocr).toEqual({
    'issued.json': { path: 'source.mp4', source_version: 'original', sha256: sha },
  })
})

it('ignores malformed JSON, non-object text and image blocks without inventing issuance', async () => {
  const h = await fixture(), id = ToolCallId('malformed-output')
  h.session.append('tool/call', { turn: 1, step: 1, callId: id, name: 'video_ocr', arguments: '{}' })
  h.session.append('tool/result', { turn: 1, step: 1, meta: 'not-metadata', message: createToolResultMessage({ callId: id,
    content: [{ type: 'text', text: '{broken' }, { type: 'text', text: '[1]' },
      { type: 'image', attachment: { attachmentId: AttachmentId('fixture-image'), mediaType: 'image/png',
        bytes: 1, width: 1, height: 1 } }], isError: false }) }, { surfaceOp: 'append' })
  expect(sourceQaStateOf(h.readSourceQa, h.session)).toEqual({ native: {}, nested: {}, ocr: {}, reviews: {} })
})

it('does not attribute failed or mismatched nested results to another pending tool', async () => {
  const h = await fixture(), data = { rootCallId: ToolCallId('root-2'), parentCallId: ToolCallId('root-2'),
    subCallId: ToolCallId('nested-error'), name: 'video_ocr', arguments: {} }
  h.session.append('tool/ptc-dispatch-start', { ...data, name: 'unrelated' })
  h.session.append('tool/ptc-dispatch-start', data)
  h.session.append('tool/ptc-dispatch', { ...data, isError: true, content: [] })
  h.session.append('tool/ptc-dispatch-start', data)
  h.session.append('tool/ptc-dispatch', { ...data, name: 'video_inspect', isError: false, content: [] })
  expect(sourceQaStateOf(h.readSourceQa, h.session)).toEqual({ native: {}, nested: {}, ocr: {}, reviews: {} })
})

it('requires the projection service before preparing the issuance reader', async () => {
  const h = await fixture(), empty = new Context()
  onTestFinished(() => empty.fiber.dispose())
  await expect(installSourceQaState(empty)).rejects.toThrow('sessionProjections')
  await empty.plugin(Projections)
  const readSourceQa = await installSourceQaState(empty)
  expect(sourceQaStateOf(readSourceQa, h.session)).toEqual({ native: {}, nested: {}, ocr: {}, reviews: {} })
})

it('excludes inherited OCR results but accepts this fork’s own committed tool calls', async () => {
  const h = await fixture(), hash = 'f'.repeat(64)
  h.result('video_ocr', { path: 'v.mp4', source_version: 'v1', raw_json_path: 'parent.json', raw_json_sha256: hash })
  const child = h.ctx.sessions.fork(h.session, undefined, SessionId('source-qa-child'))
  expect(sourceQaStateOf(h.readSourceQa, child).ocr).toEqual({})
  const id = ToolCallId('child-ocr')
  child.append('tool/call', { turn: 1, step: 1, callId: id, name: 'video_ocr', arguments: '{}' })
  child.append('tool/result', { turn: 1, step: 1,
    meta: { [TOOL_BODY_META_KEY]: { path: 'v.mp4', source_version: 'v1', raw_json_path: 'child.json', raw_json_sha256: hash } },
    message: createToolResultMessage({ callId: id,
      content: [{ type: 'text', text: 'recorded' }],
      isError: false }) }, { surfaceOp: 'append' })
  expect(sourceQaStateOf(h.readSourceQa, child).ocr).toEqual({ 'child.json': { path: 'v.mp4', source_version: 'v1', sha256: hash } })
  expect(sourceQaStateOf(h.readSourceQa, h.session).ocr).toHaveProperty('parent.json')
  const restored = Session.create(child.id, child.snapshotEvents(), child.header, child.inheritedEventCount)
  expect(sourceQaStateOf(h.readSourceQa, restored)).toEqual(sourceQaStateOf(h.readSourceQa, child))
  const events = child.snapshotEvents()
  const checkpoint = h.ctx.sessionProjections.restore({}, events, SessionLogOffset(0), child.header, child.inheritedEventCount).checkpoint
  expect(checkpoint.videoSourceQa?.ver).toBe(3)
  const resumed = h.ctx.sessionProjections.restore(checkpoint, [], SessionLogOffset(child.seq), child.header, child.inheritedEventCount)
  expect(resumed.checkpoint.videoSourceQa?.val).toEqual(checkpoint.videoSourceQa?.val)
  const old = { ...checkpoint, videoSourceQa: { ...checkpoint.videoSourceQa!, ver: 2 } }
  expect(() => h.ctx.sessionProjections.restore(old, [], SessionLogOffset(child.seq), child.header, child.inheritedEventCount))
    .toThrow('version-mismatched')
})

it('rejects old or policy-rewritten content and metadata without executor body evidence', async () => {
  const h = await fixture(), id = ToolCallId('untrusted-ocr'), hash = 'b'.repeat(64)
  const value = { path: 'changed.mp4', source_version: 'changed', raw_json_path: 'changed.json', raw_json_sha256: hash }
  h.session.append('tool/call', { turn: 1, step: 1, callId: id, name: 'video_ocr', arguments: '{}' })
  h.session.append('tool/result', { turn: 1, step: 1, meta: value,
    message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }),
  }, { surfaceOp: 'append' })
  expect(sourceQaStateOf(h.readSourceQa, h.session).ocr).toEqual({})
  const restored = Session.create(h.session.id, h.session.snapshotEvents(), h.session.header)
  expect(sourceQaStateOf(h.readSourceQa, restored).ocr).toEqual({})
})
