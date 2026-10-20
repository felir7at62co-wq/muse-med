/** Reject media payloads without usable subtitle, encoding and inspection capabilities. */
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { smokeMacMedia } from '../scripts/prepare-macos-media.ts'

const command = vi.hoisted(() => vi.fn<(binary: string, args: string[], options: SpawnSyncOptions) => SpawnSyncReturns<Buffer>>())
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  spawnSync: command,
}))

const png = Buffer.alloc(33)
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
png.writeUInt32BE(13, 8)
png.write('IHDR', 12)
png.writeUInt32BE(16, 16)
png.writeUInt32BE(12, 20)
const frameDiagnostic = '[Parsed_showinfo_1] n: 0 pts: 1 pts_time:0.5 duration:0.5\n'
const filters = ' ... ass V->V\n ... subtitles V->V\n ... drawtext V->V\n ... loudnorm A->A\n'
const encoders = ' V....D libx264 H264\n A....D aac AAC\n'
const subtitleFrameBytes = 160 * 96 * 3
const subtitleFilters = ['ass=captions.ass', 'subtitles=captions.srt'] as const

function subtitleFrames(): Buffer {
  const frames = Buffer.alloc(subtitleFrameBytes * 5)
  frames[subtitleFrameBytes * 2 + 30] = 255
  return frames
}

function reply(stdout: Buffer | string, stderr = ''): SpawnSyncReturns<Buffer> {
  return { pid: 1, output: [], stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), status: 0, signal: null }
}

function fixture(binary: string, args: string[]): SpawnSyncReturns<Buffer> {
  if (args[0] === '-version') return reply(`${basename(binary)} version fixture\nconfiguration: --enable-gpl --enable-libass --enable-libx264\n`)
  if (binary === '/usr/bin/otool') return reply(`${args[1]}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n\t/usr/lib/libz.1.dylib (compatibility version 1.0.0)\n`)
  if (args.includes('-filters')) return reply(filters)
  if (args.includes('-encoders')) return reply(encoders)
  if (args.includes('-show_entries')) return reply('h264\naac\n')
  if (args.includes('png')) return reply(png, frameDiagnostic)
  if (args.includes('image2pipe')) return reply(Buffer.alloc(16 * 12 * 3))
  if (subtitleFilters.some(filter => args.includes(filter))) return reply(subtitleFrames())
  return reply('')
}

beforeEach(() => { command.mockReset(); command.mockImplementation(fixture) })

it('checks GPL subtitle pixels, H264/AAC and scaled PNG output using only system dynamic libraries', () => {
  smokeMacMedia('/fixture')
  const extraction = command.mock.calls.find(([, args]) => args.includes('png'))!
  expect(extraction[1]).toContain("scale=w='min(16,iw)':h='min(16,ih)':force_original_aspect_ratio=decrease,showinfo")
  expect(extraction[1]).toContain('image2pipe')
  const decoding = command.mock.calls.find(([, args]) => args.includes('rawvideo'))!
  expect(decoding[2].input).toEqual(png)
  for (const filter of subtitleFilters) expect(command.mock.calls.some(([, args]) => args.includes(filter))).toBe(true)
  const encoding = command.mock.calls.find(([, args]) => args.includes('libx264'))!
  expect(encoding[1]).toContain('aac')
  const fullDecode = command.mock.calls.find(([, args]) => args.includes('encoded.mp4') && args.includes('null'))!
  expect(fullDecode[1]).toContain('-i')
  expect(fullDecode[1]).toContain('-xerror')
  expect(fullDecode[2].cwd).toEqual(encoding[2].cwd)
  expect(existsSync(encoding[2].cwd!)).toBe(false)
  for (const [, , options] of command.mock.calls) expect(options.env).toEqual({ PATH: '/usr/bin:/bin' })
})

it.each(['/opt/homebrew/lib/libz.1.dylib', '/usr/local/lib/libz.1.dylib', '@rpath/libz.1.dylib', '/usr/lib/../local/lib/libz.1.dylib'])(
  'rejects a payload linked to %s', (dependency) => {
    command.mockImplementation((binary, args) => binary === '/usr/bin/otool'
      ? reply(`${args[1]}:\n\t${dependency} (compatibility version 1.0.0)\n`) : fixture(binary, args))
    expect(() => { smokeMacMedia('/fixture') }).toThrow('requires Apple system zlib and libraries')
  },
)

it('rejects non-system libraries even when Apple zlib is present', () => {
  command.mockImplementation((binary, args) => binary === '/usr/bin/otool'
    ? reply(`${args[1]}:\n\t/usr/lib/libz.1.dylib (compatibility version 1.0.0)\n\t/opt/homebrew/lib/libextra.dylib (compatibility version 1.0.0)\n`)
    : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow('requires Apple system zlib and libraries')
})

it.each([
  { bytes: png, diagnostic: '', reason: 'missing timestamp' },
  { bytes: png, diagnostic: frameDiagnostic.replace('0.5', '0'), reason: 'reset timestamp' },
  { bytes: Buffer.from('not a PNG'), diagnostic: frameDiagnostic, reason: 'invalid image' },
  { bytes: (() => { const bytes = Buffer.from(png); bytes.writeUInt32BE(32, 16); return bytes })(), diagnostic: frameDiagnostic, reason: 'unscaled image' },
])('rejects extraction with $reason', ({ bytes, diagnostic }) => {
  command.mockImplementation((binary, args) => args.includes('png') ? reply(bytes, diagnostic) : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow('PNG extraction did not return a scaled image and source timestamp')
})

it('rejects a PNG that does not decode into a complete frame', () => {
  command.mockImplementation((binary, args) => args.includes('image2pipe') && args.includes('rawvideo')
    ? reply(Buffer.alloc(1)) : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow('extracted PNG did not decode completely')
})

it('retains the failing PNG command diagnostic', () => {
  command.mockImplementation((binary, args) => args.includes('png')
    ? { ...reply('', 'Unknown encoder png'), status: 1 } : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow('Unknown encoder png')
})

it('rejects a signaled command even when its exit status is zero', () => {
  command.mockReturnValue({ ...reply('ffmpeg version fixture'), signal: 'SIGTERM' })
  expect(() => { smokeMacMedia('/fixture') }).toThrow('signal SIGTERM')
})

it('rejects malformed library diagnostics', () => {
  command.mockImplementation((binary, args) => binary === '/usr/bin/otool' ? reply('fixture:\nmalformed\n') : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow('invalid library diagnostics')
})

it.each(['nonfree', 'version3'])('rejects the excluded %s license configuration', (option) => {
  command.mockImplementation((binary, args) => args[0] === '-version'
    ? reply(`${basename(binary)} version fixture\nconfiguration: --enable-gpl --enable-${option}`) : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow('failed standalone smoke')
})

it('rejects a build without the GPL configuration required for static x264', () => {
  command.mockImplementation((binary, args) => args[0] === '-version'
    ? reply(`${basename(binary)} version fixture\nconfiguration: --disable-gpl`) : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow('invalid standalone licensing configuration')
})

it.each(['ass', 'subtitles', 'drawtext', 'loudnorm'])('rejects a build without an executable %s filter', (filter) => {
  command.mockImplementation((binary, args) => args.includes('-filters')
    ? reply(filters.split('\n').filter(line => line.trim().split(/\s+/u)[1] !== filter).join('\n')) : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow(`missing required ${filter} filter`)
})

it.each(['libx264', 'aac'])('rejects a build without an executable %s encoder', (encoder) => {
  command.mockImplementation((binary, args) => args.includes('-encoders')
    ? reply(encoders.split('\n').filter(line => line.trim().split(/\s+/u)[1] !== encoder).join('\n')) : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow(`missing required ${encoder} encoder`)
})

it.each(subtitleFilters)('rejects missing, truncated or mistimed pixels from %s and removes its scratch files', (filter) => {
  const invalidFrames = [Buffer.alloc(subtitleFrameBytes * 5), Buffer.alloc(1), subtitleFrames(), subtitleFrames()]
  invalidFrames[2]![30] = 255
  invalidFrames[3]![subtitleFrameBytes * 4 + 30] = 255
  for (const frames of invalidFrames) {
    command.mockImplementation((binary, args) => args.includes(filter) ? reply(frames) : fixture(binary, args))
    expect(() => { smokeMacMedia('/fixture') }).toThrow('did not paint subtitles only inside the cue interval')
    const failed = command.mock.calls.filter(([, args]) => args.includes(filter)).at(-1)!
    expect(existsSync(failed[2].cwd!)).toBe(false)
  }
})

it.each(['mpeg4\naac\n', 'h264\n', 'h264\naac\naac\n'])('rejects unexpected encoded streams %j', (codecs) => {
  command.mockImplementation((binary, args) => args.includes('-show_entries') ? reply(codecs) : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow('H264/AAC smoke output has unexpected codecs')
})

it('retains the H264 encoder failure diagnostic', () => {
  command.mockImplementation((binary, args) => args.includes('libx264')
    ? { ...reply('', 'Error opening encoder libx264'), status: 1 } : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow('Error opening encoder libx264')
})

it('rejects an encoded movie that fails complete decoding', () => {
  command.mockImplementation((binary, args) => args.includes('encoded.mp4') && args.includes('null')
    ? { ...reply('', 'Invalid data in encoded frame'), status: 1 } : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow('Invalid data in encoded frame')
})
