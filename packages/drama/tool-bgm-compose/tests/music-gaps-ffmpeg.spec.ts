/** Real composer output retains silence outside explicitly selected music intervals. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from '../../tool-episode-render/tests/audio-ffmpeg-harness.ts'
import { audioMixFilter, deliveryRenderSettings } from '../../tool-episode-render/src/delivery.ts'
import { resolveSettings } from '../../tool-episode-render/src/index.ts'
import { runDramaBgm } from '../src/compose.ts'

function pcmData(wav: Buffer): Buffer {
  for (let offset = 12; offset + 8 <= wav.length;) {
    const bytes = wav.readUInt32LE(offset + 4)
    if (wav.toString('ascii', offset, offset + 4) === 'data') return wav.subarray(offset + 8, offset + 8 + bytes)
    offset += 8 + bytes + bytes % 2
  }
  throw new Error('Missing WAV data')
}

function rms(pcm: Buffer, start: number, end: number): number {
  let squares = 0, count = 0
  for (let offset = Math.floor(start * 48_000) * 4; offset < Math.floor(end * 48_000) * 4; offset += 2) {
    squares += (pcm.readInt16LE(offset) / 32768) ** 2
    count++
  }
  return Math.sqrt(squares / count)
}

it.skipIf(!hasFfmpeg)('composes isolated short cues and exact silent windows without crossfade leakage', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-bgm-real-gaps-'))
  const runner = createMediaRunner()
  try {
    await mkdir(join(project, 'music'))
    await mkdir(join(project, 'editing'))
    const source = join(project, 'music', 'tone.wav')
    const generated = await runner.runCommand(ffmpeg, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i',
      'sine=frequency=900:duration=8:sample_rate=48000', '-ac', '2', '-c:a', 'pcm_s16le', source])
    expect(generated.interrupted).toBe(false)
    expect(generated.signal).toBeNull()
    expect(generated.code, generated.stderr).toBe(0)
    await writeFile(join(project, 'editing', 'timeline.json'), JSON.stringify({ body_end: 20,
      clips: [{ start_us: 0 }, { start_us: 2_000_000 }, { start_us: 8_000_000 }, { start_us: 10_000_000 }, { start_us: 14_000_000 }] }))
    await writeFile(join(project, 'editing', 'plan.json'), JSON.stringify({ episodes: [{
      episode: '01', body_duration_seconds: 20, music_decision: 'music', decision_reason: '对白密集场景留白',
      segments: [[2, 6], [8, 9], [10, 14], [14, 18]].map(([start, end]) => ({
        track: 'test tone', source, source_start_seconds: 0, start_seconds: start,
        end_seconds: end, reason: '离线时轴测试',
      })),
    }] }))
    const report = await runDramaBgm({ method: 'compose', project, episode: 1,
      timeline: 'editing/timeline.json', plan: 'editing/plan.json' },
    { ffmpegPath: ffmpeg, ffprobePath: ffprobe, channel: runner.channel })
    expect(report.media.duration_seconds).toBeCloseTo(20, 3)
    expect(report).toMatchObject({ music_decision: 'music', decision_reason: '对白密集场景留白' })
    const data = pcmData(await readFile(report.output))
    expect(data.length).toBe(20 * 48_000 * 4)
    for (const [start, end] of [[0.1, 1.9], [6.1, 7.9], [9.1, 9.9], [18.1, 19.9]]) {
      expect(rms(data, start!, end!)).toBeLessThan(1 / 32768)
    }
    for (const [start, end] of [[3.8, 4.2], [8.3, 8.7], [11.8, 12.2], [14.9, 15.1]]) {
      expect(rms(data, start!, end!)).toBeGreaterThan(0.002)
    }
  } finally {
    await runner.dispose()
    await rm(project, { recursive: true, force: true })
  }
}, 30_000)

it.skipIf(!hasFfmpeg)('keeps source attenuation through normalization and a touching crossfade', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-bgm-real-gain-'))
  const runner = createMediaRunner()
  try {
    await mkdir(join(project, 'editing'))
    const source = join(project, 'tone.wav')
    const generated = await runner.runCommand(ffmpeg, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i',
      'sine=frequency=900:duration=12:sample_rate=48000', '-ac', '2', '-c:a', 'pcm_s16le', source])
    expect(generated.code, generated.stderr).toBe(0)
    await writeFile(join(project, 'editing', 'timeline.json'), JSON.stringify({ body_end: 16,
      clips: [{ start_us: 0 }, { start_us: 8_000_000 }] }))
    await writeFile(join(project, 'editing', 'plan.json'), JSON.stringify({ episodes: [{
      episode: '01', body_duration_seconds: 16,
      segments: [[0, 8], [8, 16]].map(([start, end]) => ({ track: 'tone', source,
        source_start_seconds: 0, start_seconds: start, end_seconds: end, reason: '连续情绪段' })),
    }] }))
    const report = await runDramaBgm({ method: 'compose', project, episode: 1,
      timeline: 'editing/timeline.json', plan: 'editing/plan.json' },
    { ffmpegPath: ffmpeg, ffprobePath: ffprobe, channel: runner.channel, maxSourceGainDb: -10 })
    expect(report.segments.map(segment => segment.applied_gain_db)).toEqual([-10, -10])
    const original = pcmData(await readFile(source))
    const composed = pcmData(await readFile(report.output))
    const sourceRms = rms(original, 3, 4)
    for (const [start, end] of [[3, 4], [7.5, 8.5], [11, 12]]) {
      const attenuationDb = 20 * Math.log10(rms(composed, start!, end!) / sourceRms)
      expect(attenuationDb).toBeLessThanOrEqual(-9.99)
      expect(attenuationDb).toBeGreaterThan(-10.05)
    }
    const settings = deliveryRenderSettings(resolveSettings({ maxBgmVolume: 1 }), {
      visual_medium: 'animation_3d', width: 1920, height: 1080, fps: 30, audio: { bgm_gain: 8 },
    })
    expect(settings.bgmVolume).toBe(1)
    const delivered = join(project, 'delivered.wav')
    const mixed = await runner.runCommand(ffmpeg, ['-hide_banner', '-nostdin', '-i', source,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=16', '-i', report.output,
      '-filter_complex', audioMixFilter({ bodyEndSeconds: 16, totalSeconds: 16, endingSeconds: 0,
        masterVolume: settings.masterVolume, bgmVolume: settings.bgmVolume }),
      '-map', '[a]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', delivered])
    expect(mixed.code, mixed.stderr).toBe(0)
    const finalData = pcmData(await readFile(delivered))
    expect(20 * Math.log10(rms(finalData, 3, 4) / sourceRms)).toBeLessThanOrEqual(-9.99)
  } finally {
    await runner.dispose()
    await rm(project, { recursive: true, force: true })
  }
}, 30_000)
