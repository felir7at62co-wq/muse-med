/** Media analysis and batch publication behavior. */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MediaCommandError,
  createMediaToolkit,
  createSubprocessChannel,
  publishNoClobber,
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

describe('createSubprocessChannel', () => {
  it('rejects cancellation even when the terminated process exits zero', async () => {
    const controller = new AbortController()
    const reader = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
    const subprocess = {
      resolveExecutable: async () => 'ffmpeg',
      spawn: () => {
        controller.abort(new Error('cancelled after termination'))
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: { stdout: reader, stderr: reader },
        }
      },
    } as unknown as SubprocessRuntime
    const channel = createSubprocessChannel(subprocess, process.cwd(), 1_000, 100, 1_024)
    await expect(channel.run('ffmpeg', [], controller.signal)).rejects.toThrow('cancelled after termination')
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
