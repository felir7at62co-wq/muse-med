/** BGM plan validation, timing algebra, and output ownership. */

import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appliedGain,
  buildMixFilter,
  resolveOutputPath,
  segmentInputDurations,
  validateEpisodePlan,
} from '../src/plan.ts'

const episode = {
  episode: '05',
  body_duration_seconds: 58.508,
  crossfade_seconds: 1.5,
  segments: [
    { track: '轻松', source: 'D:/bgm/light.mp3', start_seconds: 0, end_seconds: 26.5, reason: '入场' },
    { track: '暧昧', source: 'D:/bgm/romance.mp3', start_seconds: 26.5, end_seconds: 35.5, reason: '关系升温' },
    { track: '挑衅', source: 'D:/bgm/conflict.mp3', start_seconds: 35.5, end_seconds: 58.508, reason: '正面冲突' },
  ],
}

describe('validateEpisodePlan', () => {
  it('accepts contiguous segments that cover the body and derives overlap input durations', () => {
    const value = validateEpisodePlan(episode, 58.508)
    expect(value.crossfadeSeconds).toBe(1.5)
    expect(value.segments.map(segment => segment.inputDurationSeconds)).toEqual([27.25, 10.5, 23.758])
    expect(value.segments.reduce((sum, segment) => sum + segment.inputDurationSeconds, 0)
      - value.crossfadeSeconds * 2).toBeCloseTo(58.508, 6)
  })

  it.each([
    [{ ...episode, body_duration_seconds: 58 }, '正文时长'],
    [{ ...episode, segments: episode.segments.map((segment, index) => index === 1 ? { ...segment, start_seconds: 27 } : segment) }, '连续覆盖'],
    [{ ...episode, segments: episode.segments.map((segment, index) => index === 0 ? { ...segment, reason: '' } : segment) }, '选曲理由'],
    [{ ...episode, crossfade_seconds: 9.1 }, '交叉淡化'],
  ])('rejects invalid plans: %s', (document, message) => {
    expect(() => validateEpisodePlan(document, 58.508)).toThrow(message)
  })
})

describe('mix calculations', () => {
  it('uses the shared target without boosting more than nine decibels', () => {
    expect(appliedGain(-14.5)).toBe(-3)
    expect(appliedGain(-21.2)).toBe(3.7)
    expect(appliedGain(-30)).toBe(9)
  })

  it('builds one chain with two crossfades and endpoint fades', () => {
    const lengths = segmentInputDurations(episode.segments, 1.5)
    const graph = buildMixFilter(lengths, [1.5, 2, 3], [-3, -6.8, 3.7], 58.508, 1.5)
    expect(graph.match(/acrossfade=/g)).toHaveLength(2)
    expect(graph).toContain('afade=t=in')
    expect(graph).toContain('afade=t=out')
    expect(graph).toContain('atrim=0:58.508000')
  })
})

describe('resolveOutputPath', () => {
  it('keeps outputs inside the project', () => {
    const project = resolve('D:/project')
    expect(resolveOutputPath(project, 'audio/bgm/05.wav')).toBe(join(project, 'audio/bgm/05.wav'))
    expect(() => resolveOutputPath(project, '../05.wav')).toThrow('项目目录')
    expect(() => resolveOutputPath(project, 'D:/outside/05.wav')).toThrow('项目目录')
  })
})
