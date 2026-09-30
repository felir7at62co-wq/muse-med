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
})
