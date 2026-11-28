import { describe, expect, it } from 'vitest'
import { pcmWavDuration } from '../src/index.ts'

function chunk(tag: string, payload: Buffer): Buffer {
  const bytes = Buffer.alloc(8 + payload.length + payload.length % 2)
  bytes.write(tag, 0)
  bytes.writeUInt32LE(payload.length, 4)
  payload.copy(bytes, 8)
  return bytes
}

function format(rate = 8000, channels = 1): Buffer {
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(rate, 4)
  fmt.writeUInt32LE(rate * channels * 2, 8)
  fmt.writeUInt16LE(channels * 2, 12)
  fmt.writeUInt16LE(16, 14)
  return fmt
}

function riff(...chunks: Buffer[]): Buffer {
  const bytes = Buffer.concat([Buffer.from('RIFF....WAVE'), ...chunks])
  bytes.writeUInt32LE(bytes.length - 8, 4)
  return bytes
}

const fmt = chunk('fmt ', format())
const data = chunk('data', Buffer.alloc(160))
const valid = riff(fmt, data)

describe('PCM WAV duration', () => {
  it('measures stereo or mono from a bounded view and allows padded metadata chunks', () => {
    const stereo = riff(chunk('fmt ', format(48_000, 2)), chunk('LIST', Buffer.of(0)), chunk('data', Buffer.alloc(192)))
    const backing = new Uint8Array(stereo.length + 5)
    backing.set(stereo, 3)
    expect(pcmWavDuration(backing.subarray(3, 3 + stereo.length))).toBe(.001)
    expect(pcmWavDuration(valid)).toBe(.01)
  })

  it.each([
    ['short header', Buffer.alloc(43)],
    ['bad RIFF tag', Buffer.from(valid).fill('JUNK', 0, 4)],
    ['bad RIFF length', Buffer.from(valid).fill(0, 4, 8)],
    ['bad WAVE tag', Buffer.from(valid).fill('JUNK', 8, 12)],
    ['truncated chunk header', riff(fmt, data, Buffer.of(0))],
    ['truncated payload', riff(fmt, Buffer.from(data.subarray(0, data.length - 2)))],
    ['duplicate format', riff(fmt, fmt, data)],
    ['short format', riff(chunk('fmt ', Buffer.alloc(15)), data)],
    ['wrong encoding', riff(chunk('fmt ', format().fill(0, 0, 2)), data)],
    ['wrong bit depth', riff(chunk('fmt ', format().fill(0, 14, 16)), data)],
    ['unsupported channels', riff(chunk('fmt ', format(8000, 3)), data)],
    ['low sample rate', riff(chunk('fmt ', format(7999)), data)],
    ['high sample rate', riff(chunk('fmt ', format(48001)), data)],
    ['inconsistent frame size', riff(chunk('fmt ', format().fill(0, 12, 14)), data)],
    ['inconsistent byte rate', riff(chunk('fmt ', format().fill(0, 8, 12)), data)],
    ['samples before format', riff(data, fmt)],
    ['duplicate sample data', riff(fmt, data, data)],
    ['empty sample data', riff(fmt, chunk('data', Buffer.alloc(0)))],
    ['partial sample frame', riff(fmt, chunk('data', Buffer.alloc(159)))],
    ['missing sample data', riff(fmt, chunk('LIST', Buffer.alloc(4)))],
  ])('rejects %s', (_name, bytes) => {
    expect(pcmWavDuration(bytes)).toBeUndefined()
  })
})
