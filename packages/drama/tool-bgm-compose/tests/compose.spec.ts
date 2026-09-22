/** End-to-end preview, compose, verify, and failure cleanup over an injected process channel. */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runDramaBgm, type DramaBgmSettings } from '../src/compose.ts'
import type { ProcessChannel, ProcessOutcome } from '../src/types.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (path) => { await rm(path, { recursive: true, force: true }) }))
})

interface Fixture {
  readonly project: string
  readonly timeline: string
  readonly plan: string
  readonly output: string
  readonly report: string
}

async function fixture(): Promise<Fixture> {
  const project = await mkdtemp(join(tmpdir(), 'dsh-bgm-compose-run-'))
  temporary.push(project)
  await mkdir(join(project, 'editing'), { recursive: true })
  await mkdir(join(project, 'music'), { recursive: true })
  const sources = ['light.mp3', 'romance.mp3', 'conflict.mp3']
  for (const source of sources) await writeFile(join(project, 'music', source), source)
  const timeline = join(project, 'editing', '05-timeline.json')
  await writeFile(timeline, JSON.stringify({ body_end: 58.508, clips: [] }))
  const plan = join(project, 'editing', 'bgm-plan.json')
  await writeFile(plan, JSON.stringify({
    version: 1,
    episodes: [{
      episode: '05', body_duration_seconds: 58.508, crossfade_seconds: 1.5,
      segments: [
        { track: '轻松', source: 'music/light.mp3', start_seconds: 0, end_seconds: 26.5,
          source_start_seconds: 1.5, reason: '入场', valence: 7.2, arousal: 4.1 },
        { track: '暧昧', source: 'music/romance.mp3', start_seconds: 26.5, end_seconds: 35.5,
          reason: '关系升温', valence: 6.8, arousal: 3.8 },
        { track: '挑衅', source: 'music/conflict.mp3', start_seconds: 35.5, end_seconds: 58.508,
          source_start_seconds: 2.25, reason: '正面冲突', valence: 2.4, arousal: 7.9 },
      ],
    }],
  }))
  return {
    project, timeline, plan,
    output: join(project, 'audio', 'bgm', '05.wav'),
    report: join(project, 'audio', 'bgm', '05.generation.json'),
  }
}

function processChannel(options: { failCompose?: boolean; wrongCodec?: boolean; wrongFormat?: boolean } = {}): ProcessChannel {
  return {
    run: async (command, args): Promise<ProcessOutcome> => {
      if (command === 'ffprobe') {
        const target = args[args.length - 1] ?? ''
        const generated = target.endsWith('.wav') || basename(target).startsWith('.05-')
        return {
          code: 0,
          stdout: JSON.stringify({
            format: { format_name: generated && !options.wrongFormat ? 'wav' : 'mp3',
              duration: generated ? '58.508' : '120.000', size: generated ? '11233614' : '1000', bit_rate: '1536000' },
            streams: [{ codec_type: 'audio', codec_name: generated && !options.wrongCodec ? 'pcm_s16le' : 'mp3',
              sample_rate: generated ? '48000' : '44100', channels: 2 }],
          }),
          stderr: '',
        }
      }
      if (args.includes('silencedetect=noise=-45dB:d=0.08')) {
        return { code: 0, stdout: '', stderr: 'silence_start: 0\nsilence_end: 2.157914 | silence_duration: 2.157914\n' }
      }
      if (args.includes('volumedetect')) {
        const source = args[args.indexOf('-i') + 1] ?? ''
        const mean = source.includes('light') ? -14.5 : source.includes('romance') ? -10.7 : -21.2
        return { code: 0, stdout: '', stderr: `mean_volume: ${String(mean)} dB\n` }
      }
      if (options.failCompose) return { code: 7, stdout: '', stderr: 'filter failed' }
      const output = args[args.length - 1]
      if (output === undefined) throw new Error('missing output')
      await mkdir(join(output, '..'), { recursive: true }).catch(() => {})
      await writeFile(output, 'generated wav')
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

function settings(channel: ProcessChannel): DramaBgmSettings {
  return { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', channel }
}

describe('runDramaBgm', () => {
  it('names a missing project control file instead of exposing a raw stat failure', async () => {
    const files = await fixture()
    await rm(files.timeline)
    await expect(runDramaBgm({
      method: 'preview', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan,
    }, settings(processChannel()))).rejects.toThrow('时间线不存在')
  })

  it('previews starts, source-window gains, reasons, and matcher measurements without publishing files', async () => {
    const files = await fixture()
    const report = await runDramaBgm({
      method: 'preview', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan,
    }, settings(processChannel()))
    expect(report.method).toBe('preview')
    expect(report.segments.map(segment => [segment.source_start_kind, segment.source_start_seconds,
      segment.source_mean_db, segment.applied_gain_db])).toEqual([
      ['explicit', 1.5, -14.5, -3],
      ['onset', 3.157914, -10.7, -6.8],
      ['explicit', 2.25, -21.2, 3.7],
    ])
    expect(report.segments[1]).toMatchObject({ reason: '关系升温', valence: 6.8, arousal: 3.8 })
    await expect(stat(files.output)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(files.report)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('publishes a verified WAV and JSON report only after the complete batch succeeds', async () => {
    const files = await fixture()
    const report = await runDramaBgm({
      method: 'compose', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan,
    }, settings(processChannel()))
    expect(report.media).toMatchObject({ codec: 'pcm_s16le', sample_rate: 48000, channels: 2, duration_seconds: 58.508 })
    await expect(readFile(files.output, 'utf8')).resolves.toBe('generated wav')
    const persisted = JSON.parse(await readFile(files.report, 'utf8')) as Record<string, unknown>
    expect(persisted).toMatchObject({ method: 'compose', episode: '05', output: files.output })
    expect(await readdir(join(files.project, 'audio', 'bgm'))).toEqual(['05.generation.json', '05.wav'])
  })

  it('leaves no output, report, or temporary file when FFmpeg fails', async () => {
    const files = await fixture()
    await expect(runDramaBgm({
      method: 'compose', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan,
    }, settings(processChannel({ failCompose: true })))).rejects.toThrow('filter failed')
    await expect(stat(files.output)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(files.report)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(files.project, 'audio', 'bgm'))).resolves.toEqual([])
  })

  it('rejects an output directory whose junction escapes the project', async () => {
    const files = await fixture()
    const external = await mkdtemp(join(tmpdir(), 'dsh-bgm-compose-outside-'))
    temporary.push(external)
    await symlink(external, join(files.project, 'escape'), 'junction')
    await expect(runDramaBgm({
      method: 'compose', project: files.project, episode: 5, timeline: files.timeline,
      plan: files.plan, output: 'escape/05.wav',
    }, settings(processChannel()))).rejects.toThrow('项目目录')
    await expect(readdir(external)).resolves.toEqual([])
  })

  it('refuses to publish a generated file that fails the WAV specification', async () => {
    const files = await fixture()
    await expect(runDramaBgm({
      method: 'compose', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan,
    }, settings(processChannel({ wrongCodec: true })))).rejects.toThrow('pcm_s16le')
    await expect(stat(files.output)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(files.report)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a non-WAV container even when the audio stream matches', async () => {
    const files = await fixture()
    await expect(runDramaBgm({
      method: 'compose', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan,
    }, settings(processChannel({ wrongFormat: true })))).rejects.toThrow('WAV')
    await expect(stat(files.output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not publish when cancellation arrives after the final probe', async () => {
    const files = await fixture()
    const controller = new AbortController()
    const base = processChannel()
    const channel: ProcessChannel = {
      run: async (command, args, signal) => {
        const outcome = await base.run(command, args, signal)
        if (command === 'ffprobe' && basename(args[args.length - 1] ?? '').startsWith('.05-')) {
          controller.abort(new Error('cancelled before publish'))
        }
        return outcome
      },
    }
    await expect(runDramaBgm({
      method: 'compose', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan,
    }, { ...settings(channel), signal: controller.signal })).rejects.toThrow('cancelled before publish')
    await expect(stat(files.output)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(files.report)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(files.project, 'audio', 'bgm'))).resolves.toEqual([])
  })

  it('verifies an existing bed without source files or rewriting', async () => {
    const files = await fixture()
    await mkdir(join(files.project, 'audio', 'bgm'), { recursive: true })
    await writeFile(files.output, 'existing wav')
    await rm(join(files.project, 'music'), { recursive: true })
    const before = await stat(files.output)
    const report = await runDramaBgm({
      method: 'verify', project: files.project, episode: 5, timeline: files.timeline,
      plan: files.plan, output: files.output,
    }, settings(processChannel()))
    expect(report).toMatchObject({ method: 'verify', segments: [] })
    expect((await stat(files.output)).mtimeMs).toBe(before.mtimeMs)
    await expect(stat(files.report)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
