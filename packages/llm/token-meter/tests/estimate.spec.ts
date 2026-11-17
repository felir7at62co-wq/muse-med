import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { estimateToolSchemas, estimateToolsTokens } from '../src/estimate.ts'

const TOOLS: ToolSchema[] = [
  { name: 'read', description: 'Read one file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'skill', description: 'Load a skill.', parameters: { type: 'object' }, deferLoading: true },
]

describe('estimateToolSchemas', () => {
  it('prices a tool list exactly as the request envelope prices the same tools', () => {
    const expected = Math.ceil(JSON.stringify(TOOLS).length / 4) + 4
    expect(estimateToolSchemas(TOOLS)).toBe(expected)
    expect(estimateToolsTokens({ config: { provider: 'p', model: 'm' }, tools: TOOLS })).toBe(expected)
  })

  it('prices no tools as zero', () => {
    expect(estimateToolSchemas([])).toBe(0)
    expect(estimateToolsTokens({ config: { provider: 'p', model: 'm' }, tools: [] })).toBe(0)
    expect(estimateToolsTokens({ config: { provider: 'p', model: 'm' } })).toBe(0)
    expect(estimateToolsTokens(undefined)).toBe(0)
  })
})
