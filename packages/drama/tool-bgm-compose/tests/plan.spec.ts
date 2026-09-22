/** BGM plan validation, timing algebra, and output ownership. */

import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appliedGain,
  buildMixFilter,
  resolveOutputPath,
  segmentInputDurations,
  trackIdentity,
  validateBgmBatch,
  validateEpisodePlan,
} from '../src/plan.ts'
import type { BgmBatchContext, BgmBatchRow } from '../src/plan.ts'

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

describe('validateBgmBatch', () => {
  const project = 'D:/project'
  const boundaries = [0, 26.5, 35.5]

  /** One batch row with the segments a test needs. */
  function row(episode: string, sources: readonly string[]): BgmBatchRow {
    return {
      episode,
      segments: sources.map((source, index) => ({
        track: source, source, start_seconds: index, end_seconds: index + 1,
      })),
    }
  }

  /** The context a test checks against, with the given sibling episodes. */
  function context(...peers: BgmBatchRow[]): BgmBatchContext {
    return { project, batch: [selected, ...peers], boundaries }
  }

  const selected: BgmBatchRow = {
    episode: '05',
    segments: [
      { track: '轻松', source: 'light.mp3', start_seconds: 0, end_seconds: 26.5 },
      { track: '暧昧', source: 'romance.mp3', start_seconds: 26.5, end_seconds: 35.5 },
      { track: '挑衅', source: 'conflict.mp3', start_seconds: 35.5, end_seconds: 58.508 },
    ],
  }

  it('accepts a batch that shares no track with more than one sibling', () => {
    expect(() => {
      validateBgmBatch(selected, context(row('06', ['other-a.mp3', 'other-b.mp3'])))
    }).not.toThrow()
  })

  it('identifies a track by its resolved source, not by its label', () => {
    expect(trackIdentity(project, 'light.mp3')).toBe(trackIdentity(project, 'D:/project/light.mp3'))
  })

  it('rejects an episode that is one single track', () => {
    const single: BgmBatchRow = { episode: '05', segments: [selected.segments[0]!] }
    expect(() => {
      validateBgmBatch(single, { project, batch: [single], boundaries })
    }).toThrow('要求每集至少 2 首')
  })

  it('rejects a track repeated inside one episode', () => {
    const repeated: BgmBatchRow = {
      episode: '05',
      segments: [
        selected.segments[0]!,
        selected.segments[1]!,
        { ...selected.segments[2]!, source: 'light.mp3' },
      ],
    }
    expect(() => {
      validateBgmBatch(repeated, { project, batch: [repeated], boundaries })
    }).toThrow('同一集内不得重复')
  })

  it('rejects a track a third episode joins', () => {
    expect(() => {
      validateBgmBatch(selected, context(
        row('06', ['light.mp3', 'other-a.mp3']),
        row('07', ['light.mp3', 'other-b.mp3']),
      ))
    }).toThrow('超过整批上限 2 集')
  })

  it('rejects an episode whose every track is already used elsewhere', () => {
    expect(() => {
      validateBgmBatch(selected, context(
        row('06', ['light.mp3', 'romance.mp3', 'conflict.mp3', 'other-a.mp3']),
      ))
    }).toThrow('没有任何一首是本批其它集没用的')
  })

  it('rejects a cut that does not land on a package boundary', () => {
    const moved: BgmBatchRow = {
      episode: '05',
      segments: selected.segments.map((segment, index) => index === 1 ? { ...segment, start_seconds: 27 } : segment),
    }
    expect(() => {
      validateBgmBatch(moved, { project, batch: [moved], boundaries })
    }).toThrow('不在任何镜头包边界上')
  })

  it('refuses to pass a plan whose cuts cannot be checked at all', () => {
    expect(() => {
      validateBgmBatch(selected, { project, batch: [selected], boundaries: [] })
    }).toThrow('时间线里没有镜头包边界')
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
