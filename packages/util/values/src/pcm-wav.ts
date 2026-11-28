/** Duration of bounded PCM WAV inputs, measured from the sample bytes. */

const RIFF = 0x52494646
const WAVE = 0x57415645
const FORMAT = 0x666d7420
const DATA = 0x64617461

/**
 * Measure a complete 16-bit PCM WAV with one or two channels and an 8–48 kHz sample rate.
 * @param wav - Exact RIFF bytes to inspect.
 * @returns Duration in seconds, or undefined for incomplete or unsupported input.
 */
export function pcmWavDuration(wav: Uint8Array): number | undefined {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  if (view.byteLength < 44 || view.getUint32(0) !== RIFF || view.getUint32(4, true) !== view.byteLength - 8
    || view.getUint32(8) !== WAVE) return undefined
  let rate = 0
  let frameBytes = 0
  let dataBytes: number | undefined
  for (let offset = 12; offset < view.byteLength;) {
    if (offset + 8 > view.byteLength) return undefined
    const tag = view.getUint32(offset)
    const length = view.getUint32(offset + 4, true)
    const start = offset + 8
    offset = start + length + (length % 2)
    if (offset > view.byteLength) return undefined
    if (tag === FORMAT) {
      if (rate !== 0 || length < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 14, true) !== 16) return undefined
      const channels = view.getUint16(start + 2, true)
      if (channels !== 1 && channels !== 2) return undefined
      rate = view.getUint32(start + 4, true)
      frameBytes = channels * 2
      if (rate < 8000 || rate > 48000 || view.getUint16(start + 12, true) !== frameBytes
        || view.getUint32(start + 8, true) !== rate * frameBytes) return undefined
    } else if (tag === DATA) {
      if (rate === 0 || dataBytes !== undefined || length === 0 || length % frameBytes !== 0) return undefined
      dataBytes = length
    }
  }
  if (dataBytes === undefined) return undefined
  return dataBytes / (rate * frameBytes)
}
