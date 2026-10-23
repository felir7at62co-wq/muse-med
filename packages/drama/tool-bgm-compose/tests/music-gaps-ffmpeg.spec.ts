/** Real composer output retains silence outside explicitly selected music intervals. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from '../../tool-episode-render/tests/audio-ffmpeg-harness.ts'
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
