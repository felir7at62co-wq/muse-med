import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('MUSE account Settings copy', () => {
  it('provides every label in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const value of [...Object.values(en), ...Object.values(zh)]) {
      expect(value.trim().length).toBeGreaterThan(0)
    }
  })

  it('names the shared Feishu entry and administrator action in both languages', () => {
    expect(zh.nav).toBe('MUSE')
    expect(en.nav).toBe('MUSE')
    expect(zh.title).toBe('MUSE')
    expect(en.title).toBe('MUSE')
    expect(zh.browserSignIn).toBe('飞书登录')
    expect(en.browserSignIn).toBe('Sign in with Feishu')
    expect(zh.adminManagement).toBe('用户管理')
    expect(en.adminManagement).toBe('User management')
  })

  it('does not echo credential values through interpolation', () => {
    expect(JSON.stringify({ en, zh })).not.toMatch(/\{password\}|\{cookie\}|\{token\}/iu)
  })
})
