import { describe, expect, it } from 'vitest'
import { JUBIAN_TOKEN_REF, isUsableBearerToken, trimBearerToken } from '../src/credential.ts'

describe('trimBearerToken', () => {
  it('repairs the paste artifacts a shell or a form leaves behind', () => {
    expect(trimBearerToken('  eyJhbGciOi.payload.sig  ')).toBe('eyJhbGciOi.payload.sig')
    expect(trimBearerToken('export TOKEN=eyJhbGci.payload.sig;')).toBe('export TOKEN=eyJhbGci.payload.sig')
    expect(trimBearerToken('eyJhbGci.payload.sig;')).toBe('eyJhbGci.payload.sig')
    expect(trimBearerToken('eyJhbGci.payload.sig&')).toBe('eyJhbGci.payload.sig')
    expect(trimBearerToken('"eyJhbGci.payload.sig"')).toBe('eyJhbGci.payload.sig')
    expect(trimBearerToken("'eyJhbGci.payload.sig'")).toBe('eyJhbGci.payload.sig')
  })

  it('never rewrites the token itself', () => {
    expect(trimBearerToken('eyJhbGci.payload.sig')).toBe('eyJhbGci.payload.sig')
    // A single unmatched quote is part of the value, not a paste artifact.
    expect(trimBearerToken('"eyJhbGci.payload.sig')).toBe('"eyJhbGci.payload.sig')
  })
})

describe('isUsableBearerToken', () => {
  it('accepts a token without whitespace and rejects everything else', () => {
    expect(isUsableBearerToken('eyJhbGci.payload.sig')).toBe(true)
    expect(isUsableBearerToken('')).toBe(false)
    expect(isUsableBearerToken('eyJ hbGci.payload')).toBe(false)
    expect(isUsableBearerToken('eyJhbGci\npayload')).toBe(false)
  })
})

describe('JUBIAN_TOKEN_REF', () => {
  it('is the one key name this plugin owns', () => {
    expect(JUBIAN_TOKEN_REF).toBe('JUBIANAI_ADMIN_TOKEN')
  })
})
