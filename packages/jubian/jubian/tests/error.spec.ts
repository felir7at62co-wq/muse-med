import { describe, expect, it } from 'vitest'
import { JubianError, codeForHttpStatus, failureForEnvelopeCode } from '../src/error.ts'

describe('codeForHttpStatus', () => {
  it('treats both 401 and 403 as a token that cannot be used', () => {
    expect(codeForHttpStatus(401)).toBe('AUTHENTICATION_REQUIRED')
    expect(codeForHttpStatus(403)).toBe('AUTHENTICATION_REQUIRED')
  })

  it('separates rate limiting from other transport failures', () => {
    expect(codeForHttpStatus(429)).toBe('RATE_LIMITED')
    expect(codeForHttpStatus(500)).toBe('NETWORK_ERROR')
    expect(codeForHttpStatus(404)).toBe('NETWORK_ERROR')
  })
})

describe('failureForEnvelopeCode', () => {
  it('maps only the application-level rejections an envelope can carry', () => {
    expect(failureForEnvelopeCode(401)).toBe('AUTHENTICATION_REQUIRED')
    expect(failureForEnvelopeCode(403)).toBe('PERMISSION_DENIED')
    expect(failureForEnvelopeCode(429)).toBe('RATE_LIMITED')
  })

  it('returns null for the two success codes so callers keep the data', () => {
    expect(failureForEnvelopeCode(0)).toBeNull()
    expect(failureForEnvelopeCode(200)).toBeNull()
  })
})

describe('JubianError', () => {
  it('carries a stable code and a message that never contains a provider body', () => {
    const error = new JubianError('CONTRACT_CHANGED')
    expect(error.code).toBe('CONTRACT_CHANGED')
    expect(error.name).toBe('JubianError')
    expect(error.message).toBe('Jubian response did not match the expected envelope')
    expect(error.message).not.toContain('{')
  })
})
