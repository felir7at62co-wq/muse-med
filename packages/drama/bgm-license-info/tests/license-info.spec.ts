/** Rights metadata stays declared, unknown, or incompatible; no test grants actual music rights. */

import { describe, expect, it } from 'vitest'
import { LicenseInfoInputSchema, licenseRiskWarnings, normalizeLicenseInfo, parseBgmUsage } from '../src/index.ts'

const declaration = {
  license: 'Synthetic test license', commercial_use: true,
  source: 'https://example.invalid/test-rights', attribution: 'Synthetic fixture credit', scope: 'Test distribution',
}

describe('BGM license declarations', () => {
  it('preserves all supplied facts without manufacturing a verified status', () => {
    const info = normalizeLicenseInfo(declaration)
    expect(info).toEqual({ status: 'declared', ...declaration })
    expect(licenseRiskWarnings(info, 'commercial')).toEqual([])
    expect(licenseRiskWarnings(info, 'non_commercial')).toEqual([])
    expect(normalizeLicenseInfo(info)).toEqual(info)
    expect(LicenseInfoInputSchema(declaration)).toEqual(info)
  })

  it.each([undefined, null, {}, { status: 'declared' }, { approved: true, verified: true }])(
    'normalizes missing facts to explicit unknown: %j', (value) => {
      const info = normalizeLicenseInfo(value)
      expect(info).toEqual({ status: 'unknown', license: 'unknown', commercial_use: 'unknown',
        source: 'unknown', attribution: 'unknown', scope: 'unknown' })
      expect(licenseRiskWarnings(info, 'commercial')).toEqual([
        '音乐授权信息未知或不完整；不能据此认定已获使用授权。',
      ])
    },
  )

  it.each(['license', 'source', 'scope'] as const)('does not retain commercial permission without %s', (field) => {
    const info = normalizeLicenseInfo({ ...declaration, [field]: undefined })
    expect(info.status).toBe('unknown')
    expect(info.commercial_use).toBe('unknown')
    expect(info[field]).toBe('unknown')
  })

  it('preserves partial known facts and explicit restrictions', () => {
    const info = normalizeLicenseInfo({ license: ' Fixture ', commercial_use: false, attribution: '  ', scope: null })
    expect(info).toEqual({ status: 'unknown', license: 'Fixture', commercial_use: false,
      source: 'unknown', attribution: 'unknown', scope: 'unknown' })
    expect(licenseRiskWarnings(info, 'commercial')).toContain('曲目声明不允许商业使用，与本次商业用途不匹配。')
  })

  it('reports commercial mismatch while retaining the declaration', () => {
    const info = normalizeLicenseInfo({ ...declaration, commercial_use: false })
    expect(info.status).toBe('declared')
    expect(licenseRiskWarnings(info, 'commercial')).toEqual(['曲目声明不允许商业使用，与本次商业用途不匹配。'])
    expect(licenseRiskWarnings(info, 'non_commercial')).toEqual([])
    expect(licenseRiskWarnings(info, 'unknown')).toEqual(['本次用途未指定，尚未核对音乐声明是否覆盖发行用途。'])
  })

  it.each([false, 3, 'CC BY', [], { status: 'verified' }, { commercial_use: 'false' },
    { commercial_use: 1 }, { license: 3 }, { source: true }, { attribution: [] }, { scope: {} }])(
    'rejects malformed declarations and approval claims: %j', (value) => {
      expect(() => normalizeLicenseInfo(value)).toThrow(/Invalid license_info/)
    },
  )

  it('normalizes omitted metadata through the plan schema', () => {
    expect(LicenseInfoInputSchema()).toEqual(normalizeLicenseInfo(undefined))
    expect(LicenseInfoInputSchema(null)).toEqual(normalizeLicenseInfo(undefined))
  })

  it.each([undefined, null, 'unknown'])('keeps unspecified purpose unknown: %j', (value) => {
    expect(parseBgmUsage(value)).toBe('unknown')
  })

  it.each(['commercial', 'non_commercial'] as const)('preserves an explicit %s purpose', (value) => {
    expect(parseBgmUsage(value)).toBe(value)
  })

  it.each([true, '', 'licensed'])('rejects unsupported release purposes: %j', (value) => {
    expect(() => parseBgmUsage(value)).toThrow(/Invalid intended_use/)
  })
})
