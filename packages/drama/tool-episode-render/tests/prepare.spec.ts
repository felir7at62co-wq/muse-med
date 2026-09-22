/** `prepare`: the shot manifest, the probes it validates against, and the layout it writes. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { episodePaths, episodeNumberOf, pathExists, shotFileName } from '../src/paths.ts'
import {
  cueOverrunWarnings,
  masterAudioFilter,
  parseShotManifest,
  prepareEpisode,
  resolveShots,
} from '../src/prepare.ts'
import type { SubtitleCue } from '../src/types.ts'
import { cleanup, probeHandler, sizeOf, srtDocument, stubChannel, tempProject, writePlaceholder, type StubHandler } from './harness.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (dir) => { await cleanup(dir) }))
})

/** Build a toolkit over a stub channel. */
function toolkit(handlers: readonly StubHandler[]) {
  return createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stubChannel(handlers).channel })
}

/** One cue at the given boundaries. */
function cue(index: number, endSeconds: number): SubtitleCue {
  return { index, startSeconds: endSeconds - 1, endSeconds, text: '台词' }
}

describe('parseShotManifest', () => {
  it('orders rows by shot and defaults a row\u2019s audio to its own video', () => {
    const rows = parseShotManifest({
      shots: [
        { shot: 2, video: 'media/02/p2-clean.mp4', audio: 'media/02/p2.wav' },
        { shot: 1, video: 'media/02/p1-clean.mp4' },
      ],
    }, 'shots.json')
    expect(rows).toEqual([
      { shot: 1, video: 'media/02/p1-clean.mp4', audio: 'media/02/p1-clean.mp4' },
      { shot: 2, video: 'media/02/p2-clean.mp4', audio: 'media/02/p2.wav' },
    ])
  })

  it('preserves explicit package identity but never derives it from the shot number', () => {
    const rows = parseShotManifest({ shots: [{ shot: 1, package: 3, video: 'a.mp4' }] }, 'shots.json')
    expect(rows[0]?.package).toBe(3)
    expect(() => parseShotManifest({ shots: [{ shot: 1, package: 0, video: 'a.mp4' }] }, 'shots.json')).toThrow('package')
  })

  it('rejects a document without a shots array', () => {
    expect(() => parseShotManifest({ clip: [] }, 'shots.json')).toThrow('成片清单必须是')
  })

  it('rejects a row that is not an object', () => {
    expect(() => parseShotManifest({ shots: ['a'] }, 'shots.json')).toThrow('不是对象')
  })

  it('rejects a row whose shot is not a positive integer', () => {
    expect(() => parseShotManifest({ shots: [{ shot: 0, video: 'a.mp4' }] }, 'shots.json'))
      .toThrow('shot 必须是正整数镜头号')
  })

  it('rejects a row with no video', () => {
    expect(() => parseShotManifest({ shots: [{ shot: 1, video: '  ' }] }, 'shots.json')).toThrow('缺少 video')
  })

  it('rejects a row with an unusable audio field', () => {
    expect(() => parseShotManifest({ shots: [{ shot: 1, video: 'a.mp4', audio: '' }] }, 'shots.json'))
      .toThrow('audio 不是非空字符串')
  })

  it('rejects an empty manifest', () => {
    expect(() => parseShotManifest({ shots: [] }, 'shots.json')).toThrow('没有任何镜头')
  })

  it('rejects shot numbers with a gap', () => {
    expect(() => parseShotManifest({ shots: [{ shot: 1, video: 'a.mp4' }, { shot: 3, video: 'b.mp4' }] }, 'shots.json'))
      .toThrow('收到 [1, 3]')
  })
})

describe('resolveShots', () => {
  const project = 'C:/proj'

  it('probes each source and resolves a relative path against the project root', async () => {
    const shots = await resolveShots(
      toolkit([probeHandler({ 'C:/proj/media/02/p1-clean.mp4': { durationSeconds: 5.05, video: {}, audio: {} } })]),
      project,
      [{ shot: 1, video: 'media/02/p1-clean.mp4', audio: 'media/02/p1-clean.mp4' }],
    )
    expect(shots).toEqual([{
      source: { shot: 1, video: 'media/02/p1-clean.mp4', audio: 'media/02/p1-clean.mp4' },
      video: join('C:/proj', 'media/02/p1-clean.mp4'),
      audio: join('C:/proj', 'media/02/p1-clean.mp4'),
      durationUs: 5_050_000,
    }])
  })

  it('uses a declared audio track when the video carries none', async () => {
    const shots = await resolveShots(
      toolkit([probeHandler({ 'C:/proj/media/02/p1.mp4': { durationSeconds: 5, video: {}, audio: false } })]),
      project,
      [{ shot: 1, video: 'media/02/p1.mp4', audio: 'C:/proj/media/02/p1.wav' }],
    )
    expect(shots[0]?.audio).toBe('C:/proj/media/02/p1.wav')
  })

  it('fails loud when the source is missing', async () => {
    await expect(resolveShots(toolkit([probeHandler({})]), project,
      [{ shot: 3, video: 'media/02/p3.mp4', audio: 'media/02/p3.mp4' }]))
      .rejects.toThrow('镜头 3 的成片无法探测')
  })

  it('fails loud when the source has no picture', async () => {
    await expect(resolveShots(
      toolkit([probeHandler({ 'C:/proj/media/02/p1.mp4': { video: undefined, audio: {} } })]), project,
      [{ shot: 1, video: 'media/02/p1.mp4', audio: 'media/02/p1.mp4' }]))
      .rejects.toThrow('没有视频流')
  })

  it('fails loud when the picture has no sound and none was declared', async () => {
    await expect(resolveShots(
      toolkit([probeHandler({ 'C:/proj/media/02/p1.mp4': { video: {}, audio: false } })]), project,
      [{ shot: 1, video: 'media/02/p1.mp4', audio: 'media/02/p1.mp4' }]))
      .rejects.toThrow('没有音轨')
  })

  it('fails loud when the source reports no duration', async () => {
    await expect(resolveShots(
      toolkit([probeHandler({ 'C:/proj/media/02/p1.mp4': { durationSeconds: 0, video: {}, audio: {} } })]), project,
      [{ shot: 1, video: 'media/02/p1.mp4', audio: 'media/02/p1.mp4' }]))
      .rejects.toThrow('时长为 0')
  })
})

describe('masterAudioFilter', () => {
  it('trims each shot to its own length and delays it to its own start', () => {
    expect(masterAudioFilter([
      { shot: 1, startUs: 0, durationUs: 5_050_000 },
      { shot: 2, startUs: 5_050_000, durationUs: 13_083_333 },
    ])).toBe(
      '[0:a]atrim=0:5.050000,asetpts=N/SR/TB,adelay=delays=0:all=1[a0];'
      + '[1:a]atrim=0:13.083333,asetpts=N/SR/TB,adelay=delays=5050:all=1[a1];'
      + '[a0][a1]amix=inputs=2:duration=longest:normalize=0[a]',
    )
  })
})

describe('cueOverrunWarnings', () => {
  it('warns once per cue that runs past the assembled picture', () => {
    expect(cueOverrunWarnings([cue(1, 12), cue(2, 20)], 18.133333)).toEqual([
      '字幕第 2 条结束于 20.000s，超过整集画面时长 18.133s，烧录后会被截断。'
      + '请把该条字幕的时间收到 body_end 以内后重跑 prepare。',
    ])
  })

  it('stays quiet when every cue fits', () => {
    expect(cueOverrunWarnings([cue(1, 12)], 18.133333)).toEqual([])
  })
})

describe('prepareEpisode', () => {
  it('rejects a copied banned selection before probing or changing the prepared layout, and unban restores preparation', async () => {
    const project = await tempProject()
    temporary.push(project)
    const { runDramaVideo } = await import('../src/video.ts')
    const video = join(project, 'original.mp4')
    const copy = join(project, 'copy.mp4')
    await writePlaceholder(video, 'same banned bytes')
    await writePlaceholder(copy, 'same banned bytes')
    const shotsPath = join(project, 'shots.json')
    await writePlaceholder(shotsPath, JSON.stringify({ shots: [{ shot: 1, video: 'copy.mp4' }] }))
    const subtitle = join(project, 'source.srt')
    await writePlaceholder(subtitle, '')
    const paths = episodePaths(project, '02')
    await writePlaceholder(join(paths.videoDir, 'shot_001.mp4'), 'keep previous')
    const channel = stubChannel([probeHandler({ [copy]: { durationSeconds: 1, video: {}, audio: {} } }), () => ({})])
    const input = { toolkit: createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      project, episode: '02', shotsPath, subtitleSrt: subtitle }
    await runDramaVideo({ method: 'ban', project, video, labels: ['人物对调'] })
    await expect(prepareEpisode(input)).rejects.toThrow('人物对调')
    expect(channel.calls).toEqual([])
    expect(await readFile(join(paths.videoDir, 'shot_001.mp4'), 'utf8')).toBe('keep previous')
    await runDramaVideo({ method: 'unban', project, video })
    await prepareEpisode(input)
    expect(await readFile(join(paths.videoDir, 'shot_001.mp4'), 'utf8')).toBe('same banned bytes')
  })

  it('rechecks selected bytes after probes before copying when a user bans during preparation', async () => {
    const project = await tempProject()
    temporary.push(project)
    const { runDramaVideo } = await import('../src/video.ts')
    const video = join(project, 'original.mp4')
    await writePlaceholder(video, 'banned during probe')
    const shotsPath = join(project, 'shots.json')
    await writePlaceholder(shotsPath, JSON.stringify({ shots: [{ shot: 1, video }] }))
    const probe = probeHandler({ [video]: { durationSeconds: 1, video: {}, audio: {} } })
    const channel = stubChannel([call => ({ ...probe(call), after: async () => {
      await runDramaVideo({ method: 'ban', project, video, labels: ['人物对调'] })
    } })])
    await expect(prepareEpisode({ toolkit: createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      project, episode: '02', shotsPath, subtitleSrt: 'unused.srt' })).rejects.toThrow('人物对调')
    expect(await pathExists(episodePaths(project, '02').videoDir)).toBe(false)
  })

  it('copies the shots, writes the timeline and the master, and installs the subtitle', async () => {
    const project = await tempProject()
    temporary.push(project)
    const shotsPath = join(project, 'ep02-shots.json')
    const subtitle = join(project, 'ep02-source.srt')
    await writePlaceholder(join(project, 'episode_packages', '02', 'package.json'), '{"video_tasks":[{},{}]}')
    await writeFile(shotsPath, JSON.stringify({
      shots: [
        { shot: 1, package: 2, video: 'media/p1-clean.mp4' },
        { shot: 2, video: 'media/p2-clean.mp4' },
      ],
    }), 'utf8')
    await writeFile(subtitle, srtDocument([{ start: '00:00:01,000', end: '00:00:02,000', text: '台词' }]), 'utf8')
    for (const name of ['p1-clean.mp4', 'p2-clean.mp4']) {
      await writePlaceholder(join(project, 'media', name), `bytes of ${name}`)
    }
    const paths = episodePaths(project, '02')
    const channel = stubChannel([
      probeHandler({
        [join(project, 'media', 'p1-clean.mp4')]: { durationSeconds: 5.05, video: {}, audio: {} },
        [join(project, 'media', 'p2-clean.mp4')]: { durationSeconds: 13.083333, video: {}, audio: {} },
      }),
      call => ({
        after: async () => {
          await writeFile(call.args[call.args.length - 1] ?? '', 'wav', 'utf8')
        },
      }),
    ])
    const prepared = await prepareEpisode({
      toolkit: createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      project,
      episode: '02',
      shotsPath,
      subtitleSrt: subtitle,
    })
    expect(prepared.timeline).toEqual({
      clips: [
        { shot: 1, startUs: 0, durationUs: 5_050_000 },
        { shot: 2, startUs: 5_050_000, durationUs: 13_083_333 },
      ],
      bodyEndSeconds: 18.133333,
    })
    expect(prepared.warnings).toEqual([])
    expect(prepared.written).toEqual([
      join(paths.videoDir, 'shot_001.mp4'),
      join(paths.videoDir, 'shot_002.mp4'),
      paths.timeline,
      paths.masterAudio,
      paths.subtitle,
      paths.sources,
    ])
    const selected = JSON.parse(await readFile(paths.sources, 'utf8')) as {
      shots: { shot: number; package?: number; video: string; sha256: string; package_sha256?: string }[]
    }
    expect(selected.shots[0]).toMatchObject({ shot: 1, package: 2, video: join(project, 'media', 'p1-clean.mp4') })
    expect(selected.shots[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(selected.shots[0]?.package_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(selected.shots[1]).not.toHaveProperty('package_sha256')
    expect(selected.shots[1]).not.toHaveProperty('package')
    expect(await readFile(join(paths.videoDir, 'shot_001.mp4'), 'utf8')).toBe('bytes of p1-clean.mp4')
    expect(JSON.parse(await readFile(paths.timeline, 'utf8'))).toEqual({
      clips: [
        { shot: 1, start_us: 0, duration_us: 5_050_000 },
        { shot: 2, start_us: 5_050_000, duration_us: 13_083_333 },
      ],
      body_end: 18.133333,
    })
    expect(await readFile(paths.subtitle, 'utf8')).toBe(await readFile(subtitle, 'utf8'))
    expect(await sizeOf(paths.masterAudio)).toBe(3)
    const master = channel.calls.find(call => call.args.includes('-filter_complex'))
    expect(master?.args).toEqual([
      '-y', '-v', 'error',
      '-i', join(project, 'media', 'p1-clean.mp4'),
      '-i', join(project, 'media', 'p2-clean.mp4'),
      '-filter_complex', masterAudioFilter(prepared.timeline.clips),
      '-map', '[a]', '-c:a', 'pcm_s16le', '-ar', '48000', paths.masterAudio,
    ])
  })

  it('warns when a cue runs past the picture the manifest assembled', async () => {
    const project = await tempProject()
    temporary.push(project)
    const shotsPath = join(project, 'shots.json')
    const subtitle = join(project, 'ep02.srt')
    await writeFile(shotsPath, JSON.stringify({ shots: [{ shot: 1, video: 'media/p1.mp4' }] }), 'utf8')
    await writePlaceholder(join(project, 'media', 'p1.mp4'), 'video')
    await writeFile(subtitle, srtDocument([{ start: '00:00:10,000', end: '00:00:12,000', text: '越界' }]), 'utf8')
    const prepared = await prepareEpisode({
      toolkit: toolkit([
        probeHandler({ [join(project, 'media', 'p1.mp4')]: { durationSeconds: 5, video: {}, audio: {} } }),
        () => ({ after: async () => {} }),
      ]),
      project,
      episode: '02',
      shotsPath,
      subtitleSrt: subtitle,
    })
    expect(prepared.warnings).toHaveLength(1)
    expect(prepared.warnings[0]).toContain('字幕第 1 条结束于 12.000s')
  })

  it('fails loud when the manifest is not JSON', async () => {
    const project = await tempProject()
    temporary.push(project)
    const shotsPath = join(project, 'shots.json')
    await writeFile(shotsPath, 'not json', 'utf8')
    await expect(prepareEpisode({
      toolkit: toolkit([]),
      project,
      episode: '02',
      shotsPath,
      subtitleSrt: join(project, 'absent.srt'),
    })).rejects.toThrow('成片清单不是合法 JSON')
  })

  it('reads a manifest that carries a byte-order mark', async () => {
    const project = await tempProject()
    temporary.push(project)
    const shotsPath = join(project, 'shots.json')
    await writePlaceholder(shotsPath, `\ufeff${JSON.stringify({ shots: [{ shot: 1, video: 'media/p1.mp4' }] })}`)
    await writePlaceholder(join(project, 'media', 'p1.mp4'), 'video')
    await writePlaceholder(join(project, 'source.srt'), srtDocument([]))
    const prepared = await prepareEpisode({
      toolkit: toolkit([
        probeHandler({ [join(project, 'media', 'p1.mp4')]: { durationSeconds: 5, video: {}, audio: {} } }),
        () => ({ after: async () => {} }),
      ]),
      project,
      episode: '02',
      shotsPath,
      subtitleSrt: join(project, 'source.srt'),
    })
    expect(prepared.shots).toHaveLength(1)
  })

  it('fails loud when the master build fails', async () => {
    const project = await tempProject()
    temporary.push(project)
    const shotsPath = join(project, 'shots.json')
    await writeFile(shotsPath, JSON.stringify({ shots: [{ shot: 1, video: 'media/p1.mp4' }] }), 'utf8')
    await writePlaceholder(join(project, 'media', 'p1.mp4'), 'video')
    await expect(prepareEpisode({
      toolkit: toolkit([
        probeHandler({ [join(project, 'media', 'p1.mp4')]: { durationSeconds: 5, video: {}, audio: {} } }),
        call => (call.args.includes('-filter_complex') ? { code: 1, stderr: 'Invalid argument' } : undefined),
      ]),
      project,
      episode: '02',
      shotsPath,
      subtitleSrt: join(project, 'absent.srt'),
    })).rejects.toThrow('Invalid argument')
  })
})

describe('paths', () => {
  it('pads an episode number to two digits', () => {
    expect(episodeNumberOf(2)).toBe('02')
    expect(episodeNumberOf(12)).toBe('12')
  })

  it('pads a shot number to three digits', () => {
    expect(shotFileName(1)).toBe('shot_001.mp4')
    expect(shotFileName(12)).toBe('shot_012.mp4')
  })

  it('resolves the whole layout under the project root', () => {
    const paths = episodePaths('C:/proj', '02')
    expect(paths.videoDir).toBe(join('C:/proj', 'video', '02'))
    expect(paths.masterAudio).toBe(join('C:/proj', 'audio', '02.wav'))
    expect(paths.timeline).toBe(join('C:/proj', 'editing', '02-timeline.json'))
    expect(paths.subtitle).toBe(join('C:/proj', 'editing', '02.srt'))
    expect(paths.output).toBe(join('C:/proj', 'exports', '02.mp4'))
    expect(paths.cacheDir).toBe(join('C:/proj', 'exports', '.render_cache', '02'))
    expect(paths.renderLog).toBe(join('C:/proj', 'exports', '.render_cache', '02', 'render.log'))
  })
})

describe('pathExists', () => {
  it('reports an existing file and an absent one', async () => {
    const project = await tempProject()
    temporary.push(project)
    await writePlaceholder(join(project, 'there.mp4'), 'x')
    expect(await pathExists(join(project, 'there.mp4'))).toBe(true)
    expect(await pathExists(join(project, 'absent.mp4'))).toBe(false)
  })

  it('surfaces a stat failure that is not a missing file', async () => {
    await expect(pathExists('bad\0path.mp4')).rejects.toThrow()
  })
})
