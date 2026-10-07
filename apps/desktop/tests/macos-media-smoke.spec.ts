/** Reject media payloads that cannot supply the inspection tool's PNG and source timestamp. */
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process'
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

function reply(stdout: Buffer | string, stderr = ''): SpawnSyncReturns<Buffer> {
  return { pid: 1, output: [], stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), status: 0, signal: null }
}

function fixture(binary: string, args: string[]): SpawnSyncReturns<Buffer> {
  if (args[0] === '-version') return reply(`${basename(binary)} version fixture\n`)
  if (binary === '/usr/bin/otool') return reply(`${args[1]}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n\t/usr/lib/libz.1.dylib (compatibility version 1.0.0)\n`)
  if (args.includes('png')) return reply(png, frameDiagnostic)
  return reply(Buffer.alloc(16 * 12 * 3))
}

beforeEach(() => { command.mockReset(); command.mockImplementation(fixture) })

it('checks scaled PNG output, nonzero source time and full PNG decoding with only system dependencies', () => {
  smokeMacMedia('/fixture')
  const extraction = command.mock.calls.find(([, args]) => args.includes('png'))!
  expect(extraction[1]).toContain("scale=w='min(16,iw)':h='min(16,ih)':force_original_aspect_ratio=decrease,showinfo")
  expect(extraction[1]).toContain('image2pipe')
  const decoding = command.mock.calls.find(([, args]) => args.includes('rawvideo'))!
  expect(decoding[2].input).toEqual(png)
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
  command.mockImplementation((binary, args) => args.includes('rawvideo') ? reply(Buffer.alloc(1)) : fixture(binary, args))
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

it('rejects malformed library diagnostics and excluded license options', () => {
  command.mockImplementation((binary, args) => binary === '/usr/bin/otool' ? reply('fixture:\nmalformed\n') : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow('invalid library diagnostics')
  command.mockImplementation((binary, args) => args[0] === '-version'
    ? reply(`${basename(binary)} version fixture\nconfiguration: --enable-gpl`) : fixture(binary, args))
  expect(() => { smokeMacMedia('/fixture') }).toThrow('failed standalone smoke')
})
