import { describe, expect, it } from 'vitest'
import type { FinishReason, TokenUsage } from '@deepseek-ai/dsh-llm'
import { assess, resolveRoutes, routeKey, type RouteConfig } from '../src/assess.ts'
import { INCIDENT_ROWS, ROUTE } from './fixtures/incident.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface FinishReasonMap {
    /** A merge-extended kind this guard does not know. */
    'test-paused': { kind: 'test-paused' }
  }
}

const route = ROUTE
const stop: FinishReason = { kind: 'stop' }

function judge(
  usage: TokenUsage | undefined, toolSchemaTokens: number, estimateTokens: number,
  finish: FinishReason = stop, toolCall = false, generatedText = true,
) {
  return assess({ finish, toolCall, generatedText, usage, toolSchemaTokens, estimateTokens, route })
}

describe('assess', () => {
  it.each(INCIDENT_ROWS)('$source is $expected', (row) => {
    const verdict = judge(row.usage, row.toolSchemaTokens, row.estimateTokens)
    if (row.expected === 'pass') {
      expect(verdict).toEqual({ kind: 'pass' })
      return
    }
    const reported = row.usage.inputTokens + (row.usage.cacheReadTokens ?? 0)
    expect(verdict).toEqual({
      kind: 'reject', reportedPromptTokens: reported, toolSchemaTokens: row.toolSchemaTokens,
      estimateTokens: row.estimateTokens, belowToolSchemas: true, belowEstimate: true,
    })
  })

  it('counts cached prompt tokens as part of the prompt', () => {
    expect(judge({ inputTokens: 6951, outputTokens: 100 }, 10326, 29390).kind).toBe('reject')
    expect(judge({ inputTokens: 6951, outputTokens: 100, cacheReadTokens: 20018 }, 10326, 29390)).toEqual({ kind: 'pass' })
    expect(judge({ inputTokens: 6951, outputTokens: 100, cacheWriteTokens: 20018 }, 10326, 29390)).toEqual({ kind: 'pass' })
  })

  it('rejects only below both thresholds and reports which one a near miss crossed', () => {
    expect(judge({ inputTokens: 10000, outputTokens: 1 }, 10000, 40000)).toMatchObject({ kind: 'near-miss', belowToolSchemas: false, belowEstimate: true })
    expect(judge({ inputTokens: 9999, outputTokens: 1 }, 10000, 40000).kind).toBe('reject')
    expect(judge({ inputTokens: 10000, outputTokens: 1 }, 30000, 20000)).toMatchObject({ kind: 'near-miss', belowToolSchemas: true, belowEstimate: false })
    expect(judge({ inputTokens: 9999, outputTokens: 1 }, 30000, 20000).kind).toBe('reject')
    expect(judge({ inputTokens: 30000, outputTokens: 1 }, 30000, 60000)).toEqual({ kind: 'pass' })
  })

  it.each<[string, TokenUsage | undefined, number, number, FinishReason, boolean]>([
    ['no usage', undefined, 24235, 52798, stop, false],
    ['zero usage', { inputTokens: 0, outputTokens: 0 }, 24235, 52798, stop, false],
    ['no tool schemas', { inputTokens: 10, outputTokens: 1 }, 0, 52798, stop, false],
    ['no estimate', { inputTokens: 10, outputTokens: 1 }, 24235, 0, stop, false],
    ['a tool call', { inputTokens: 10, outputTokens: 1 }, 24235, 52798, stop, true],
    ['tool-calls', { inputTokens: 10, outputTokens: 1 }, 24235, 52798, { kind: 'tool-calls' }, false],
    ['max-tokens', { inputTokens: 10, outputTokens: 1 }, 24235, 52798, { kind: 'max-tokens' }, false],
    ['error', { inputTokens: 10, outputTokens: 1 }, 24235, 52798, { kind: 'error', failure: { code: 'SERVER', message: 'down' } }, false],
    ['aborted', { inputTokens: 10, outputTokens: 1 }, 24235, 52798, { kind: 'aborted', failure: { code: 'ABORTED', message: 'stop' } }, false],
  ])('passes %s', (_case, usage, toolSchemaTokens, estimateTokens, finish, toolCall) => {
    expect(judge(usage, toolSchemaTokens, estimateTokens, finish, toolCall)).toEqual({ kind: 'pass' })
  })

  it('passes a zero-completion report for a reply that streamed text, as BB6 sends it', () => {
    expect(judge({ inputTokens: 5008, outputTokens: 0 }, 24235, 120000)).toEqual({ kind: 'pass' })
    expect(judge({ inputTokens: 12436, outputTokens: 0 }, 32935, 190000)).toEqual({ kind: 'pass' })
  })

  it('still judges a zero-completion report for a reply without generated content', () => {
    expect(judge({ inputTokens: 5008, outputTokens: 0 }, 24235, 120000, stop, false, false).kind).toBe('reject')
  })

  it('still rejects the GEE incident shape with a nonzero completion count', () => {
    expect(judge({ inputTokens: 5008, outputTokens: 1 }, 24235, 120000).kind).toBe('reject')
  })

  it('passes a merge-extended finish kind', () => {
    expect(judge({ inputTokens: 10, outputTokens: 1 }, 24235, 52798, { kind: 'test-paused' })).toEqual({ kind: 'pass' })
  })
})

describe('resolveRoutes', () => {
  const valid: RouteConfig = { provider: 'muse-cloud-yunying', model: 'gemini-3.1-pro', minToolSchemaRatio: 1, minEstimateRatio: 0.5 }

  it('keys every route by its exact provider and model', () => {
    const second = { ...valid, model: 'gpt-6.1-sol', minToolSchemaRatio: 1.2, minEstimateRatio: 0.4 }
    const routes = resolveRoutes({ routes: [valid, second] })
    expect(routes.get(routeKey('muse-cloud-yunying', 'gemini-3.1-pro'))).toEqual(valid)
    expect(routes.get(routeKey('muse-cloud-yunying', 'gpt-6.1-sol'))).toEqual(second)
    expect(routeKey('a","b', 'c')).not.toBe(routeKey('a', 'b","c'))
  })

  it.each<[string, object, RegExp]>([
    ['no routes', { routes: [] }, /routes must list/],
    ['missing routes', {}, /routes must list/],
    ['a non-object config', [], /config must be an object/],
    ['a non-object route', { routes: ['gemini'] }, /routes\[0\] must be an object/],
    ['an unknown config key', { routes: [valid], extra: 1 }, /unknown config key "extra"/],
    ['an unknown route key', { routes: [{ ...valid, typo: 1 }] }, /routes\[0\] has unknown key "typo"/],
    ['an empty provider', { routes: [{ ...valid, provider: '' }] }, /routes\[0\]\.provider/],
    ['a missing model', { routes: [{ ...valid, model: undefined }] }, /routes\[0\]\.model/],
    ['a repeated route', { routes: [valid, { ...valid }] }, /routes\[1\] repeats/],
    ['a zero tool-schema ratio', { routes: [{ ...valid, minToolSchemaRatio: 0 }] }, /minToolSchemaRatio/],
    ['a negative tool-schema ratio', { routes: [{ ...valid, minToolSchemaRatio: -1 }] }, /minToolSchemaRatio/],
    ['a NaN tool-schema ratio', { routes: [{ ...valid, minToolSchemaRatio: Number.NaN }] }, /minToolSchemaRatio/],
    ['an infinite tool-schema ratio', { routes: [{ ...valid, minToolSchemaRatio: Number.POSITIVE_INFINITY }] }, /minToolSchemaRatio/],
    ['a zero estimate ratio', { routes: [{ ...valid, minEstimateRatio: 0 }] }, /minEstimateRatio/],
    ['an estimate ratio of 1', { routes: [{ ...valid, minEstimateRatio: 1 }] }, /minEstimateRatio/],
    ['an estimate ratio above 1', { routes: [{ ...valid, minEstimateRatio: 1.5 }] }, /minEstimateRatio/],
    ['a NaN estimate ratio', { routes: [{ ...valid, minEstimateRatio: Number.NaN }] }, /minEstimateRatio/],
    ['a string estimate ratio', { routes: [{ ...valid, minEstimateRatio: '0.5' }] }, /minEstimateRatio/],
  ])('rejects %s', (_case, config, message) => {
    expect(() => resolveRoutes(config)).toThrow(message)
  })
})
