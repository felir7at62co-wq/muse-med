/** Child artifact acceptance checks required top-level properties independently of task completion. */
import { expect, it } from 'vitest'
import { checkArtifact, renderArtifactFailure } from '../src/artifact.ts'

it.each([undefined, null, [], false, 1, 'text'])('reports a nonobject child artifact: %j', (value) => {
  const verdict = checkArtifact({ type: 'object', properties: {} }, value)
  expect(verdict).toEqual({ ok: false, failure: { kind: 'not-a-record' } })
  if (verdict.ok) throw Error('Nonobject artifact was accepted')
  expect(renderArtifactFailure(verdict.failure)).toBe('the structured result is not a JSON object')
})

it('reports the first missing required property and accepts present values without imposing content quality', () => {
  const schema = { type: 'object' as const, properties: {}, required: ['answer', 'sources'] }
  const verdict = checkArtifact(schema, { sources: [] })
  expect(verdict).toEqual({ ok: false, failure: { kind: 'missing-required-property', missing: 'answer' } })
  if (verdict.ok) throw Error('Incomplete artifact was accepted')
  expect(renderArtifactFailure(verdict.failure)).toBe('the structured result is missing the required property "answer"')
  expect(checkArtifact(schema, { answer: null, sources: [] })).toEqual({ ok: true })
  expect(checkArtifact({ type: 'object', properties: {} }, {})).toEqual({ ok: true })
})
