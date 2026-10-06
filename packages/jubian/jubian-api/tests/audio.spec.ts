import { describe, expect, it } from 'vitest'
import { childAudioUrls, readReferenceAudio, referenceAudioUrls, validateAudioMaterial } from '../src/audio.ts'

/** Complete mono PCM wave at 8000 Hz; its sample count determines duration. */
function wave(seconds: number): Uint8Array {
  const bytes = Buffer.alloc(44 + seconds * 8000 * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36)
  bytes.writeUInt32LE(bytes.length - 44, 40)
  return bytes
}

describe('reference audio bytes', () => {
  it('measures duration from complete PCM bytes and accepts the 15-second limit', () => {
    expect(readReferenceAudio(wave(2))).toEqual({ duration_seconds: 2, sample_rate: 8000, channels: 1,
      format: 'wav', content_type: 'audio/wav', extension: '.wav' })
    expect(readReferenceAudio(wave(15)).duration_seconds).toBe(15)
  })

  it('refuses overlong, truncated and mislabeled files before uploading', () => {
    expect(() => readReferenceAudio(wave(16))).toThrow('15')
    expect(() => readReferenceAudio(wave(2).slice(0, 44))).toThrow()
    expect(() => readReferenceAudio(new Uint8Array([1, 2, 3]))).toThrow()
  })

  it('keeps missing remote duration unverified while refusing invalid known durations and URLs', () => {
    const audio = { materialType: 'audio', materialKey: 'voice', sortOrder: 1,
      materialUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/voice.wav' }
    expect(validateAudioMaterial(audio)).toBe(audio)
    expect(validateAudioMaterial({ ...audio, audioDuration: 2 })).toMatchObject({ audioDuration: 2 })
    expect(validateAudioMaterial({ ...audio, audioDuration: null })).toMatchObject({ audioDuration: null })
    expect(() => validateAudioMaterial({ ...audio, audioDuration: 16 })).toThrow('15')
    expect(() => validateAudioMaterial({ ...audio, materialUrl: 'https://user:password@example.com/voice.wav' }))
      .toThrow('credential-free')
    expect(() => validateAudioMaterial({ ...audio, materialKey: '' })).toThrow('materialKey')
    expect(childAudioUrls({ audioMaterials: JSON.stringify([{ audioUrl: audio.materialUrl }]) })).toEqual([audio.materialUrl])
    expect(childAudioUrls({ audioMaterials: null, storyboardMaterialList: [
      { materialType: 'image', materialUrl: 'https://example.com/image.jpg' }, audio,
    ] })).toEqual([audio.materialUrl])
    expect(childAudioUrls({ audioMaterials: '{}' })).toBeNull()
  })

  it('refuses reversed or duplicate group ordering before audio references can be frozen', () => {
    const first = { materialType: 'audio', materialKey: 'first', sortOrder: 1,
      materialUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/first.wav' }
    const second = { ...first, materialKey: 'second', sortOrder: 2,
      materialUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/second.wav' }
    expect(referenceAudioUrls([first, second])).toEqual([first.materialUrl, second.materialUrl])
    expect(() => referenceAudioUrls([second, first])).toThrow('sortOrder')
    expect(() => referenceAudioUrls([first, { ...second, sortOrder: 1 }])).toThrow('sortOrder')
  })

  it.each([
    { label: 'a data chunk larger than the file', change: (bytes: Buffer) => bytes.writeUInt32LE(bytes.length, 40) },
    { label: 'a short format chunk', change: (bytes: Buffer) => bytes.writeUInt32LE(15, 16) },
    { label: 'compressed audio', change: (bytes: Buffer) => bytes.writeUInt16LE(3, 20) },
    { label: 'non-16-bit samples', change: (bytes: Buffer) => bytes.writeUInt16LE(24, 34) },
    { label: 'unsupported channel count', change: (bytes: Buffer) => bytes.writeUInt16LE(3, 22) },
    { label: 'unsupported sample rate', change: (bytes: Buffer) => bytes.writeUInt32LE(7999, 24) },
    { label: 'inconsistent block alignment', change: (bytes: Buffer) => bytes.writeUInt16LE(4, 32) },
    { label: 'inconsistent byte rate', change: (bytes: Buffer) => bytes.writeUInt32LE(1, 28) },
    { label: 'missing PCM format', change: (bytes: Buffer) => bytes.write('JUNK', 12) },
  ])('refuses $label from the actual WAV fields', ({ change }) => {
    const bytes = Buffer.from(wave(2))
    change(bytes)
    expect(() => readReferenceAudio(bytes)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })

  it('accepts stereo PCM and skips an odd-length metadata chunk with its padding byte', () => {
    const stereo = Buffer.from(wave(2))
    stereo.writeUInt16LE(2, 22); stereo.writeUInt16LE(4, 32); stereo.writeUInt32LE(32000, 28)
    const metadata = Buffer.alloc(10)
    metadata.write('JUNK'); metadata.writeUInt32LE(1, 4)
    const bytes = Buffer.concat([stereo.subarray(0, 36), metadata, stereo.subarray(36)])
    bytes.writeUInt32LE(bytes.length - 8, 4)
    expect(readReferenceAudio(bytes)).toMatchObject({ channels: 2, duration_seconds: 1 })
  })

  it('refuses duplicate, empty and incomplete sample data rather than reporting a duration', () => {
    const duplicate = Buffer.concat([Buffer.from(wave(2)), Buffer.from('64617461020000000000', 'hex')])
    duplicate.writeUInt32LE(duplicate.length - 8, 4)
    expect(() => readReferenceAudio(duplicate)).toThrow()
    expect(() => readReferenceAudio(wave(0))).toThrow()
    const partialSample = Buffer.from(wave(2)).subarray(0, 48)
    partialSample.writeUInt32LE(partialSample.length - 8, 4); partialSample.writeUInt32LE(3, 40)
    expect(() => readReferenceAudio(partialSample)).toThrow()
  })

  it.each([
    { materialType: 'image' }, { sortOrder: 0 }, { sortOrder: 1.5 }, { materialUrl: null },
    { materialUrl: 'not a URL' }, { materialUrl: 'https://x/voice.wav#private' },
    { materialUrl: 'https://x/voice\\sample.wav' }, { audioDuration: 0 }, { audioDuration: NaN },
  ])('rejects incomplete or unsafe audio material fields: %j', (overrides) => {
    expect(() => validateAudioMaterial({ materialType: 'audio', materialKey: 'voice', sortOrder: 1,
      materialUrl: 'https://x/voice.wav', ...overrides }))
      .toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it('reports missing child audio evidence rather than accepting malformed rows or empty URLs', () => {
    for (const audioMaterials of ['{', [null], [[]], [{ audioUrl: '' }], [{ audioUrl: 1 }]]) {
      expect(childAudioUrls({ audioMaterials })).toBeNull()
    }
    expect(childAudioUrls({ audioMaterials: [] })).toEqual([])
  })
})
