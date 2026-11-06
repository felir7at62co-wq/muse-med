/** Pure issuance folds prove restoration and reject unrelated, failed or unbound tool output. */
import { Context } from '@deepseek-ai/cordis'
import Sessions, { Session, SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished } from 'vitest'
import { installSourceQaState, sourceQaStateOf } from '../src/source-qa-state.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  installSourceQaState(ctx)
  const session = ctx.sessions.create(SessionId('source-qa-projection'))
  let counter = 0
  const result = (name: string, value: object, isError = false) => {
    const id = ToolCallId(`call-${++counter}`)
    session.append('tool/call', { turn: 1, step: 1, callId: id, name, arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: id,
      content: [{ type: 'text', text: JSON.stringify(value) }], isError }) }, { surfaceOp: 'append' })
  }
  return { ctx, session, result }
}

it('restores compact successful native OCR and observation issuance from the same Session', async () => {
  const h = await fixture(), sha = 'a'.repeat(64)
  h.result('video_ocr', { path: 'video.mp4', source_version: 'v1', raw_json_path: 'ocr.json', raw_json_sha256: sha })
  h.result('video_inspect', { complete: true, path: 'video.mp4', source_version: 'v1', review_id: 'review-1',
    observation_report: 'review.json', observation_report_sha256: sha, observation_session_id: h.session.id })
  const expected = sourceQaStateOf(h.ctx, h.session)
  expect(expected.ocr['ocr.json']).toEqual({ path: 'video.mp4', source_version: 'v1', sha256: sha })
  expect(expected.reviews['review.json']).toMatchObject({ review_id: 'review-1', session_id: h.session.id, sha256: sha })
  expect(expected.native).toEqual({})
  const restored = Session.create(h.session.id, h.session.snapshotEvents(), h.session.header)
  expect(sourceQaStateOf(h.ctx, restored)).toEqual(expected)
})

it('ignores errors, other tool names, incomplete reviews and old OCR without the complete artifact hash', async () => {
  const h = await fixture(), value = { path: 'v.mp4', source_version: 'v1', raw_json_path: 'ocr.json', raw_json_sha256: 'b'.repeat(64) }
  h.result('run_command', value)
  h.result('video_ocr', value, true)
  const { raw_json_sha256: _hash, ...legacy } = value
  h.result('video_ocr', legacy)
  h.result('video_inspect', { complete: false, path: 'v.mp4', observation_report: 'review.json' })
  expect(sourceQaStateOf(h.ctx, h.session)).toEqual({ native: {}, nested: {}, ocr: {}, reviews: {} })
})

it('accepts a successful PTC sub-dispatch only with its matching actual start', async () => {
  const h = await fixture(), sha = 'c'.repeat(64), data = { rootCallId: ToolCallId('root'), parentCallId: ToolCallId('root'),
    subCallId: ToolCallId('sub'), name: 'video_ocr', arguments: {} }
  const content = [{ type: 'text' as const, text: JSON.stringify({ path: 'v.mp4', source_version: 'v1',
    raw_json_path: 'ocr.json', raw_json_sha256: sha }) }]
  h.session.append('tool/ptc-dispatch', { ...data, isError: false, content })
  expect(sourceQaStateOf(h.ctx, h.session).ocr).toEqual({})
  h.session.append('tool/ptc-dispatch-start', data)
  h.session.append('tool/ptc-dispatch', { ...data, isError: false, content })
  expect(sourceQaStateOf(h.ctx, h.session).ocr['ocr.json']?.sha256).toBe(sha)
  expect(sourceQaStateOf(h.ctx, h.session).nested).toEqual({})
})
