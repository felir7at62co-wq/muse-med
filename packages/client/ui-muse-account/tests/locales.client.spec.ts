import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('MUSE account Settings copy', () => {
  it('provides every label in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const value of [...Object.values(en), ...Object.values(zh)]) {
      expect(value.trim().length).toBeGreaterThan(0)
    }
  })

  it('does not echo credential values through interpolation', () => {
    expect(JSON.stringify({ en, zh })).not.toMatch(/\{password\}|\{cookie\}|\{token\}/iu)
  })
})
