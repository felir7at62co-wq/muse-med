/** Browser and Host readers share exact, byte-bounded Skill cloud JSON admission. */
import { describe, expect, it } from 'vitest'
import { parseMarketAccountId, parseMarketIdentity, parseMarketPublication,
  parseMarketPublicationId, parseMarketPublisherId, parseMarketUploadRequestId } from '../src/cloud-values.ts'
import { limits, manifest } from './fixtures.ts'
import { marketMetadata } from '../src/format-values.ts'

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

  it.each([null, {}, { ...manifest, title: '' }, { ...manifest, version: 'next' }, { ...manifest, requirements: [4] }])(
    'rejects incomplete or invalid author metadata before publication: %j', (value) => {
      expect(() => marketMetadata(value)).toThrow('invalid-manifest')
    })

  it('retains the portrait binding on a previously published Skill record', () => {
    const published = {
      id: 'e83e9dfa53ad6b9f381f1c5da06f0e4c', publisherId: '5d6f7532f63301d39dc516be31265c5a',
      publisher: 'Muse 分镜交付创作组',
      manifest: { formatVersion: 1, kind: 'skill', name: 'muse-storyboard-checklist', title: 'Muse 分镜交付检查',
        description: '在短剧、漫剧或预演分镜交付前核对镜号、版本、时长、画幅、素材依赖与未决项，生成可追踪的交付清单。',
        version: '1.0.1', license: 'MIT', category: '分镜创作',
        examples: ['核对分镜索引的版本对应、标称时长与素材缺项，并明确哪些实际文件状态仍待确认。'],
        requirements: ['提供已有的镜头表、分镜文件索引或逐镜描述。可附预演、资产表和交付规格。'],
        presetPortrait: 'storyboard-reviewer',
        skills: [{ name: 'muse-storyboard-checklist', path: 'skills/muse-storyboard-checklist/SKILL.md' }] },
      sha256: 'e26a068af103c17fb507368fc9239c9e5b1458e65dd74cbf6f49097ed8cb2caf', bytes: 2743,
      status: 'published', reviewNote: '已核对交付检查规则与使用示例，修正版本对应判断、证据范围与阻塞项排序。',
      revision: 3, createdAt: '2026-11-06T06:15:05.766Z',
    }
    expect(parseMarketPublication(published, limits)).toEqual(published)
  })

  it('accepts reordered JSON keys while retaining exact immutable metadata', () => {
    const reordered = Object.fromEntries(Object.entries(manifest).reverse())
    expect(parseMarketPublication({ ...publication, manifest: reordered }, limits)).toEqual(publication)
  })

  it.each([null, {}, { name: 3 }, { name: 'invalid/name' }, { name: 'fixture-skill', path: 'skills/other/SKILL.md' }])(
    'rejects an invalid sole Skill declaration from cloud metadata: %j', (skill) => {
      expect(() => parseMarketPublication({ ...publication, manifest: { ...manifest, skills: [skill] } }, limits))
        .toThrow('invalid-response')
    })

  it.each([
    { ...manifest, privatePath: '/private/author' },
    { ...manifest, presetPortrait: 'storyboard-reviewer', privatePath: '/private/author' },
    { ...manifest, skills: [{ ...manifest.skills[0], privatePath: '/private/author' }] },
    { ...manifest, kind: 'bot' },
  ])('rejects extra fields and retired payloads in a cloud manifest', (value) => {
    expect(() => parseMarketPublication({ ...publication, manifest: value }, limits))
      .toThrow('invalid-response')
  })

  it.each([null, 7, '', '../portrait', 'https://example.com/portrait', 'a/b', 'a\\b', 'Uppercase',
    'leading-', '-trailing', 'two--parts', 'two_parts', '角色', 'a'.repeat(65)])(
    'rejects a portrait binding that is not a bounded asset key: %j', (presetPortrait) => {
      expect(() => parseMarketPublication({ ...publication, manifest: { ...manifest, presetPortrait } }, limits))
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
