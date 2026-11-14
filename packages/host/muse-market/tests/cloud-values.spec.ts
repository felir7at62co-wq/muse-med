/** Browser and Host readers share exact, byte-bounded Skill cloud JSON admission. */
import { describe, expect, it } from 'vitest'
import { parseMarketAccountId, parseMarketIdentity, parseMarketPublication,
  parseMarketPublicationId, parseMarketPublisherId, parseMarketUploadRequestId } from '../src/cloud-values.ts'
import { limits, manifest } from './fixtures.ts'

const publication = { id: 'a'.repeat(32), publisherId: 'b'.repeat(32), publisher: 'Writing team',
  manifest, sha256: 'c'.repeat(64), bytes: 512, status: 'draft', reviewNote: '', revision: 1,
  createdAt: '2026-11-09T00:00:00.000Z' }

describe('portable cloud JSON readers', () => {
  it.each([null, { ...publication, id: 'not-a-publication' }, { ...publication, manifest: { ...manifest, skills: [] } }])(
    'returns the same credential-free 502 refusal for malformed publication JSON %#', (value) => {
      expect(() => parseMarketPublication(value, limits)).toThrow(expect.objectContaining({
        name: 'MarketCloudError', code: 'invalid-response', status: 502,
      }))
    },
  )

  it('accepts reordered JSON keys while retaining exact immutable metadata', () => {
    const reordered = Object.fromEntries(Object.entries(manifest).reverse())
    expect(parseMarketPublication({ ...publication, manifest: reordered }, limits)).toEqual(publication)
  })

  it.each([
    { ...manifest, privatePath: '/private/author' },
    { ...manifest, skills: [{ ...manifest.skills[0], privatePath: '/private/author' }] },
    { ...manifest, kind: 'bot' },
  ])('rejects extra fields and retired payloads in a cloud manifest', (value) => {
    expect(() => parseMarketPublication({ ...publication, manifest: value }, limits))
      .toThrow('invalid-response')
  })

  it('enforces the UTF-8 byte budget for Chinese and supplementary characters', () => {
    const value = { ...manifest, description: '场景审稿 🎬' }
    const encoded = new TextEncoder().encode(JSON.stringify(value)).byteLength
    expect(encoded).toBeGreaterThan(JSON.stringify(value).length)
    expect(() => parseMarketPublication({ ...publication, manifest: value }, { ...limits, recordBytes: encoded - 1 }))
      .toThrow('invalid-response')
    expect(parseMarketPublication({ ...publication, manifest: value }, { ...limits, recordBytes: encoded }).manifest)
      .toEqual(value)
  })

  it('requires the authenticated account when reconstructing upload authority', () => {
    const identity = { accountId: 'd'.repeat(16), publishers: [{ id: 'b'.repeat(32), title: 'Writing team' }], admin: false }
    expect(parseMarketIdentity(identity)).toEqual(identity)
    expect(() => parseMarketIdentity({ publishers: identity.publishers, admin: false })).toThrow('invalid-response')
    expect(() => parseMarketIdentity({ ...identity, accountId: 'd'.repeat(32) })).toThrow('invalid-response')
    expect(() => parseMarketIdentity({ ...identity, cookie: 'private' })).toThrow('invalid-response')
    expect(() => parseMarketIdentity({ ...identity, publishers: [...identity.publishers, ...identity.publishers] }))
      .toThrow('invalid-response')
  })

  it('keeps local digest, publication, account and original attempt identities separate', () => {
    expect(parseMarketPublicationId('a'.repeat(32))).toBe('a'.repeat(32))
    expect(parseMarketPublisherId('b'.repeat(32))).toBe('b'.repeat(32))
    expect(parseMarketAccountId('d'.repeat(16))).toBe('d'.repeat(16))
    expect(parseMarketUploadRequestId('original_attempt-1')).toBe('original_attempt-1')
    expect(() => parseMarketPublicationId('c'.repeat(64))).toThrow('invalid-publication')
    expect(() => parseMarketPublisherId('d'.repeat(16))).toThrow('invalid-publisher')
    expect(() => parseMarketAccountId('a'.repeat(32))).toThrow('invalid-account')
    expect(() => parseMarketUploadRequestId('attempt/key')).toThrow('invalid-request-id')
  })

  it.each([null, [], { id: 'b'.repeat(32), title: '' },
    { id: 'b'.repeat(32), title: 'Writing team', privatePath: '/private/team' }])(
    'rejects an invalid publishing membership %#', (membership) => {
      expect(() => parseMarketIdentity({ accountId: 'd'.repeat(16), publishers: [membership], admin: false }))
        .toThrow('invalid-response')
    })
})
