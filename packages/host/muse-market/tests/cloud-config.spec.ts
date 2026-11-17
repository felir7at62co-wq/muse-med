/** Cloud transfer budgets apply to complete responses while retaining explicit deployment choices. */
import { expect, it } from 'vitest'
import MuseMarketCloud from '../src/cloud.ts'

it('allows a two-minute full-body transfer by default and preserves a shorter explicit budget', () => {
  const baseUrl = 'https://muse.example'
  expect(MuseMarketCloud.Config({ baseUrl })).toMatchObject({ requestTimeoutMs: 120_000 })
  expect(MuseMarketCloud.Config({ baseUrl, requestTimeoutMs: 30_000 })).toMatchObject({ requestTimeoutMs: 30_000 })
  expect(() => MuseMarketCloud.Config({ baseUrl, requestTimeoutMs: 120_001 })).toThrow()
})
