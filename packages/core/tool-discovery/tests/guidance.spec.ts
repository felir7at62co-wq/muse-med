/** Initial capability summaries stay bounded without hiding discovery or exposing definitions. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { discoveryGuidance } from '../src/guidance.ts'

const directorySchema = z.object({ capabilities: z.array(z.object({
  id: z.string(), title: z.string(), description: z.string(),
})), omitted_capabilities: z.number() })

function directory(text: string) {
  const body = text.slice(text.lastIndexOf('\n') + 1)
  return { body, value: directorySchema.parse(JSON.parse(body)) }
}

describe('initial discovery guidance', () => {
  it('explains deferred tools and recovery even when no categories are configured', () => {
    const guidance = discoveryGuidance([], 256, 40)
    expect(guidance).toContain('Some authorized tools are not loaded upfront')
    expect(guidance).toContain('Missing initial definitions or local scripts')
    expect(guidance).toContain('before building a shell or web substitute')
    expect(guidance).toContain('rephrase or browse with no arguments')
    expect(directory(guidance).value).toEqual({ capabilities: [], omitted_capabilities: 0 })
  })

  it('preserves category names before sharing description space and keeps JSON escapes intact', () => {
    const summaries = Array.from({ length: 6 }, (_, index) => ({ id: `group-${index}`, title: `能力${index}`,
      description: '音频"\\\t识别😀'.repeat(100), tool_count: 1 }))
    const result = directory(discoveryGuidance(summaries, 512, 320))
    expect(result.body.length).toBeLessThanOrEqual(512)
    expect(result.value.capabilities.map(capability => capability.id)).toEqual(summaries.map(capability => capability.id))
    expect(result.value.capabilities.every(capability => capability.description.length > 0)).toBe(true)
    expect(result.value.omitted_capabilities).toBe(0)
  })

  it('keeps only first-line bounded previews and marks categories whose names do not fit', () => {
    const result = directory(discoveryGuidance([
      { id: 'too-long'.repeat(100), title: 'Oversized', description: 'Cannot fit', tool_count: 1 },
      { id: 'video', title: '视频', description: '  😀😀😀extra\nDo not copy this second line.', tool_count: 1 },
    ], 256, 3))
    expect(result.body.length).toBeLessThanOrEqual(256)
    expect(result.value).toEqual({ capabilities: [{ id: 'video', title: '视频', description: '😀😀😀' }], omitted_capabilities: 1 })
  })
})
