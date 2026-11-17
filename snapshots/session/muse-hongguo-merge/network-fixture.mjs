/** Distinct invented episode bytes keep numeric merge order observable without opening sockets. */
export * from '../../../third_party/plugins/muse-hongguo-download/src/network.js'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { checkedUrl } from '../../../third_party/plugins/muse-hongguo-download/src/network.js'

export const seriesId = '7700000000000000301'
export const privateMarker = 'merge_private_source_token'
export const requests = []
const box = (type, bytes = Buffer.alloc(0)) => {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(bytes.length + 8); header.write(type, 4)
  return Buffer.concat([header, bytes])
}
const mp4 = text => Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')),
  box('moov', box('trak', box('mdia'))), box('mdat', Buffer.from(text))])
export const media = [mp4('invented episode one'), mp4('invented episode two')]
export const mergedMedia = mp4('invented episode one|invented episode two')
export const mediaUrl = index => `https://fixture.jspcdn.cn/merge-episode-${index}.mp4?token=${privateMarker}`

/**
 * @param {string} value - Invented allowlisted episode address.
 * @param {'page'|'media'} kind - Actual transfer purpose.
 * @param {AbortSignal} signal - The downloader's owned cancellation.
 * @param {object} options - Real client allowlists and headers.
 * @returns {Promise<import('node:stream').Readable>} Complete synthetic MP4; no socket is opened.
 */
export async function officialRequest(value, kind, signal, options = {}) {
  signal.throwIfAborted(); assert.equal(kind, 'media')
  const url = checkedUrl(value, kind, options.allowedHosts, options.allowedPorts)
  assert.equal(url.origin, 'https://fixture.jspcdn.cn')
  const index = Number(/^\/merge-episode-(\d+)\.mp4$/.exec(url.pathname)?.[1])
  assert.ok(index === 1 || index === 2, 'The unselected third episode must never transfer')
  assert.equal(url.href, mediaUrl(index)); assert.equal(options.headers.cookie, undefined)
  requests.push(index)
  const bytes = media[index - 1]
  return Object.assign(Readable.from([bytes]), { statusCode: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } })
}
