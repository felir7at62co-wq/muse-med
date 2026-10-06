/** Media analysis and batch publication behavior. */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MediaCommandError,
  createMediaToolkit,
  createSubprocessChannel,
  publishNoClobber,
  probeAudio,
  type ProcessChannel,
} from '../src/media.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (path) => { await rm(path, { recursive: true, force: true }) }))
})

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-bgm-compose-'))
  temporary.push(path)
  return path
}

describe('createMediaToolkit', () => {
  it.each(['mean_volume: -inf dB', 'decoder supplied no volume measurement'])('refuses a source with unusable mean volume (%s)', async (stderr) => {
    const channel: ProcessChannel = { run: async () => ({ code: 0, stdout: '', stderr }) }
    await expect(createMediaToolkit('ffmpeg', 'ffprobe', channel).meanVolume('silent.mp3', 1, 10))
      .rejects.toThrow('无法测量')
  })

  it('refuses an onset that begins at the end of the analyzed window', async () => {
    const channel: ProcessChannel = { run: async () => ({ code: 0, stdout: '', stderr: 'silence_start: 0\nsilence_end: 4\n' }) }
    await expect(createMediaToolkit('ffmpeg', 'ffprobe', channel).detectSourceStart('silent.mp3')).rejects.toThrow('没有可用起音')
  })
  it('uses the first audible onset in the one-to-five-second window', async () => {
    const calls: { command: string; args: readonly string[] }[] = []
    const channel: ProcessChannel = {
      run: async (command, args) => {
        calls.push({ command, args })
        return { code: 0, stdout: '', stderr: '[silencedetect] silence_start: 0\n[silencedetect] silence_end: 0.927256 | silence_duration: 0.927256\n' }
      },
    }
    const media = createMediaToolkit('ffmpeg', 'ffprobe', channel)
    await expect(media.detectSourceStart('music.mp3')).resolves.toEqual({ seconds: 1.927256, kind: 'onset' })
    expect(calls[0]?.args).toContain('silencedetect=noise=-45dB:d=0.08')
  })

  it('starts at one second when the window is already audible', async () => {
    const channel: ProcessChannel = { run: async () => ({ code: 0, stdout: '', stderr: '' }) }
    await expect(createMediaToolkit('ffmpeg', 'ffprobe', channel).detectSourceStart('music.mp3'))
      .resolves.toEqual({ seconds: 1, kind: 'onset' })
  })

  it('does not mistake a later silent break for the first audible onset', async () => {
    const channel: ProcessChannel = { run: async () => ({
      code: 0,
      stdout: '',
      stderr: 'silence_start: 1.000000\nsilence_end: 2.000021 | silence_duration: 1.000021\n',
    }) }
    await expect(createMediaToolkit('ffmpeg', 'ffprobe', channel).detectSourceStart('music.mp3'))
      .resolves.toEqual({ seconds: 1, kind: 'onset' })
  })

  it('fails closed when the complete onset window is silent', async () => {
    const channel: ProcessChannel = { run: async () => ({ code: 0, stdout: '', stderr: 'silence_start: 0\n' }) }
    await expect(createMediaToolkit('ffmpeg', 'ffprobe', channel).detectSourceStart('music.mp3'))
      .rejects.toThrow('没有可用起音')
  })

  it('parses mean volume and rejects failed FFmpeg commands', async () => {
    const channel: ProcessChannel = {
      run: async (_command, args) => args.includes('volumedetect')
        ? { code: 0, stdout: '', stderr: '[Parsed_volumedetect] mean_volume: -21.2 dB\n' }
        : { code: 9, stdout: '', stderr: 'decoder failed' },
    }
    const media = createMediaToolkit('ffmpeg', 'ffprobe', channel)
    await expect(media.meanVolume('music.mp3', 1, 10)).resolves.toBe(-21.2)
    await expect(media.detectSourceStart('broken.mp3')).rejects.toBeInstanceOf(MediaCommandError)
  })
})

describe('probeAudio', () => {
  it.each([
    ['not-json', '无效 JSON'], ['null', '缺少媒体信息'], ['{}', '缺少媒体信息'],
    [JSON.stringify({ streams: [null, { codec_type: 'video' }], format: {} }), '没有音频流'],
    [JSON.stringify({ streams: [{ codec_type: 'audio' }], format: {} }), '音频信息不完整'],
  ])('rejects an unusable provider document (%s)', async (stdout, message) => {
    const channel: ProcessChannel = { run: async () => ({ code: 0, stdout, stderr: '' }) }
    await expect(probeAudio('ffprobe', channel, 'audio.mp3')).rejects.toThrow(message)
  })

  it('retains a failed probe diagnostic', async () => {
    const channel: ProcessChannel = { run: async () => ({ code: 2, stdout: '', stderr: 'file not readable' }) }
    await expect(probeAudio('ffprobe', channel, 'audio.mp3')).rejects.toMatchObject({ code: 2, stderr: 'file not readable' })
  })
})

describe('createSubprocessChannel', () => {
  it.each(['missing', 'stdout-loss', 'stderr-loss', 'signal'] as const)('reports provider %s streams or termination without accepting incomplete output', async (kind) => {
    const reader = (lossy: boolean) => ({ readFrom: () => ({ text: 'diagnostic', nextOffset: 10, lossy }) })
    class OutputRuntime extends SubprocessRuntime {
      resolveExecutable = async () => 'ffmpeg'
      terminalEnvironment(): never { throw new Error('Unexpected terminal inspection') }
      spawnTerminal(): never { throw new Error('Unexpected terminal allocation') }
      spawn(): SubprocessHandle {
        return { done: Promise.resolve({ exitCode: null, signal: 'SIGTERM' }),
          collected: { ...kind === 'missing' ? {} : { stdout: reader(kind === 'stdout-loss') }, stderr: reader(kind === 'stderr-loss') },
          stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
          terminate() {}, waitForExit: async () => true }
      }
    }
    const ctx = new Context()
    try {
      const channel = createSubprocessChannel(new OutputRuntime(ctx), process.cwd(), 1_000, 100, 1_024)
      if (kind === 'signal') expect(await channel.run('ffmpeg', [])).toEqual({ code: 127, stdout: 'diagnostic', stderr: 'diagnostic\nterminated by SIGTERM' })
      else await expect(channel.run('ffmpeg', [])).rejects.toThrow(kind === 'missing' ? '没有返回可收集的输出流' : '超过收集上限')
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects cancellation even when the terminated process exits zero', async () => {
    const controller = new AbortController()
    const reader = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
    class CancelledRuntime extends SubprocessRuntime {
      resolveExecutable = async () => 'ffmpeg'
      terminalEnvironment(): never { throw new Error('Unexpected terminal inspection') }
      spawnTerminal(): never { throw new Error('Unexpected terminal allocation') }
      spawn(): SubprocessHandle {
        controller.abort(new Error('cancelled after termination'))
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: { stdout: reader, stderr: reader },
          stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
          terminate() {}, waitForExit: async () => true,
        }
      }
    }
    const ctx = new Context()
    try {
      const channel = createSubprocessChannel(new CancelledRuntime(ctx), process.cwd(), 1_000, 100, 1_024)
      await expect(channel.run('ffmpeg', [], controller.signal)).rejects.toThrow('cancelled after termination')
    } finally { await ctx.fiber.dispose() }
  })
})

describe('publishNoClobber', () => {
  it('rolls back earlier links when any destination already exists', async () => {
    const root = await tempDirectory()
    const firstTemp = join(root, '.first.tmp')
    const secondTemp = join(root, '.second.tmp')
    const firstFinal = join(root, 'first.wav')
    const secondFinal = join(root, 'second.json')
    await writeFile(firstTemp, 'first')
    await writeFile(secondTemp, 'second')
    await writeFile(secondFinal, 'existing')
    await expect(publishNoClobber([[firstTemp, firstFinal], [secondTemp, secondFinal]])).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(stat(firstFinal)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(secondFinal, 'utf8')).resolves.toBe('existing')
    await expect(readFile(firstTemp, 'utf8')).resolves.toBe('first')
    await expect(readFile(secondTemp, 'utf8')).resolves.toBe('second')
  })

  it('publishes every staged file and removes the temporary names', async () => {
    const root = await tempDirectory()
    const nested = join(root, 'audio', 'bgm')
    await mkdir(nested, { recursive: true })
    const wavTemp = join(nested, '.05.wav.tmp')
    const reportTemp = join(nested, '.05.json.tmp')
    const wav = join(nested, '05.wav')
    const report = join(nested, '05.json')
    await writeFile(wavTemp, 'wav')
    await writeFile(reportTemp, 'report')
    await publishNoClobber([[wavTemp, wav], [reportTemp, report]])
    await expect(readFile(wav, 'utf8')).resolves.toBe('wav')
    await expect(readFile(report, 'utf8')).resolves.toBe('report')
    await expect(stat(wavTemp)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(reportTemp)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(dirname(wav)).toBe(nested)
  })
})
