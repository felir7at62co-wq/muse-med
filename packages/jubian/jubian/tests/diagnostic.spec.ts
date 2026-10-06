import { describe, expect, it } from 'vitest'
import { describePayload, describeRejection, redactForDump } from '../src/diagnostic.ts'

describe('provider response diagnostics', () => {
  it('describes missing values and primitive array entries without treating them as records', () => {
    expect(describePayload(undefined)).toBe('top-level null, excerpt undefined')
    expect(describePayload([false])).toBe('top-level array of 1 elements, first element boolean, excerpt [false]')
    expect(describePayload([null])).toBe('top-level array of 1 elements, first element null, excerpt [null]')
    expect(describePayload([])).toBe('top-level array of 0 elements, excerpt []')
    expect(describeRejection([{ code: 'invalid' }])).toContain('code=none, not an integer')
  })

  it('bounds object keys, excerpts and nested containers independently', () => {
    const record = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field-${index}`, `value ${index} `.repeat(20)]))
    const summary = describePayload(record)
    expect(summary).toContain('top-level object with 30 keys')
    expect(summary).toContain('…(6 more)')
    expect(summary).not.toContain('field-24')
    expect(summary.endsWith('…')).toBe(true)
    expect(summary.split('excerpt ')[1]).toHaveLength(201)
    expect(redactForDump({ nested: { more: { values: [1, 2], record: { private: 'hidden' } } } }))
      .toEqual({ nested: { more: { values: '[array of 2]', record: '[object]' } } })
    expect(redactForDump([1, 2, 3, 4, 5, 6, 7])).toEqual([1, 2, 3, 4, 5, 6, '[1 more]'])
  })

  it('reduces absolute URLs to their origin and redacts credentials inside other text', () => {
    const result = redactForDump({ url: 'https://cdn.example/file.mp4?token=PRIVATE',
      note: 'download?signature=PRIVATE then Bearer PRIVATE', accessToken: 'PRIVATE',
      long: 'part '.repeat(30) })
    expect(result).toMatchObject({ url: 'https://cdn.example/…',
      note: 'download?signature=[redacted] then Bearer [redacted]', accessToken: '[redacted]' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })
})
