import { expect, it } from 'vitest'
import { mediaEvidence, nativeMediaFacts } from '../src/douyin-media-facts.ts'

const target = '7692443246022167851'
const base = { responseStatus: 200, mediaHost: 'v3.douyinvod.com', mediaUrlHash: 'a'.repeat(64) }
const provider = { detailResponseStatus: 200, detailHost: 'www.douyin.com', detailPath: '/aweme/v1/web/aweme/detail/', targetVideoId: target,
  sourceField: 'video.bit_rate.play_addr', durationMs: 34434, width: 3840, height: 2160, documentEpoch: 1 }
const evidence = { ...base, association: 'provider-detail-verified', currentSrcMatched: false, provider }
const metadata = { format: { duration: '34.41' }, streams: [{ codec_type: 'video', width: 1920, height: 1080 }] }
it('keeps provider identification distinct and compares local duration and aspect ratio', () => {
  const facts = mediaEvidence(evidence, target)
  expect(facts.currentSrcMatched).toBe(false)
  expect(nativeMediaFacts(metadata, facts)).toEqual({ duration: 34.41, width: 1920, height: 1080 })
  expect(mediaEvidence({ ...base, association: 'player-exact', currentSrcMatched: true }, target).association).toBe('player-exact')
})
it.each([{ currentSrcMatched: true }, { association: 'unknown' }, { mediaHost: 'douyinvod.com.evil.test' }, { provider: { ...provider, targetVideoId: '7690000000000000000' } }, { provider: { ...provider, documentEpoch: 2 } }, { provider: { ...provider, detailResponseStatus: 403 } }])('rejects inconsistent native IPC evidence %#', (patch) => {
  expect(() => mediaEvidence({ ...evidence, ...patch }, target)).toThrow()
})
it.each([{ format: { duration: '1.0' } }, { streams: [] }, { streams: [{ codec_type: 'video', width: 1080, height: 1920 }] }, { format: { duration: 'nan' } }])('rejects different or invalid local media %#', (patch) => {
  expect(() => nativeMediaFacts({ ...metadata, ...patch }, mediaEvidence(evidence, target))).toThrow()
})
