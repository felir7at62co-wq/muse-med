/** Real archive preparation with only public HTTP and Windows executable processes mocked. */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareCiFfmpeg } from './prepare-ci-ffmpeg.ts'

const commands = vi.hoisted(() => ({
  execute: vi.fn<(binary: string, args: string[], options: { cwd: string; encoding: string }) =>
  Promise<{ stdout: string; stderr: string }>>(),
}))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: commands.execute }) }
})

let root: string | undefined
let pathFile: string
let fixture: Buffer
let probeOutput: string
let failCommand: number | undefined
let commandCount: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-ci-media-test-'))
  pathFile = join(root, 'github-path')
  await writeFile(pathFile, 'original-path\n')
  fixture = await readFile(new URL('./tests/fixtures/ci-ffmpeg/complete.zip', import.meta.url))
  probeOutput = JSON.stringify({ streams: [{ codec_name: 'h264' }, { codec_name: 'aac' }] })
  failCommand = undefined
  commandCount = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array(fixture)))
  commands.execute.mockReset().mockImplementation(async () => {
    if (++commandCount === failCommand) throw new Error('media executable failed')
    return { stdout: commandCount === 4 ? probeOutput : 'version fixture', stderr: '' }
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function resource(): { filename: string; url: string; bytes: number; sha256: string } {
  return { filename: 'fixture.zip', url: 'https://fixture.invalid/ffmpeg.zip', bytes: fixture.length,
    sha256: createHash('sha256').update(fixture).digest('hex') }
}

function parent(): string {
  if (root === undefined) throw new Error('Fixture temporary directory is missing')
  return root
}

async function expectUnpublished(): Promise<void> {
  expect(await readFile(pathFile, 'utf8')).toBe('original-path\n')
  expect(await readdir(parent())).toEqual(['github-path'])
}

describe('Windows CI FFmpeg preparation', () => {
  it('qualifies exact private executables and media streams before publishing their path', async () => {
    const bin = await prepareCiFfmpeg(parent(), pathFile, resource())
    expect(await readFile(pathFile, 'utf8')).toBe(`original-path\n${bin}\n`)
    expect(bin).toMatch(/dsh-ci-ffmpeg-[^/\\]+[/\\]runtime[/\\]ffmpeg[/\\]bin$/)
    expect(await readdir(bin)).toEqual(['ffmpeg.exe', 'ffprobe.exe'])
    const calls = commands.execute.mock.calls
    expect(calls.map(call => call[0])).toEqual([
      join(bin, 'ffmpeg.exe'), join(bin, 'ffprobe.exe'), join(bin, 'ffmpeg.exe'), join(bin, 'ffprobe.exe'),
    ])
    expect(calls[0]?.[1]).toEqual(['-version'])
    expect(calls[1]?.[1]).toEqual(['-version'])
    expect(calls[2]?.[1]).toEqual(expect.arrayContaining(['libx264', 'aac', 'subtitles=captions.srt', 'loudnorm']))
    expect(calls[3]?.[1]).toEqual(['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', 'smoke.mp4'])
    expect(calls.every(call => call[2]?.cwd === dirname(dirname(dirname(bin))))).toBe(true)
    expect(globalThis.fetch).toHaveBeenCalledExactlyOnceWith(resource().url, expect.any(Object))
  })

  it.each(['checksum', 'size', 'HTTP'] as const)('rejects %s download failures without publishing or retaining a stage', async (failure) => {
    const locked = resource()
    if (failure === 'checksum') locked.sha256 = '0'.repeat(64)
    if (failure === 'size') locked.bytes += 1
    if (failure === 'HTTP') vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 406 }))
    await expect(prepareCiFfmpeg(parent(), pathFile, locked)).rejects.toThrow(/checksum|size|HTTP 406/)
    expect(commands.execute).not.toHaveBeenCalled()
    await expectUnpublished()
  })

  it.each([
    { name: 'missing-probe.zip', error: /ENOENT/ },
    { name: 'directory-probe.zip', error: /not a regular file/ },
    { name: 'unsafe.zip', error: /invalid relative path: \.\.\/escaped\.txt/ },
  ])('rejects $name before publishing a partial runtime', async ({ name, error }) => {
    fixture = await readFile(new URL(`./tests/fixtures/ci-ffmpeg/${name}`, import.meta.url))
    await expect(prepareCiFfmpeg(parent(), pathFile, resource())).rejects.toThrow(error)
    await expectUnpublished()
  })

  it.each([1, 2, 3, 4])('keeps executable failure %s blocking and removes the private runtime', async (command) => {
    failCommand = command
    await expect(prepareCiFfmpeg(parent(), pathFile, resource())).rejects.toThrow('media executable failed')
    expect(commands.execute).toHaveBeenCalledTimes(command)
    await expectUnpublished()
  })

  it.each([
    'null', '{}', '{"streams":[]}', '{"streams":[{},{}]}',
    '{"streams":[{"codec_name":"h264"},{"codec_name":"mp3"}]}',
    '{"streams":[{"codec_name":"h264"},{"codec_name":"h264"}]}',
    '{"streams":[{"codec_name":"aac"},{"codec_name":"aac"}]}',
  ])('refuses unexpected ffprobe streams %s', async (output) => {
    probeOutput = output
    await expect(prepareCiFfmpeg(parent(), pathFile, resource())).rejects.toThrow('did not produce H264/AAC')
    await expectUnpublished()
  })

  it('removes qualified media when publishing the path fails', async () => {
    const missingPathFile = join(parent(), 'absent', 'github-path')
    await expect(prepareCiFfmpeg(parent(), missingPathFile, resource())).rejects.toThrow(/ENOENT/)
    await expectUnpublished()
  })

  it('waits for the owned executable to settle before removing its private runtime', async () => {
    let entered: (() => void) | undefined
    let release: (() => void) | undefined
    const started = new Promise<void>((resolve) => { entered = resolve })
    const completion = new Promise<void>((resolve) => { release = resolve })
    commands.execute.mockImplementationOnce(async () => {
      entered?.()
      await completion
      throw new Error('media executable failed')
    })
    const pending = prepareCiFfmpeg(parent(), pathFile, resource())
    const rejected = expect(pending).rejects.toThrow('media executable failed')
    try {
      await started
      expect(await readFile(pathFile, 'utf8')).toBe('original-path\n')
      expect((await readdir(parent())).filter(name => name.startsWith('dsh-ci-ffmpeg-'))).toHaveLength(1)
      release?.()
      await rejected
      await expectUnpublished()
    } finally {
      release?.()
      await Promise.allSettled([pending, rejected])
    }
  })
})
