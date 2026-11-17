/** Invented jackotom engine catalog and play info; signed URLs and device values stay inside the plugin. */
import assert from 'node:assert/strict'

export const seriesId = '1000000000000000001'
export const privateMarker = 'PRIVATE_JACKOTOM_SIGNATURE_AND_DEVICE_VALUE'
export const UA = 'jackotom-fixture-agent'
export const calls = []
const vids = [1, 2].map(index => `${seriesId}${index}`)
const box = (name, body = Buffer.alloc(0)) => {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(body.length + 8)
  header.write(name, 4)
  return Buffer.concat([header, body])
}
export const media = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')),
  box('moov', box('trak', box('mdia'))), box('mdat', Buffer.from('invented jackotom media fixture'))])
/** @param {string} vid - Requested episode id. @returns {string} Signed invented CDN address. */
export const mediaUrl = vid => `https://v1-hgweb.qznovelvod.com/jackotom-fixture/${vid}.mp4?sign=${privateMarker}`

/**
 * @param {string} id - Requested series id.
 * @param {{ signal: AbortSignal, deadline: number }} options - Real adapter cancellation and deadline.
 * @returns {Promise<object>} Upstream catalog fields read by the real adapter.
 */
export async function fetchEpisodeList(id, options) {
  options.signal.throwIfAborted()
  assert.equal(id, seriesId)
  assert.ok(Number.isFinite(options.deadline))
  calls.push({ method: 'fetchEpisodeList', id })
  return { series_id: id, series_title: '虚构开源引擎剧', total: 2, device_id: privateMarker,
    episodes: vids.map((vid, index) => ({ vid, vid_index: index + 1, title: `第${index + 1}集`, locked: false })) }
}

/**
 * @param {string} vid - Requested episode id.
 * @param {string} id - Owning series id.
 * @param {{ quality: string, signal: AbortSignal, force?: boolean }} options - Real adapter quality and retry flags.
 * @returns {Promise<object>} Unencrypted H.264 play info at the requested 1080p quality.
 */
export async function fetchPlayUrlSingle(vid, id, options) {
  options.signal.throwIfAborted()
  assert.equal(id, seriesId)
  assert.ok(vids.includes(vid))
  assert.equal(options.quality, '1080p')
  assert.equal(options.force, undefined, 'A successful lookup must not be retried')
  calls.push({ method: 'fetchPlayUrlSingle', vid })
  return { vid, url: mediaUrl(vid), width: 1080, height: 1920, duration: 10, codec: 'h264', userAgent: UA,
    locked: false, sources: [], device_id: privateMarker }
}

/** @returns {never} Unencrypted fixture media never derives a key. */
export function deriveKey() { throw new Error('Unencrypted fixture media must not derive a key') }
