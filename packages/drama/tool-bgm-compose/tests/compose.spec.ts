/** End-to-end preview, compose, verify, and failure cleanup over an injected process channel. */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  // The cuts at 26.5s and 35.5s are package boundaries, which the batch gate checks.
  await writeFile(timeline, JSON.stringify({
    body_end: 58.508,
    clips: [
      { shot: 1, start_us: 0, duration_us: 8_000_000 },
      { shot: 2, start_us: 8_000_000, duration_us: 18_500_000 },
      { shot: 3, start_us: 26_500_000, duration_us: 9_000_000 },
      { shot: 4, start_us: 35_500_000, duration_us: 23_008_000 },
    ],
  }))
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

  it('composes a plan that breaks the reuse rules and reports what to change instead of blocking', async () => {
    const files = await fixture()
    // One track for the whole episode, and a cut that is not a package boundary.
    await writeFile(files.plan, JSON.stringify({ episodes: [{
      episode: '05', body_duration_seconds: 58.508, crossfade_seconds: 1.5,
      segments: [
        { track: '轻松', source: 'music/light.mp3', start_seconds: 0, end_seconds: 26.6, reason: '入场' },
        { track: '轻松', source: 'music/light.mp3', start_seconds: 26.6, end_seconds: 58.508, reason: '继续' },
      ],
    }] }))
    const report = await runDramaBgm({
      method: 'compose', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan,
    }, settings(processChannel()))
    expect(report.policy_findings.map(finding => finding.rule)).toEqual(['R1', 'R2', 'R5'])
    expect(report.policy_findings.every(finding => finding.fix !== '')).toBe(true)
    expect(report.batch_episodes).toEqual(['05'])
    // The call still produced the bed: the rules guide the agent, they do not stop it.
    await expect(readFile(files.output, 'utf8')).resolves.toBe('generated wav')
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

  it('names the default output when verify has no explicit WAV path', async () => {
    const files = await fixture()
    await expect(runDramaBgm({ method: 'verify', project: files.project, episode: 5,
      timeline: files.timeline, plan: files.plan }, settings(processChannel()))).rejects.toThrow('audio/bgm/05.wav')
  })

  it.each(['empty', 'directory', 'not-directory'] as const)('rejects a %s control file before media analysis', async (kind) => {
    const files = await fixture()
    if (kind === 'empty') await writeFile(files.timeline, '')
    if (kind === 'directory') { await rm(files.timeline); await mkdir(files.timeline) }
    const timeline = kind === 'not-directory' ? join(files.timeline, 'child.json') : files.timeline
    if (kind === 'not-directory') {
      await expect(stat(timeline)).rejects.toMatchObject({ code: process.platform === 'win32' ? 'ENOENT' : 'ENOTDIR' })
    }
    const run = vi.fn(async () => { throw new Error('Media analysis must not admit a refused control file') })
    const operation = runDramaBgm({ method: 'preview', project: files.project, episode: 5, timeline, plan: files.plan }, settings({ run }))
    if (kind === 'not-directory') {
      if (process.platform === 'win32') {
        await expect(operation).rejects.toMatchObject({ message: `时间线不存在：${timeline}` })
        await expect(operation).rejects.toHaveProperty('cause.code', 'ENOENT')
      } else await expect(operation).rejects.toMatchObject({ code: 'ENOTDIR' })
    } else await expect(operation).rejects.toThrow('不是非空文件')
    expect(run).not.toHaveBeenCalled()
  })

  it.each(['{', 'null', '{"body_end":0}', '{"body_end":"invalid"}'])('rejects unreadable or invalid timeline %s', async (document) => {
    const files = await fixture()
    await writeFile(files.timeline, document)
    await expect(runDramaBgm({ method: 'preview', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan },
      settings(processChannel()))).rejects.toThrow(document === '{' ? '时间线不可读' : 'body_end')
  })

  it('reports absent package boundaries and ignores unrelated directory entries in the plan batch', async () => {
    const files = await fixture()
    await writeFile(files.timeline, JSON.stringify({ body_end: 58.508, clips: 'unmeasured' }))
    await mkdir(join(files.project, 'editing', 'archive.json'))
    await writeFile(join(files.project, 'editing', 'notes.txt'), 'unrelated text')
    await writeFile(join(files.project, 'editing', 'scalar.json'), '3')
    await writeFile(join(files.project, 'editing', 'null.json'), 'null')
    const report = await runDramaBgm({ method: 'preview', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan },
      settings(processChannel()))
    expect(report.policy_findings.some(finding => finding.rule === 'R5')).toBe(true)
    expect(report.batch_episodes).toEqual(['05'])
  })

  it.each(['malformed', 'duplicate', 'invalid-id', 'missing'] as const)('rejects a %s selected episode plan', async (kind) => {
    const files = await fixture()
    const document = JSON.parse(await readFile(files.plan, 'utf8')) as { episodes: { episode: string }[] }
    const selected = document.episodes[0]
    if (selected === undefined) throw new Error('missing selected plan')
    if (kind === 'duplicate') document.episodes.push({ ...selected, episode: '5' })
    if (kind === 'invalid-id') selected.episode = 'unknown'
    if (kind === 'missing') selected.episode = '06'
    await writeFile(files.plan, kind === 'malformed' ? '{' : JSON.stringify(document))
    await expect(runDramaBgm({ method: 'preview', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan },
      settings(processChannel()))).rejects.toThrow(kind === 'missing' ? '缺少第 05 集' : kind === 'malformed' ? '计划不可读' : '集号重复或无效')
  })

  it.each(['json', 'fields'] as const)('rejects a sibling plan with unreadable %s before publishing', async (kind) => {
    const files = await fixture()
    await writeFile(join(files.project, 'editing', '06.json'), kind === 'json' ? '{' : '{"episodes":[{}]}')
    await expect(runDramaBgm({ method: 'compose', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan },
      settings(processChannel()))).rejects.toThrow(kind === 'json' ? '不是可读的 JSON' : '不是合法的 BGM 计划')
    await expect(stat(files.output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains absolute source paths and repeated ordered source sequences in preview evidence', async () => {
    const files = await fixture()
    const document = JSON.parse(await readFile(files.plan, 'utf8')) as {
      episodes: { episode: string; segments: { source: string; source_sha256?: string; valence?: number; arousal?: number }[] }[]
    }
    const selected = document.episodes[0]
    if (selected === undefined) throw new Error('missing selected plan')
    for (const segment of selected.segments) {
      segment.source = join(files.project, segment.source)
      segment.source_sha256 = 'sha256:' + createHash('sha256').update(await readFile(segment.source)).digest('hex').toUpperCase()
      delete segment.valence
      delete segment.arousal
    }
    document.episodes.push({ ...selected, episode: '06' })
    await writeFile(files.plan, JSON.stringify(document))
    const report = await runDramaBgm({ method: 'preview', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan },
      settings(processChannel()))
    expect(report.repeated_sequence_episodes).toEqual(['06'])
    expect(report.segments.every(segment => segment.source.startsWith(files.project))).toBe(true)
    expect(report.segments[0]).not.toHaveProperty('valence')
    expect(report.segments[0]).not.toHaveProperty('arousal')
  })

  it('refuses source digest drift before publishing', async () => {
    const files = await fixture()
    const document = JSON.parse(await readFile(files.plan, 'utf8')) as { episodes: { segments: { source_sha256?: string }[] }[] }
    const segment = document.episodes[0]?.segments[0]
    if (segment === undefined) throw new Error('missing first segment')
    segment.source_sha256 = '0'.repeat(64)
    await writeFile(files.plan, JSON.stringify(document))
    await expect(runDramaBgm({ method: 'compose', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan },
      settings(processChannel()))).rejects.toThrow('源曲摘要已变化')
    await expect(stat(files.output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a source window longer than its probed media', async () => {
    const files = await fixture()
    const base = processChannel()
    const channel: ProcessChannel = { run: async (command, args, signal) => {
      const outcome = await base.run(command, args, signal)
      if (command !== 'ffprobe') return outcome
      const document = JSON.parse(outcome.stdout) as { format: { duration: string } }
      document.format.duration = '3'
      return { ...outcome, stdout: JSON.stringify(document) }
    } }
    await expect(runDramaBgm({ method: 'compose', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan },
      settings(channel))).rejects.toThrow('源曲不足以覆盖')
  })

  it.each(['output', 'report'] as const)('retains an existing %s instead of replacing it', async (kind) => {
    const files = await fixture()
    await mkdir(join(files.project, 'audio', 'bgm'), { recursive: true })
    const retained = kind === 'output' ? files.output : files.report
    await writeFile(retained, 'user delivery')
    await expect(runDramaBgm({ method: 'compose', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan },
      settings(processChannel()))).rejects.toThrow('已存在，不会覆盖')
    expect(await readFile(retained, 'utf8')).toBe('user delivery')
  })

  it('requires a WAV output extension and a positive safe episode number', async () => {
    const files = await fixture()
    const args = { method: 'preview' as const, project: files.project, episode: 5, timeline: files.timeline, plan: files.plan }
    await expect(runDramaBgm({ ...args, output: 'audio/bgm/05.mp3' }, settings(processChannel()))).rejects.toThrow('.wav 扩展名')
    await expect(runDramaBgm({ ...args, episode: 0 }, settings(processChannel()))).rejects.toThrow('正安全整数')
  })

  it.each(['sample_rate', 'channels', 'duration'] as const)('rejects generated %s drift and removes temporary files', async (field) => {
    const files = await fixture()
    const base = processChannel()
    const channel: ProcessChannel = { run: async (command, args, signal) => {
      const outcome = await base.run(command, args, signal)
      if (command !== 'ffprobe' || !basename(args[args.length - 1] ?? '').startsWith('.05-')) return outcome
      const document = JSON.parse(outcome.stdout) as { format: { duration: string }; streams: { sample_rate: string; channels: number }[] }
      const audio = document.streams[0]
      if (audio === undefined) throw new Error('missing generated stream')
      if (field === 'sample_rate') audio.sample_rate = '44100'
      if (field === 'channels') audio.channels = 1
      if (field === 'duration') document.format.duration = '58.6'
      return { ...outcome, stdout: JSON.stringify(document) }
    } }
    await expect(runDramaBgm({ method: 'compose', project: files.project, episode: 5, timeline: files.timeline, plan: files.plan },
      settings(channel))).rejects.toThrow('48kHz、双声道')
    expect(await readdir(join(files.project, 'audio', 'bgm'))).toEqual([])
  })
})
