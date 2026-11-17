/** Invented CDN bytes for jackotom play info; official pages and every real host are unreachable. */
export * from '../../../third_party/plugins/muse-hongguo-download/src/network.js'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { checkedUrl } from '../../../third_party/plugins/muse-hongguo-download/src/network.js'
import { UA, calls, media, mediaUrl, seriesId } from './engine-fixture.mjs'

/**
 * @param {string} value - Signed media URL returned by the engine fixture.
 * @param {'page' | 'media'} kind - The real client's declared request type.
 * @param {AbortSignal} signal - Owning tool cancellation.
 * @param {object} options - Real client headers and allowlists.
 * @returns {Promise<import('node:stream').Readable>} Controlled HTTP response stream.
 */
export async function officialRequest(value, kind, signal, options = {}) {
  signal.throwIfAborted()
  assert.equal(kind, 'media', 'The open engine owns catalog and play-info requests')
  const url = checkedUrl(value, kind, options.allowedHosts, options.allowedPorts)
  const vid = [1, 2].map(index => `${seriesId}${index}`).find(candidate => mediaUrl(candidate) === url.href)
  assert.ok(vid, 'Only engine play-info URLs may be transferred')
  assert.equal(options.method ?? 'GET', 'GET')
  assert.equal(options.headers['user-agent'], UA)
  assert.equal(options.headers.range, undefined)
  calls.push({ method: 'media', vid })
  return Object.assign(Readable.from([media]), { statusCode: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(media.length) } })
}
