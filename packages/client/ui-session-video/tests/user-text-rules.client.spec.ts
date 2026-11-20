/** Only explicit, self-consistent plugin evidence becomes compact video references. */
import { Context } from '@deepseek-ai/cordis'
import { UserTextRegistry } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/user-text-registry.ts'
import { expect, it, onTestFinished } from 'vitest'
import { parseVideoSelectionData, videoSelectionRule, videoReviewRule } from '../src/client/user-text-rules.ts'
import { serializeVideoTargets, VIDEO_REVIEW_REQUEST, VIDEO_SELECTION_CLOSE, VIDEO_SELECTION_OPEN, videoWorkspaceAddress } from '../src/client/target-selection.ts'
import { sessionId, shot, source, whole } from './selection-fixture.client.ts'

function evidence() {
  const item = source()
  const serialized = serializeVideoTargets([shot(item)], [item], sessionId)
  if (!serialized.ok) throw new Error('selection fixture is unavailable')
  const json = serialized.text.slice(VIDEO_SELECTION_OPEN.length, -VIDEO_SELECTION_CLOSE.length).trim()
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value) || value.length !== 1 || value[0] === null || typeof value[0] !== 'object') throw new Error('selection fixture is malformed')
  return { text: serialized.text, json, row: value[0] as Record<string, unknown> }
}

function evaluator() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const registry = new UserTextRegistry(ctx)
  registry.register(videoSelectionRule)
  return registry.createEvaluator()
}

it('compacts only the owned envelope while retaining surrounding user text and logged evidence', () => {
  const fixture = evidence(), text = `Keep the dialogue.\n${fixture.text}\nChange the background.`
  const nodes = evaluator()({ text, facts: {} })
  expect(nodes.map(node => node.id)).toEqual(['text', 'muse-video-selection', 'text'])
  const node = nodes[1]
  if (node?.id !== 'muse-video-selection') throw new Error('selection was not recognized')
  expect(node.data).toEqual({ sessionId, items: [{ label: 'Video first',
    reviewLink: videoWorkspaceAddress(sessionId, shot()), startSeconds: 4, endSeconds: 8 }] })
  expect(text.slice(node.start, node.end)).toBe(fixture.text)
  expect(text).toContain('"source_version": "v1"')
  expect(node.data).not.toHaveProperty('path')
  expect(nodes[0]).toMatchObject({ data: { text: 'Keep the dialogue.\n' } })
  expect(nodes[2]).toMatchObject({ data: { text: '\nChange the background.' } })
})

it('leaves arbitrary JSON, malformed envelopes and unknown fields visible', () => {
  const fixture = evidence(), evaluate = evaluator()
  for (const text of [fixture.json, `${VIDEO_SELECTION_OPEN}\n${fixture.json}`, `${VIDEO_SELECTION_OPEN}invalid${VIDEO_SELECTION_CLOSE}`,
    `${VIDEO_SELECTION_OPEN}${JSON.stringify([{ ...fixture.row, arbitrary_user_text: 'never hide me' }])}${VIDEO_SELECTION_CLOSE}`]) {
    expect(evaluate({ text, facts: {} })).toEqual([{ id: 'text', start: 0, end: text.length, data: { text } }])
  }
})

it('validates supported fields and requires advice links to match source, version and complete segment coordinates', () => {
  const { row } = evidence()
  for (const changed of [
    { review_link: 'https://example.test/video' }, { review_link: videoWorkspaceAddress(sessionId) },
    { review_link: `${String(row.review_link)}#unowned` }, { source_id: 'other' }, { source_version: 'old' },
    { shot_id: 'other-cut' }, { start_seconds: 0 }, { end_seconds: 99 }, { start_seconds: undefined },
    { event_seq: -1 }, { presented_index: 'not an index' }, { production: { scriptId: 1, guessed_episode: 31 } },
    { production: { scriptId: 1, episodeNumber: -1 } },
  ]) expect(parseVideoSelectionData(JSON.stringify([{ ...row, ...changed }]))).toBeNull()
  expect(parseVideoSelectionData('[]')).toBeNull()
  expect(parseVideoSelectionData('{}')).toBeNull()
})

it('accepts current production metadata and whole-video references without requiring it on older messages', () => {
  const item = { ...source(), production: { scriptId: 10, episodeId: 131, episodeNumber: 31,
    storyboardId: 51, packageIndex: 2, taskId: 17, subtaskId: 170, shotNumbers: [3, 4] } }
  const serialized = serializeVideoTargets([whole(item)], [item], sessionId)
  if (!serialized.ok) throw new Error('selection fixture is unavailable')
  expect(serialized.text).toContain('"storyboardId": 51')
  expect(videoSelectionRule.match(serialized.text, 0, { read: () => undefined })).toMatchObject({
    data: { items: [{ label: item.label, reviewLink: videoWorkspaceAddress(sessionId, whole(item)) }] },
  })
  expect(parseVideoSelectionData(evidence().json)).not.toBeNull()
})

it('refuses mixed-Session or duplicate references rather than giving ambiguous labels an action', () => {
  const { row } = evidence()
  const otherLink = String(row.review_link).replace(`/session/${sessionId}`, '/session/another-conversation')
  expect(parseVideoSelectionData(JSON.stringify([row, { ...row, review_link: otherLink }]))).toBeNull()
  expect(parseVideoSelectionData(JSON.stringify([row, row]))).toBeNull()
})

it('uses original UTF-16 offsets and can find later valid evidence after an invalid envelope', () => {
  const fixture = evidence(), invalid = `${VIDEO_SELECTION_OPEN}not JSON${VIDEO_SELECTION_CLOSE}`
  const text = `🙂 ${invalid}\n${fixture.text}`
  const node = videoSelectionRule.match(text, 0, { read: () => undefined })
  expect(node?.start).toBe(text.indexOf(fixture.text))
  expect(node?.end).toBe(text.length)
  expect(videoSelectionRule.match(text, text.length, { read: () => undefined })).toBeUndefined()
  expect(videoSelectionRule.match(fixture.text, 1, { read: () => undefined })).toBeUndefined()
})

it('hides only the exact recorded review intent while leaving surrounding user text intact', () => {
  const text = `Please inspect.\n${VIDEO_REVIEW_REQUEST}\nKeep the dialogue.`
  expect(videoReviewRule.match(text, 0, { read: () => undefined })).toEqual({ id: 'muse-video-review',
    start: text.indexOf(VIDEO_REVIEW_REQUEST), end: text.indexOf(VIDEO_REVIEW_REQUEST) + VIDEO_REVIEW_REQUEST.length,
    data: { mode: 'read-only' } })
  expect(videoReviewRule.match(text, text.length, { read: () => undefined })).toBeUndefined()
})
