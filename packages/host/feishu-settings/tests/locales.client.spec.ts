/** Dictionary parity for the Feishu settings section. */

import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('Feishu section dictionaries', () => {
  it('carries the same key set in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('leaves no empty copy behind', () => {
    for (const [key, value] of Object.entries({ ...zh, ...en })) {
      expect([key, value.trim().length > 0]).toEqual([key, true])
    }
  })

  it('keeps the scanner-facing copy free of credential placeholders', () => {
    // The page never shows a stored secret, so no sentence may invite one back.
    expect(JSON.stringify({ ...zh, ...en })).not.toMatch(/appSecret|client_secret/iu)
  })
})
