/** Invented manifest media streams; the interrupted transfer closes before pause may be acknowledged. */
export * from '../../../third_party/plugins/muse-hongguo-download/src/network.js'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { checkedUrl } from '../../../third_party/plugins/muse-hongguo-download/src/network.js'

export const seriesId = '7700000000000000201'
export const privateMarker = 'task_control_private_source_token'
export const requests = []
const defer = () => { let resolve; const promise = new Promise(accept => { resolve = accept }); return { promise, resolve } }
export const secondStarted = defer(), secondClosed = defer()
export let interruptedStreamClosed = false
const box = (type, bytes = Buffer.alloc(0)) => {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(bytes.length + 8); header.write(type, 4)
  return Buffer.concat([header, bytes])
}
export const media = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')),
  box('moov', box('trak', box('mdia'))), box('mdat', Buffer.from('invented task controls media'))])
export const mediaUrl = index => `https://fixture.jspcdn.cn/episode-${index}.mp4?token=${privateMarker}`

/**
 * @param {string} value - Invented allowlisted media address.
 * @param {'page'|'media'} kind - Real client transfer purpose.
 * @param {AbortSignal} signal - The downloader's owned cancellation.
 * @param {object} options - Checked allowlists and transfer headers.
 * @returns {Promise<import('node:stream').Readable>} Controlled bytes; no socket is opened.
 */
export async function officialRequest(value, kind, signal, options = {}) {
  signal.throwIfAborted()
  assert.equal(kind, 'media', 'The authorized manifest requires no source lookup')
  const url = checkedUrl(value, kind, options.allowedHosts, options.allowedPorts)
  assert.equal(url.origin, 'https://fixture.jspcdn.cn')
  const index = Number(/^\/episode-(\d+)\.mp4$/.exec(url.pathname)?.[1])
  assert.ok(index === 1 || index === 2, 'The unselected third episode must never transfer')
  assert.equal(url.href, mediaUrl(index))
  assert.equal(options.headers.cookie, undefined)
  requests.push(index)
  const interrupted = index === 2 && requests.filter(item => item === 2).length === 1
  let response
  if (interrupted) {
    let pushed = false
    response = new Readable({ read() {
      if (!pushed) { pushed = true; this.push(media.subarray(0, 16)); secondStarted.resolve() }
    } })
    response.once('close', () => { interruptedStreamClosed = true; secondClosed.resolve() })
  } else response = Readable.from([media])
  return Object.assign(response, { statusCode: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(media.length) } })
}
