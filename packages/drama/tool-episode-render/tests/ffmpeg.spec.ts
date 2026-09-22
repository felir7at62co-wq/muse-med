/** The external-process edge: the spawn channel, the two ffmpeg wrappers, and ffprobe parsing. */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  captureFfmpeg,
  createFileCaptureChannel,
  createMediaToolkit,
  createSpawnChannel,
  describeCommand,
  escapeFilterPath,
  exitCodeOf,
  firstStreamOfType,
  frameRateOf,
  MediaCommandError,
  probeMedia,
  runFfmpeg,
} from '../src/ffmpeg.ts'
import type { ProcessChannel } from '../src/types.ts'
import { probeHandler, probeJson, stubChannel, type StubHandler } from './harness.ts'

/** Build a toolkit over a stub channel. */
function toolkit(handlers: readonly StubHandler[]) {
  return createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stubChannel(handlers).channel })
}

describe('describeCommand', () => {
  it('joins the executable and its arguments with single spaces', () => {
    expect(describeCommand('ffmpeg', ['-y', '-i', 'a b.mp4'])).toBe('ffmpeg -y -i a b.mp4')
  })
})

describe('exitCodeOf', () => {
  it('keeps the code a process reported', () => {
    expect(exitCodeOf(3)).toBe(3)
  })

  it('reports a process that ended without a code as 127', () => {
    expect(exitCodeOf(null)).toBe(127)
  })
})

describe('runFfmpeg', () => {
  it('resolves when the command succeeds', async () => {
    const channel = stubChannel([() => ({})])
    await expect(runFfmpeg(createMediaToolkit({ ffmpeg: 'f', ffprobe: 'p', channel: channel.channel }),
      ['-y'])).resolves.toBeUndefined()
    expect(channel.calls[0]).toEqual({ command: 'f', args: ['-y'] })
  })

  it('throws a MediaCommandError naming the command, the exit code, and stderr', async () => {
    const toolkitStub = toolkit([() => ({ code: 2, stderr: 'Invalid argument' })])
    const error = await runFfmpeg(toolkitStub, ['-y', '-i', 'x.mp4']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MediaCommandError)
    const failure = error as MediaCommandError
    expect(failure.name).toBe('MediaCommandError')
    expect(failure.code).toBe(2)
    expect(failure.command).toBe('ffmpeg')
    expect(failure.args).toEqual(['-y', '-i', 'x.mp4'])
    expect(failure.stderr).toBe('Invalid argument')
    expect(failure.message).toContain('ffmpeg -y -i x.mp4 退出码 2')
    expect(failure.message).toContain('Invalid argument')
  })
})

describe('captureFfmpeg', () => {
  it('returns the outcome without judging the exit code', async () => {
    const outcome = await captureFfmpeg(toolkit([() => ({ code: 9, stdout: 'out', stderr: 'err' })]), ['-x'])
    expect(outcome).toEqual({ code: 9, stdout: 'out', stderr: 'err' })
  })
})

describe('createSpawnChannel', () => {
  const node = process.execPath

  it('captures standard output from a real process', async () => {
    const outcome = await createSpawnChannel().run(node, ['-e', 'process.stdout.write(String(1+1))'])
    expect(outcome).toEqual({ code: 0, stdout: '2', stderr: '' })
  })

  it('reports a non-zero exit with the captured standard error', async () => {
    const outcome = await createSpawnChannel().run(node, ['-e', 'process.stderr.write(String(7));process.exit(3)'])
    expect(outcome.code).toBe(3)
    expect(outcome.stderr).toBe('7')
  })

  it('reports a missing executable as exit code 127 with the spawn error', async () => {
    const missing = join(tmpdir(), 'drama-render-no-such-binary-9f27')
    const outcome = await createSpawnChannel().run(missing, [])
    expect(outcome.code).toBe(127)
    expect(outcome.stderr.length).toBeGreaterThan(0)
  })
})

describe('createFileCaptureChannel', () => {
  const node = process.execPath

  it('captures standard output and error through files', async () => {
    const outcome = await createFileCaptureChannel().run(node, [
      '-e', "process.stdout.write('out');process.stderr.write('err')",
    ])
    expect(outcome).toEqual({ code: 0, stdout: 'out', stderr: 'err' })
  })

  it('preserves an ordinary non-zero exit and its stderr', async () => {
    const outcome = await createFileCaptureChannel().run(node, [
      '-e', "process.stderr.write('bad');process.exit(6)",
    ])
    expect(outcome).toEqual({ code: 6, stdout: '', stderr: 'bad' })
  })

  it('reports a missing executable as exit code 127', async () => {
    const missing = join(tmpdir(), 'drama-render-file-channel-no-such-binary-9f27')
    const outcome = await createFileCaptureChannel().run(missing, [])
    expect(outcome.code).toBe(127)
    expect(outcome.stderr.length).toBeGreaterThan(0)
  })

  it('removes its temporary directory after success and failure', async () => {
    const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('dsh-drama-render-')))
    await createFileCaptureChannel().run(node, ['-e', 'process.exit(0)'])
    await createFileCaptureChannel().run(node, ['-e', 'process.exit(4)'])
    const after = (await readdir(tmpdir())).filter(name => name.startsWith('dsh-drama-render-'))
    expect(after.filter(name => !before.has(name))).toEqual([])
  })
})

describe('createMediaToolkit', () => {
  it('uses the file-capture channel when none is injected', () => {
    const built = createMediaToolkit({ ffmpeg: 'f', ffprobe: 'p' })
    expect(built.ffmpeg).toBe('f')
    expect(built.ffprobe).toBe('p')
    expect(built.channel).toBeDefined()
  })

  it('keeps an injected channel', () => {
    const channel: ProcessChannel = { run: async () => ({ code: 0, stdout: '', stderr: '' }) }
    expect(createMediaToolkit({ ffmpeg: 'f', ffprobe: 'p', channel }).channel).toBe(channel)
  })
})

describe('probeMedia', () => {
  it('reads streams and container facts, tolerating string and number fields', async () => {
    const file = 'C:/proj/video/02/shot_001.mp4'
    const media = await probeMedia(toolkit([
      () => ({
        stdout: JSON.stringify({
          streams: [
            { codec_type: 'video', codec_name: 'h264', width: 1440, height: '2560', avg_frame_rate: '60/1' },
            { codec_type: 'audio', codec_name: 'aac', sample_rate: 48000, channels: 2 },
            { codec_type: 'data', codec_name: 'bin_data', width: 'not-a-number' },
          ],
          format: { duration: 114.733332, size: '123', bit_rate: 8_000_000 },
        }),
      }),
    ]), file)
    expect(media.durationSeconds).toBe(114.733332)
    expect(media.sizeBytes).toBe(123)
    expect(media.bitRateBps).toBe(8_000_000)
    expect(media.streams).toHaveLength(3)
    expect(media.streams[0]).toEqual({
      codecType: 'video', codecName: 'h264', width: 1440, height: 2560, avgFrameRate: '60/1',
    })
    expect(media.streams[1]).toEqual({
      codecType: 'audio', codecName: 'aac', sampleRate: 48000, channels: 2,
    })
    expect(media.streams[2]).toEqual({ codecType: 'data', codecName: 'bin_data' })
  })

  it('reports an absent format block as zeroes', async () => {
    const media = await probeMedia(toolkit([() => ({ stdout: JSON.stringify({ streams: [] }) })]), 'x.mp4')
    expect(media).toEqual({ streams: [], durationSeconds: 0, sizeBytes: 0, bitRateBps: 0 })
  })

  it('throws a MediaCommandError when ffprobe exits non-zero', async () => {
    const error = await probeMedia(toolkit([() => ({ code: 1, stderr: 'No such file' })]), 'x.mp4')
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MediaCommandError)
    expect((error as MediaCommandError).message).toContain('No such file')
  })

  it('fails loud when the report is not JSON', async () => {
    await expect(probeMedia(toolkit([() => ({ stdout: 'not json' })]), 'x.mp4'))
      .rejects.toThrow('没有返回 JSON')
  })

  it('fails loud when the report carries no streams array', async () => {
    await expect(probeMedia(toolkit([() => ({ stdout: '{"format":{}}' })]), 'x.mp4'))
      .rejects.toThrow('没有 streams 数组')
  })

  it('fails loud when the report is not an object at all', async () => {
    await expect(probeMedia(toolkit([() => ({ stdout: '"a string"' })]), 'x.mp4'))
      .rejects.toThrow('没有 streams 数组')
  })
})

describe('probeJson', () => {
  it('omits the audio stream when the spec declares none', () => {
    const document = JSON.parse(probeJson({ video: {}, audio: false })) as { streams: { codec_type: string }[] }
    expect(document.streams.map(stream => stream.codec_type)).toEqual(['video'])
  })
})

describe('firstStreamOfType', () => {
  it('finds the first stream of one type and reports an absent type', () => {
    const media = {
      streams: [{ codecType: 'video', codecName: 'h264' }, { codecType: 'audio', codecName: 'aac' }],
      durationSeconds: 0,
      sizeBytes: 0,
      bitRateBps: 0,
    }
    expect(firstStreamOfType(media, 'audio')?.codecName).toBe('aac')
    expect(firstStreamOfType(media, 'subtitle')).toBeUndefined()
  })
})

describe('frameRateOf', () => {
  it('divides the reported rate', () => {
    expect(frameRateOf({ codecType: 'video', codecName: 'h264', avgFrameRate: '60/1' })).toBe(60)
  })

  it('falls back to the nominal rate', () => {
    expect(frameRateOf({ codecType: 'video', codecName: 'h264', rFrameRate: '30000/1001' })).toBeCloseTo(29.97, 2)
  })

  it('reports zero for an absent stream', () => {
    expect(frameRateOf(undefined)).toBe(0)
  })

  it('reports zero when no rate field is present', () => {
    expect(frameRateOf({ codecType: 'video', codecName: 'h264' })).toBe(0)
  })

  it('reports zero for a zero denominator', () => {
    expect(frameRateOf({ codecType: 'video', codecName: 'h264', avgFrameRate: '60/0' })).toBe(0)
  })

  it('reports zero when the fields do not parse', () => {
    expect(frameRateOf({ codecType: 'video', codecName: 'h264', avgFrameRate: 'N/A' })).toBe(0)
  })
})

describe('escapeFilterPath', () => {
  it('converts a Windows path for use inside a filter argument', () => {
    expect(escapeFilterPath('C:\\Windows\\Fonts')).toBe('C\\:/Windows/Fonts')
  })

  it('leaves a POSIX path with forward slashes', () => {
    expect(escapeFilterPath('/usr/share/fonts')).toBe('/usr/share/fonts')
  })
})

describe('probeHandler', () => {
  it('answers an unregistered path like a missing file', async () => {
    const channel = stubChannel([probeHandler({})])
    const outcome = await channel.channel.run('ffprobe', ['x.mp4'])
    expect(outcome.code).toBe(1)
  })
})
