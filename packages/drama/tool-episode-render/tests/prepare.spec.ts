/** `prepare`: the shot manifest, the probes it validates against, and the layout it writes. */

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { episodePaths, episodeNumberOf, pathExists, shotFileName } from '../src/paths.ts'
import {
  cueOverrunWarnings,
  masterAudioFilter,
  parseShotManifest,
  prepareEpisode,
  preparedSubtitleClockInputs,
  resolveShots,
  verifyPreparedSubtitleClock,
} from '../src/prepare.ts'
import { subtitleClockPath, writeSubtitleClock } from '../src/subtitle-clock.ts'
import { readTimeline } from '../src/timeline.ts'
import type { SubtitleCue } from '../src/types.ts'
import { cleanup, probeHandler, sizeOf, srtDocument, stubChannel, tempProject, writePlaceholder, type StubHandler } from './harness.ts'

const temporary: string[] = []
const copying = vi.hoisted(() => ({ target: '' }))
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual, copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
    if (args[1] === copying.target) {
      copying.target = ''
      await actual.writeFile(args[0], 'replacement picture during copy')
    }
    await actual.copyFile(...args)
  } }
})

afterEach(async () => {
  copying.target = ''
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
  const project = resolve('render-test-project')

  it('probes each source and resolves a relative path against the project root', async () => {
    const shots = await resolveShots(
      toolkit([probeHandler({ [join(project, 'media/02/p1-clean.mp4')]: { durationSeconds: 5.05, video: {}, audio: {} } })]),
      project,
      [{ shot: 1, video: 'media/02/p1-clean.mp4', audio: 'media/02/p1-clean.mp4' }],
      24,
    )
    expect(shots).toEqual([{
      source: { shot: 1, video: 'media/02/p1-clean.mp4', audio: 'media/02/p1-clean.mp4' },
      video: join(project, 'media/02/p1-clean.mp4'),
      audio: join(project, 'media/02/p1-clean.mp4'),
      durationUs: 5_050_000,
    }])
  })

  it('uses a declared audio track when the video carries none', async () => {
    const shots = await resolveShots(
      toolkit([probeHandler({ [join(project, 'media/02/p1.mp4')]: { durationSeconds: 5, video: {}, audio: false } })]),
      project,
      [{ shot: 1, video: 'media/02/p1.mp4', audio: join(project, 'media/02/p1.wav') }],
      24,
    )
    expect(shots[0]?.audio).toBe(join(project, 'media/02/p1.wav'))
  })

  it.each([
    { fps: 24, container: 6.08, start: 0, frames: 145, expected: 6_041_667 },
    { fps: 60, container: 6.08, start: 0, frames: 145, expected: 6_080_000 },
    { fps: 24, container: 6.08, start: 0.1, frames: 145, expected: 6_080_000 },
    { fps: 24, container: 6.08, start: 0, frames: 144, expected: 6_080_000 },
    { fps: 24, container: 6.3, start: 0, frames: 145, expected: 6_300_000 },
  ])('uses whole picture frames only for a proven short mux tail ($fps fps, $container s, start $start, $frames frames)',
    async ({ fps, container, start, frames, expected }) => {
      const video = 'p1.mp4'
      const shots = await resolveShots(toolkit([probeHandler({ [join(project, video)]: {
        durationSeconds: container,
        video: { fps: 24, startSeconds: start, durationSeconds: 6.041667, frameCount: frames },
        audio: {},
      } })]), project, [{ shot: 1, video, audio: video }], fps)
      expect(shots[0]?.durationUs).toBe(expected)
    })

  it('rounds each absolute cut once so a Jianying boundary does not advance to the next frame', async () => {
    const video = 'p1.mp4'
    const shots = await resolveShots(toolkit([probeHandler({ [join(project, video)]: {
      durationSeconds: 6.08,
      video: { fps: 24, startSeconds: 0, durationSeconds: 6.041667, frameCount: 145 },
      audio: {},
    } })]), project, [{ shot: 1, video, audio: video }, { shot: 2, video, audio: video }], 24)
    expect(shots.map(shot => shot.durationUs)).toEqual([6_041_667, 6_041_666])
  })

  it('uses the draft frame planner tie rule when a boundary is exactly between microseconds', async () => {
    const video = 'p1.mp4'
    const shots = await resolveShots(toolkit([probeHandler({ [join(project, video)]: {
      durationSeconds: 0.04,
      video: { fps: 128, startSeconds: 0, durationSeconds: 0.039063, frameCount: 5 },
      audio: {},
    } })]), project, [{ shot: 1, video, audio: video }], 128)
    expect(shots[0]?.durationUs).toBe(39_062)
  })

  it('fails loud when the source is missing', async () => {
    await expect(resolveShots(toolkit([probeHandler({})]), project,
      [{ shot: 3, video: 'media/02/p3.mp4', audio: 'media/02/p3.mp4' }], 24))
      .rejects.toThrow('镜头 3 的成片无法探测')
  })

  it('fails loud when the source has no picture', async () => {
    await expect(resolveShots(
      toolkit([probeHandler({ [join(project, 'media/02/p1.mp4')]: { video: undefined, audio: {} } })]), project,
      [{ shot: 1, video: 'media/02/p1.mp4', audio: 'media/02/p1.mp4' }], 24))
      .rejects.toThrow('没有视频流')
  })

  it('fails loud when the picture has no sound and none was declared', async () => {
    await expect(resolveShots(
      toolkit([probeHandler({ [join(project, 'media/02/p1.mp4')]: { video: {}, audio: false } })]), project,
      [{ shot: 1, video: 'media/02/p1.mp4', audio: 'media/02/p1.mp4' }], 24))
      .rejects.toThrow('没有音轨')
  })

  it('fails loud when the source reports no duration', async () => {
    await expect(resolveShots(
      toolkit([probeHandler({ [join(project, 'media/02/p1.mp4')]: { durationSeconds: 0, video: {}, audio: {} } })]), project,
      [{ shot: 1, video: 'media/02/p1.mp4', audio: 'media/02/p1.mp4' }], 24))
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
  it.each(['review changed', 'picture changed during copy'] as const)
  ('rejects an approved source changed while preparing: %s', async (defect) => {
    const project = await tempProject()
    temporary.push(project)
    const paths = episodePaths(project, '41')
    const video = join(project, 'selected.mp4'), audio = join(project, 'selected.wav')
    const packagePath = join(project, 'episode_packages', '41', 'package.json')
    const reviewPath = join(project, 'reviews', 'ep41-p01.json')
    const shotsPath = join(project, 'shots.json'), subtitle = join(project, 'source.srt')
    await Promise.all([writePlaceholder(video, 'approved picture'), writePlaceholder(audio, 'approved audio'),
      writePlaceholder(packagePath, JSON.stringify({ episode: '41', video_tasks: [{ shots: [1] }] })),
      writePlaceholder(shotsPath, JSON.stringify({ shots: [{ shot: 1, package: 1, video, audio }] })),
      writePlaceholder(subtitle, ''), writePlaceholder(paths.timeline, 'prior timeline')])
    const review = { episode: '41', package: 1, package_sha256: await fileSha256(packagePath), status: 'approved',
      subtitle_cleanup: 'clean', video_path: video, video_sha256: await fileSha256(video),
      audio_path: audio, audio_sha256: await fileSha256(audio) }
    await writePlaceholder(reviewPath, JSON.stringify(review))
    const probe = probeHandler({ [video]: { durationSeconds: 1, video: {}, audio: {} } })
    const channel = stubChannel([(call) => {
      const result = probe(call)
      return result === undefined ? undefined : { ...result, after: async () => {
        if (defect === 'review changed') await writeFile(reviewPath, JSON.stringify({ ...review, note: 'updated review' }))
      } }
    }])
    if (defect === 'picture changed during copy') copying.target = join(paths.videoDir, 'shot_001.mp4')
    await expect(prepareEpisode({ project, episode: '41', shotsPath, subtitleSrt: subtitle,
      toolkit: createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }) }))
      .rejects.toThrow(defect === 'review changed' ? '审核选源变化' : '复制期间已审核画面变化')
    expect(await readFile(paths.timeline, 'utf8')).toBe('prior timeline')
    expect(await pathExists(paths.sources)).toBe(false)
    expect(channel.calls.every(call => call.command === 'ffprobe')).toBe(true)
  })
  it.each(['wrong picture', 'wrong audio', 'wrong episode', 'omitted package',
    'approved original audio', 'legacy picture review preview'] as const)
  ('checks the current approved package before preparing equal-duration sources: %s', async (defect) => {
    const project = await tempProject()
    temporary.push(project)
    const paths = episodePaths(project, '41')
    const packagePath = join(project, 'episode_packages', '41', 'package.json')
    const clean = join(project, 'ep41-clean.mp4')
    const audio = join(project, 'ep41-original.mp4')
    const foreign = join(project, 'ep40-same-length.mp4')
    const shotsPath = join(project, 'shots.json')
    await Promise.all([
      writePlaceholder(packagePath, JSON.stringify({ episode: defect === 'wrong episode' ? '40' : '41', video_tasks: [{ shots: [1] }] })),
      writePlaceholder(clean, 'approved picture'),
      writePlaceholder(audio, 'approved original audio'),
      writePlaceholder(foreign, 'foreign picture'),
      writePlaceholder(paths.subtitle, ''),
      writePlaceholder(paths.timeline, 'previous timeline'),
    ])
    const audioHash = await fileSha256(audio)
    await writePlaceholder(join(project, 'reviews', 'ep41-p01.json'), JSON.stringify({
      episode: '41', package: 1, package_sha256: await fileSha256(packagePath), status: 'approved',
      subtitle_cleanup: 'clean', video_path: clean, video_sha256: await fileSha256(clean),
      ...(defect === 'legacy picture review preview' ? {} : { audio_path: audio, audio_sha256: audioHash }),
    }))
    const video = defect === 'wrong picture' ? foreign : clean
    await writePlaceholder(shotsPath, JSON.stringify({ shots: [{ shot: 1,
      package: defect === 'omitted package' ? undefined : 1, video, audio: defect === 'wrong audio' ? foreign : audio }] }))
    const media = { durationSeconds: 5.056, video: {}, audio: false } as const
    const channel = stubChannel([probeHandler({ [clean]: media, [foreign]: media }), call => ({
      after: async () => { await writeFile(call.args.at(-1)!, 'generated master', 'utf8') },
    })])
    const input = { toolkit: createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      project, episode: '41', shotsPath, subtitleSrt: join(project, 'source.srt') }
    await writePlaceholder(input.subtitleSrt, '')
    if (defect === 'approved original audio' || defect === 'legacy picture review preview') {
      const result = await prepareEpisode(input)
      expect(result.timeline.clips[0]?.durationUs).toBe(5_056_000)
      expect(JSON.parse(await readFile(paths.sources, 'utf8'))).toMatchObject({
        master_audio_sha256: await fileSha256(paths.masterAudio),
        timeline_clips: [{ shot: 1, start_us: 0, duration_us: 5_056_000 }],
        shots: [{ package: 1, video: clean, audio }],
      })
      const saved = JSON.parse(await readFile(paths.sources, 'utf8')) as { shots: { audio_sha256?: string }[] }
      expect(saved.shots[0]?.audio_sha256).toBe(defect === 'approved original audio' ? audioHash : undefined)
    } else {
      await expect(prepareEpisode(input)).rejects.toThrow(/画面路径|原声音频|集号|编译分包/)
      expect(channel.calls).toEqual([])
      expect(await readFile(paths.timeline, 'utf8')).toBe('previous timeline')
    }
  })

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
      delivery: { width: 1440, height: 2560, fps: 60 },
    })
    expect(prepared.warnings[0]).toContain('未设置 visual_medium')
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
      delivery: { width: 1440, height: 2560, fps: 60 },
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
    expect(prepared.warnings).toHaveLength(2)
    expect(prepared.warnings[1]).toContain('字幕第 1 条结束于 12.000s')
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

describe('prepared subtitle source clock', () => {
  it.each(['matching external audio', 'missing shot', 'wrong shot', 'noncontiguous cut'] as const)
  ('checks generated subtitle sources before trusting their clock: %s', async (defect) => {
    const project = await tempProject()
    temporary.push(project)
    const paths = episodePaths(project, '02')
    const original = join(project, 'source.mp4'), audio = join(project, 'source.wav')
    const video = join(paths.videoDir, 'shot_001.mp4')
    const text = srtDocument([{ start: '00:00:00,100', end: '00:00:00,500', text: '台词' }])
    await Promise.all([writePlaceholder(original, 'picture'), writePlaceholder(video, 'picture'),
      writePlaceholder(audio, 'separate audio'), writePlaceholder(paths.subtitle, text),
      writePlaceholder(paths.timeline, '{"clips":[{"shot":1,"start_us":0,"duration_us":1000000}],"body_end":1}')])
    const source = { shot: 1, video: original, audio }
    await writeSubtitleClock(paths.subtitle, text, '02', [{ source, video: original, audio, durationUs: 1_000_000 }])
    const timeline = await readTimeline(paths.timeline)
    await writePlaceholder(paths.sources, JSON.stringify({ shots: [source] }))
    if (defect === 'missing shot') {
      const withExtra = { ...timeline, clips: [...timeline.clips, { shot: 2, startUs: 1_000_000, durationUs: 1_000_000 }] }
      await expect(verifyPreparedSubtitleClock(paths.subtitle, paths, withExtra)).rejects.toThrow('准备清单或时间线')
    } else if (defect === 'wrong shot') {
      const reordered = { ...timeline, clips: [{ shot: 2, startUs: 0, durationUs: 1_000_000 }] }
      await expect(verifyPreparedSubtitleClock(paths.subtitle, paths, reordered)).rejects.toThrow('准备清单或时间线')
    } else if (defect === 'noncontiguous cut') {
      const shifted = { ...timeline, clips: [{ shot: 1, startUs: 1, durationUs: 1_000_000 }] }
      await expect(verifyPreparedSubtitleClock(paths.subtitle, paths, shifted)).rejects.toThrow('准备清单或时间线')
    } else await expect(verifyPreparedSubtitleClock(paths.subtitle, paths, timeline)).resolves.toBeUndefined()
  })

  async function preparedClockProject() {
    const project = await tempProject()
    temporary.push(project)
    const paths = episodePaths(project, '02'), sourceSubtitle = join(project, 'source.srt')
    const firstVideo = join(project, 'media', 'first.mp4'), secondVideo = join(project, 'media', 'second-clean.mp4')
    const secondAudio = join(project, 'media', 'second-original.wav'), shotsPath = join(project, 'shots.json')
    const manifest = { shots: [{ shot: 1, video: firstVideo }, { shot: 2, video: secondVideo, audio: secondAudio }] }
    const text = srtDocument([
      { start: '00:00:00,100', end: '00:00:00,500', text: '第一句' },
      { start: '00:00:01,100', end: '00:00:01,500', text: '第二句' },
    ])
    await Promise.all([
      writePlaceholder(firstVideo, 'first picture and original sound'),
      writePlaceholder(secondVideo, 'second cleaned picture'),
      writePlaceholder(secondAudio, 'second original sound'),
      writePlaceholder(sourceSubtitle, text), writePlaceholder(shotsPath, JSON.stringify(manifest)),
    ])
    const probe = probeHandler({
      [firstVideo]: { durationSeconds: 1, video: {}, audio: {} },
      [secondVideo]: { durationSeconds: 1, video: {}, audio: false },
    })
    const channel = stubChannel([probe, call => ({ after: async () => {
      await writeFile(call.args.at(-1)!, 'prepared original master audio', 'utf8')
    } })])
    const toolkit = createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel })
    const shots = await resolveShots(toolkit, project, parseShotManifest(manifest, shotsPath), 60)
    await writeSubtitleClock(sourceSubtitle, text, '02', shots)
    const prepared = await prepareEpisode({ toolkit, project, episode: '02', shotsPath, subtitleSrt: sourceSubtitle })
    const files = [...new Set([firstVideo, secondVideo, secondAudio, sourceSubtitle, shotsPath,
      subtitleClockPath(sourceSubtitle), ...prepared.written])]
    return { project, paths, secondAudio, files, channel }
  }

  it('captures the real prepared picture, voice, master and generated subtitle identities without rendering', async () => {
    const fixture = await preparedClockProject()
    const { project, paths, secondAudio, files, channel } = fixture
    const before = await Promise.all(files.map(async path => ({ path, bytes: await readFile(path) })))
    const callsBefore = [...channel.calls]
    const captured = await preparedSubtitleClockInputs(project, '02', paths.timeline, paths.subtitle, undefined)
    expect(captured).toEqual({
      clockPath: subtitleClockPath(paths.subtitle), manifestPath: paths.sources,
      manifestSha256: await fileSha256(paths.sources), manifestBytes: (await readFile(paths.sources)).length,
      clockPresent: true, masterPath: paths.masterAudio,
      shots: [
        { shot: 1, video: join(paths.videoDir, 'shot_001.mp4'), audio: join(paths.videoDir, 'shot_001.mp4') },
        { shot: 2, video: join(paths.videoDir, 'shot_002.mp4'), audio: secondAudio },
      ],
    })
    for (const file of before) expect(await readFile(file.path)).toEqual(file.bytes)
    expect(channel.calls).toEqual(callsBefore)
    await expect(readFile(paths.output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['same-length master replacement', 'changed cut', 'old subtitle'] as const)
  ('refuses to capture a prepared subtitle clock after %s without changing its input files', async (change) => {
    const { project, paths, files, channel } = await preparedClockProject()
    await expect(preparedSubtitleClockInputs(project, '02', paths.timeline, paths.subtitle, undefined))
      .resolves.toMatchObject({ clockPresent: true, masterPath: paths.masterAudio })
    if (change === 'same-length master replacement') {
      const original = await readFile(paths.masterAudio), replacement = Buffer.from(original)
      replacement[0] = replacement[0]! ^ 1
      await writeFile(paths.masterAudio, replacement)
      expect(await sizeOf(paths.masterAudio)).toBe(original.length)
      expect(await readFile(paths.masterAudio)).not.toEqual(original)
    } else if (change === 'changed cut') {
      const timeline = JSON.parse(await readFile(paths.timeline, 'utf8')) as { clips: { start_us: number; duration_us: number }[] }
      timeline.clips[0]!.duration_us += 100_000
      timeline.clips[1]!.start_us += 100_000
      timeline.clips[1]!.duration_us -= 100_000
      await writeFile(paths.timeline, JSON.stringify(timeline), 'utf8')
      expect((await readTimeline(paths.timeline)).bodyEndSeconds).toBe(2)
    } else {
      const subtitle = await readFile(paths.subtitle, 'utf8')
      await writeFile(paths.subtitle, subtitle.replace('00:00:00,100', '00:00:00,050'), 'utf8')
      expect(await readFile(paths.subtitle, 'utf8')).not.toBe(subtitle)
    }
    const before = await Promise.all(files.map(async path => ({ path, bytes: await readFile(path) })))
    const callsBefore = [...channel.calls]
    await expect(preparedSubtitleClockInputs(project, '02', paths.timeline, paths.subtitle, undefined))
      .rejects.toThrow(change === 'old subtitle' ? '生成字幕与当前集、分包素材或切点不一致' : '生成字幕缺少与当前音轨及时间线一致的准备记录')
    for (const file of before) expect(await readFile(file.path)).toEqual(file.bytes)
    expect(channel.calls).toEqual(callsBefore)
    await expect(readFile(paths.output)).rejects.toMatchObject({ code: 'ENOENT' })
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
    const project = resolve('render-test-project')
    const paths = episodePaths(project, '02')
    expect(paths.videoDir).toBe(join(project, 'video', '02'))
    expect(paths.masterAudio).toBe(join(project, 'audio', '02.wav'))
    expect(paths.timeline).toBe(join(project, 'editing', '02-timeline.json'))
    expect(paths.subtitle).toBe(join(project, 'editing', '02.srt'))
    expect(paths.output).toBe(join(project, 'exports', '02.mp4'))
    expect(paths.cacheDir).toBe(join(project, 'exports', '.render_cache', '02'))
    expect(paths.renderLog).toBe(join(project, 'exports', '.render_cache', '02', 'render.log'))
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
