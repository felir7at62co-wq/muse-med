/** Decoder process failures and cleanup preserve the inspected media bytes. */
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  execute: vi.fn<(
    command: string, args: string[], options: Record<string, unknown>,
    callback: (error: unknown, stdout: string, stderr: string) => void,
  ) => void>(),
}))
vi.mock('@deepseek-ai/dsh-jubian-api', () => ({ downloadMedia: mocks.download }))
vi.mock('node:child_process', () => ({ execFile: mocks.execute }))

import { checkVideoMedia, decodeVideoFile } from '../src/video-media-check.ts'

beforeEach(() => {
  mocks.execute.mockImplementation((_command, _args, _options, callback) => { callback(null, '', '') })
})
afterEach(() => { vi.resetAllMocks() })

it('downloads once, decodes the exact private snapshot and removes it after both tracks', async () => {
  const bytes = Buffer.from('provider media fixture')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  mocks.download.mockResolvedValue({ bytes, sha256 })
  let snapshot = ''
  const decodedBytes: Buffer[] = []
  mocks.execute.mockImplementation((command, args, options, callback) => {
    snapshot = args[args.indexOf('-i') + 1] ?? ''
    expect(command).toBe('/configured/ffmpeg')
    expect(options).toMatchObject({ timeout: 321, windowsHide: true, cwd: dirname(snapshot) })
    expect(args).toContain('-xerror')
    expect(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2)).toEqual(['-protocol_whitelist', 'file'])
    void readFile(snapshot).then((data) => {
      decodedBytes.push(data)
      callback(null, '', '')
    }, (error: unknown) => { callback(error, '', '') })
  })
  const signal = new AbortController().signal
  expect(await checkVideoMedia('https://media.example/result.mp4', '/configured/ffmpeg', 321, signal))
    .toEqual({ sha256, video: true, audio: true })
  expect(mocks.download).toHaveBeenCalledExactlyOnceWith('https://media.example/result.mp4', { kind: 'video', signal })
  expect(mocks.execute.mock.calls.map(call => call[1][call[1].indexOf('-map') + 1])).toEqual(['0:v:0', '0:a:0'])
  expect(decodedBytes).toEqual([bytes, bytes])
  await expect(access(dirname(snapshot))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports a failing video track while independently decoding audio', async () => {
  mocks.execute.mockImplementationOnce((_command, _args, _options, callback) => {
    callback(Object.assign(new Error('invalid video'), { code: 1 }), '', '')
  })
  expect(await decodeVideoFile(join('/project', 'output.mp4'), '/configured/ffmpeg', 100, new AbortController().signal))
    .toEqual({ video: false, audio: true })
  expect(mocks.execute).toHaveBeenCalledTimes(2)
})

it.each([
  'non-error rejection', new Error('no process exit code'), Object.assign(new Error('executable missing'), { code: 'ENOENT' }),
])('propagates a process failure without a numeric exit code: %j', async (failure) => {
  mocks.execute.mockImplementation((_command, _args, _options, callback) => { callback(failure, '', '') })
  await expect(decodeVideoFile('/project/output.mp4', '/configured/ffmpeg', 100, new AbortController().signal)).rejects.toBe(failure)
  expect(mocks.execute).toHaveBeenCalledTimes(1)
})

it('keeps cancellation distinct from a negative track verdict and removes the snapshot', async () => {
  mocks.download.mockResolvedValue({ bytes: Buffer.from('snapshot'), sha256: 'media-digest' })
  const controller = new AbortController()
  const failure = new Error('review stopped')
  let snapshot = ''
  mocks.execute.mockImplementation((_command, args, _options, callback) => {
    snapshot = args[args.indexOf('-i') + 1] ?? ''
    controller.abort(failure)
    callback(Object.assign(new Error('decoder stopped'), { code: 1 }), '', '')
  })
  await expect(checkVideoMedia('https://media.example/result.mp4', '/configured/ffmpeg', 100, controller.signal)).rejects.toBe(failure)
  await expect(access(dirname(snapshot))).rejects.toMatchObject({ code: 'ENOENT' })
})
