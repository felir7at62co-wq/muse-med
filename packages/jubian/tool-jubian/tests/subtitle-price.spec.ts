import { describe, expect, it } from 'vitest'
import { readSubtitleEraseQuote } from '../src/subtitle-price.ts'

const regional = { modelId: 'quzimuToB', platformId: 'YU_DIAN', standardId: 26, videoStandardId: null }
const automatic = { modelId: 'ark-erase-video-subtitle-pro', platformId: 'AI_MEDIA_KIT',
  standardId: 67, videoStandardId: null }

describe('conservative subtitle-erasure reservations', () => {
  it.each([
    [1, '0.51'], [60, '0.51'], [60.1, '1.01'],
  ])('rounds %.1f seconds up to whole minutes and cents', (duration, amount) => {
    expect(readSubtitleEraseQuote([{ ...regional, id: 26, unitPrice: 0.505,
      unit: '元/分钟' }], regional, duration)).toMatchObject({ amount, unit: 'CNY' })
  })

  it('reserves a cent for a displayed zero per-clip price', () => {
    expect(readSubtitleEraseQuote([{ ...automatic, id: 67, unitPrice: 0,
      unit: '元/条' }], automatic, 58)).toMatchObject({ amount: '0.01', unit: 'CNY' })
  })

  it.each([
    { unitPrice: -1, unit: '元/分钟' },
    { unitPrice: 0.505, unit: '元/条' },
    { unitPrice: null, unit: '元/分钟' },
  ])('rejects invalid or mismatched regional pricing: %j', (price) => {
    expect(() => readSubtitleEraseQuote([{ ...regional, id: 26, ...price }], regional, 58))
      .toThrow('Invalid live subtitle-erasure price')
  })

  it('rejects ambiguous catalogue rows and invalid duration', () => {
    const row = { ...regional, id: 26, unitPrice: 0.505, unit: '元/分钟' }
    expect(() => readSubtitleEraseQuote([row, row], regional, 58)).toThrow()
    expect(() => readSubtitleEraseQuote([row], regional, 0)).toThrow()
  })

  it('accepts a row using standardId instead of id', () => {
    expect(readSubtitleEraseQuote([{ ...regional, unitPrice: 0.505,
      unit: '元/分钟' }], regional, 58)).toMatchObject({ amount: '0.51' })
  })

  it('fails closed on exponential or unsafe prices and durations', () => {
    const row = { ...automatic, id: 67, unit: '元/条' }
    expect(() => readSubtitleEraseQuote([{ ...row, unitPrice: 1e-7 }], automatic, 58)).toThrow()
    expect(() => readSubtitleEraseQuote([{ ...row, unitPrice: 1e20 }], automatic, 58)).toThrow()
    expect(() => readSubtitleEraseQuote([{ ...regional, id: 26, unitPrice: 0.505,
      unit: '元/分钟' }], regional, 1e18)).toThrow()
  })
})
