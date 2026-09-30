/** Uploaded audio references are file sources, separate from trusted character image identities. */
import { JubianError } from '@deepseek-ai/dsh-jubian'

/** Maximum duration of one Jubian reference audio, in seconds. */
export const REFERENCE_AUDIO_MAX_SECONDS = 15

/** Measured PCM WAV information returned by reference-audio upload. */
export interface ReferenceAudio {
  format: 'wav'
  content_type: 'audio/wav'
  extension: '.wav'
  duration_seconds: number
  sample_rate: number
  channels: number
}

/**
 * Measure a complete PCM WAV reference using its actual sample bytes.
 * @param bytes - Local file contents; filenames and supplied duration labels are ignored.
 * @returns The measured duration, rate, channels and upload media type.
 */
export function readReferenceAudio(bytes: Uint8Array): ReferenceAudio {
  const refuse = (): never => { throw new JubianError('INVALID_ARGUMENT', 'Use a complete PCM WAV reference of at most 15 seconds; extract a 2-second voice sample first') }
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF'
    || data.toString('ascii', 8, 12) !== 'WAVE' || data.readUInt32LE(4) + 8 !== data.length) refuse()
  let sampleRate = 0, channels = 0, blockAlign = 0, sampleBytes = 0
  for (let offset = 12; offset + 8 <= data.length;) {
    const tag = data.toString('ascii', offset, offset + 4)
    const length = data.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + length > data.length) refuse()
    if (tag === 'fmt ') {
      if (length < 16 || data.readUInt16LE(start) !== 1 || data.readUInt16LE(start + 14) !== 16) refuse()
      channels = data.readUInt16LE(start + 2)
      sampleRate = data.readUInt32LE(start + 4)
      blockAlign = data.readUInt16LE(start + 12)
      if (![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 96000
        || blockAlign !== channels * 2 || data.readUInt32LE(start + 8) !== sampleRate * blockAlign) refuse()
    } else if (tag === 'data') {
      if (sampleBytes !== 0) refuse()
      sampleBytes = length
    }
    offset = start + length + (length % 2)
  }
  if (!blockAlign || !sampleRate || !sampleBytes || sampleBytes % blockAlign !== 0) refuse()
  const duration = sampleBytes / blockAlign / sampleRate
  if (duration > REFERENCE_AUDIO_MAX_SECONDS) refuse()
  return { format: 'wav', content_type: 'audio/wav', extension: '.wav', duration_seconds: duration,
    sample_rate: sampleRate, channels }
}

/**
 * Validate an uploaded audio row without requiring a character-image parent ID.
 * @param material - Live storyboard audio material.
 * @returns The same row after its URL, marker, order and available duration are checked.
 */
export function validateAudioMaterial(material: Record<string, unknown>): Record<string, unknown> {
  const refuse = (detail: string): never => { throw new JubianError('CONTRACT_CHANGED', detail) }
  if (material.materialType !== 'audio') refuse('Reference material is not audio')
  if (typeof material.materialKey !== 'string' || !material.materialKey.trim()) refuse('Audio reference is missing materialKey')
  const order = Number(material.sortOrder)
  if (!Number.isSafeInteger(order) || order < 1) refuse('Audio reference is missing sortOrder')
  if (typeof material.materialUrl !== 'string') refuse('Audio reference is missing materialUrl')
  let url: URL
  try { url = new URL(String(material.materialUrl)) } catch (_error) { return refuse('Audio reference materialUrl is invalid') }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash
    || String(material.materialUrl).includes('\\')) refuse('Audio reference must use a credential-free HTTPS materialUrl')
  const duration = material.audioDuration
  if (duration !== undefined && duration !== null) {
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0
      || duration > REFERENCE_AUDIO_MAX_SECONDS) refuse('Reference audio duration must be greater than 0 and at most 15 seconds')
  }
  return material
}

/**
 * Read ordered reference audio URLs from a mixed storyboard material list.
 * @param materials - Already parsed live storyboard materials.
 * @returns Audio URLs in consecutive group order; absent duration metadata stays unverified.
 */
export function referenceAudioUrls(materials: Record<string, unknown>[]): string[] {
  return materials.filter(material => material.materialType === 'audio')
    .map((material, index) => {
      const audio = validateAudioMaterial(material)
      if (Number(audio.sortOrder) !== index + 1) {
        throw new JubianError('CONTRACT_CHANGED',
          'Audio reference sortOrder must match its consecutive group position and prompt key order')
      }
      return String(audio.materialUrl)
    })
}

/**
 * Read complete audio-source evidence from one generated child.
 * @param child - Provider child result with audioMaterials or mixed storyboardMaterialList.
 * @returns URLs in provider order, or null when the child supplies no readable evidence.
 */
export function childAudioUrls(child: Record<string, unknown>): string[] | null {
  let value = child.audioMaterials ?? child.storyboardMaterialList
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch (_error) { return null }
  }
  if (!Array.isArray(value)) return null
  const materials: Record<string, unknown>[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const material = item as Record<string, unknown>
    if ((child.audioMaterials === undefined || child.audioMaterials === null) && material.materialType !== 'audio') continue
    materials.push(material)
  }
  const urls: string[] = []
  for (const material of materials) {
    const url = material.audioUrl ?? material.materialUrl
    if (typeof url !== 'string' || !url) return null
    urls.push(url)
  }
  return urls
}
