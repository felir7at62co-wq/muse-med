import { describe, expect, it } from 'vitest'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { readPayload } from '../src/reading.ts'

describe('readPayload diagnostics', () => {
  it('preserves successful results and failures unrelated to payload parsing', () => {
    expect(readPayload('assets', { rows: [] }, () => 12)).toBe(12)
    const local = new Error('local I/O failed')
    const denied = new JubianError('PERMISSION_DENIED')
    for (const failure of [local, denied]) {
      expect(() => readPayload('assets', { token: 'private' }, () => { throw failure })).toThrow(failure)
    }
  })

  it('appends a safe payload description to a reader-specific rejection', () => {
    expect(() => readPayload('assets', { token: 'private' }, () => {
      throw new JubianError('CONTRACT_CHANGED', 'no matching asset')
    })).toThrow('no matching asset. assets could not read this payload')
    expect(() => readPayload('assets', [], () => { throw new JubianError('CONTRACT_CHANGED') }))
      .toThrow('assets could not read this payload')
  })

  it('keeps an inner reader diagnostic intact instead of appending a second payload', () => {
    let inner: unknown
    try { readPayload('inner', { token: 'private' }, () => { throw new JubianError('CONTRACT_CHANGED') }) }
    catch (error) { inner = error }
    const outer = (): never => { throw inner }
    expect(() => readPayload('outer', { unrelated: true }, outer)).toThrow(inner)
    expect((inner as Error).message).not.toContain('private')
  })
})
