/** BGM plan validation, timing algebra, and output ownership. */

import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appliedGain,
  auditBgmBatch,
  buildMixFilter,
  resolveProjectPath,
  resolveOutputPath,
  segmentInputDurations,
  trackIdentity,
  validateEpisodePlan,
} from '../src/plan.ts'
import type { BgmBatchContext, BgmBatchRow } from '../src/plan.ts'
import type { BgmPolicyFinding } from '../src/types.ts'

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
  it.each([
    [{ ...episode, crossfade_seconds: 0 }, '交叉淡化'],
    [{ ...episode, segments: [] }, '没有段落'],
    [{ ...episode, segments: [{ ...episode.segments[0], track: '', source: 'music.mp3', reason: 'scene', start_seconds: 0, end_seconds: 58.508 }] }, '曲目和来源'],
    [{ ...episode, segments: [{ ...episode.segments[0], track: 'song', source: '', reason: 'scene', start_seconds: 0, end_seconds: 58.508 }] }, '曲目和来源'],
    [{ ...episode, segments: episode.segments.map((segment, index) => index === 0 ? { ...segment, source_start_seconds: -1 } : segment) }, '非负秒数'],
    [{ ...episode, segments: episode.segments.map((segment, index) => index === 2 ? { ...segment, end_seconds: 57 } : segment) }, '连续覆盖'],
  ])('refuses an unusable source or uncovered body: %s', (document, message) => {
    expect(() => validateEpisodePlan(document, episode.body_duration_seconds)).toThrow(message)
  })

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

describe('auditBgmBatch', () => {
  const project = resolve('project')
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

  /** The context a test audits against, with the given sibling episodes. */
  function context(...peers: BgmBatchRow[]): BgmBatchContext {
    return { project, batch: [selected, ...peers], boundaries }
  }

  /** The rules a plan's findings name, in order. */
  function rules(findings: readonly BgmPolicyFinding[]): string[] {
    return findings.map(finding => finding.rule)
  }

  const selected: BgmBatchRow = {
    episode: '05',
    segments: [
      { track: '轻松', source: 'light.mp3', start_seconds: 0, end_seconds: 26.5 },
      { track: '暧昧', source: 'romance.mp3', start_seconds: 26.5, end_seconds: 35.5 },
      { track: '挑衅', source: 'conflict.mp3', start_seconds: 35.5, end_seconds: 58.508 },
    ],
  }

  it('does not require extra tracks for a single-track episode', () => {
    const single = row('05', ['one.mp3'])
    const findings = auditBgmBatch(single, { project, batch: [], boundaries: [] })
    expect(rules(findings)).toEqual(['R5'])
    expect(findings[0]?.detail).toContain('没有镜头包边界')
  })

  it('reports nothing for a batch that shares no track with more than one sibling', () => {
    expect(auditBgmBatch(selected, context(row('06', ['other-a.mp3', 'other-b.mp3'])))).toEqual([])
  })

  it('identifies a track by its resolved source, not by its label', () => {
    expect(trackIdentity(project, 'light.mp3')).toBe(trackIdentity(project, join(project, 'light.mp3')))
  })

  it('keeps a stricter configured track count advisory', () => {
    const single: BgmBatchRow = { episode: '05', segments: [selected.segments[0]!] }
    const findings = auditBgmBatch(single, { project, batch: [single], boundaries,
      limits: { minTracksPerEpisode: 2, maxEpisodesPerTrack: 2, freshTracksPerEpisode: 0, boundaryToleranceSeconds: 0.05 } })
    expect(rules(findings)).toEqual(['R1'])
    expect(findings[0]?.fix).toContain('不必为了数量换曲')
  })

  it('reports a track repeated inside one episode and names it', () => {
    const repeated: BgmBatchRow = {
      episode: '05',
      segments: [
        selected.segments[0]!,
        selected.segments[1]!,
        { ...selected.segments[2]!, source: 'light.mp3' },
      ],
    }
    const findings = auditBgmBatch(repeated, { project, batch: [repeated], boundaries })
    expect(rules(findings)).toEqual(['R2'])
    expect(findings[0]?.detail).toContain('light.mp3')
  })

  it('reports a track a third episode joins and names the episodes to change', () => {
    const findings = auditBgmBatch(selected, context(
      row('06', ['light.mp3', 'other-a.mp3']),
      row('07', ['light.mp3', 'other-b.mp3']),
    ))
    expect(rules(findings)).toEqual(['R3'])
    expect(findings[0]?.detail).toContain('3 集')
    expect(findings[0]?.fix).toContain('07')
  })

  it('reports an episode whose every track is already used elsewhere', () => {
    const findings = auditBgmBatch(selected, { ...context(
      row('06', ['light.mp3', 'romance.mp3', 'conflict.mp3', 'other-a.mp3']),
    ), limits: { minTracksPerEpisode: 1, maxEpisodesPerTrack: 2, freshTracksPerEpisode: 1, boundaryToleranceSeconds: 0.05 } })
    expect(rules(findings)).toEqual(['R4'])
    expect(findings[0]?.fix).toContain('bgm_match')
  })

  it('reports a cut that does not land on a package boundary', () => {
    const moved: BgmBatchRow = {
      episode: '05',
      segments: selected.segments.map((segment, index) => index === 1 ? { ...segment, start_seconds: 27 } : segment),
    }
    const findings = auditBgmBatch(moved, { project, batch: [moved], boundaries })
    expect(rules(findings)).toEqual(['R5'])
    expect(findings[0]?.fix).toContain('可保留当前切点并记录理由')
  })

  it('reports that the cuts cannot be checked at all instead of passing silently', () => {
    const findings = auditBgmBatch(selected, { project, batch: [selected], boundaries: [] })
    expect(rules(findings)).toEqual(['R5'])
    expect(findings[0]?.detail).toContain('无法核对')
  })
})

describe('explicit music decisions', () => {
  it('accepts no added music without enforcing reuse recommendations', () => {
    const noMusic = { ...episode, music_decision: 'none' as const, decision_reason: '只保留对白与现场声', segments: [] }
    expect(validateEpisodePlan(noMusic, 58.508)).toEqual({ bodyDurationSeconds: 58.508, crossfadeSeconds: 0, segments: [] })
    expect(auditBgmBatch(noMusic, { project: resolve('project'), batch: [], boundaries: [] })).toEqual([])
  })

  it.each(['music', 'none'] as const)('requires a reason for %s', (decision) => {
    expect(() => validateEpisodePlan({ ...episode, music_decision: decision, decision_reason: ' ' }, 58.508))
      .toThrow('decision_reason')
  })

  it('rejects tracks attached to a no-music decision', () => {
    expect(() => validateEpisodePlan({ ...episode, music_decision: 'none', decision_reason: '现场声' }, 58.508)).toThrow('空 segments')
  })

  it('allows leading, internal, and trailing gaps only for explicit music', () => {
    const segments = [
      { track: 'one', source: 'one.wav', start_seconds: 2, end_seconds: 6, reason: '场景一' },
      { track: 'two', source: 'two.wav', start_seconds: 10, end_seconds: 14, reason: '场景二' },
      { track: 'three', source: 'three.wav', start_seconds: 14, end_seconds: 18, reason: '承接' },
    ]
    const input = { episode: '01', body_duration_seconds: 20, music_decision: 'music' as const, decision_reason: '对白密集段留白', segments }
    const plan = validateEpisodePlan(input, 20)
    expect(plan.segments.map(segment => segment.inputDurationSeconds)).toEqual([4, 4.75, 4.75])
    const graph = buildMixFilter(plan.segments.map(segment => segment.inputDurationSeconds), [0, 0, 0], [0, 0, 0], 20, 1.5, segments)
    expect(graph.match(/acrossfade=/g)).toHaveLength(1)
    expect(graph).toContain('adelay=delays=2000.000000:all=1')
    expect(graph).toContain('adelay=delays=10000.000000:all=1')
    expect(graph).toContain('amix=inputs=2:normalize=0,apad,atrim=0:20.000000')
    expect(() => validateEpisodePlan({ episode: input.episode, body_duration_seconds: 20, segments }, 20)).toThrow('连续覆盖')
    expect(() => validateEpisodePlan({ ...input, segments: [segments[1]!, segments[0]!] }, 20)).toThrow('连续覆盖')
    expect(() => validateEpisodePlan({ ...input, segments: [{ ...segments[0]!, end_seconds: 21 }] }, 20)).toThrow('连续覆盖')
  })

  it('retains the legacy graph exactly for explicit contiguous music', () => {
    const durations = segmentInputDurations(episode.segments, 1.5)
    expect(buildMixFilter(durations, [0, 0, 0], [1, 2, 3], 58.508, 1.5, episode.segments))
      .toBe(buildMixFilter(durations, [0, 0, 0], [1, 2, 3], 58.508, 1.5))
  })

  it('accepts an isolated one-second cue without applying an unused crossfade duration', () => {
    const segments = [{ track: 'cue', source: 'cue.wav', start_seconds: 2, end_seconds: 3, reason: '独立短配乐' }]
    const plan = validateEpisodePlan({ episode: '01', body_duration_seconds: 8,
      music_decision: 'music', decision_reason: '仅在短情绪点加乐，其余留白', segments }, 8)
    expect(plan.crossfadeSeconds).toBe(1.5)
    expect(plan.segments[0]?.inputDurationSeconds).toBe(1)
    const graph = buildMixFilter([1], [0], [0], 8, plan.crossfadeSeconds, segments)
    expect(graph).not.toContain('acrossfade=')
    expect(graph).toContain('adelay=delays=2000.000000:all=1')
    expect(graph).toContain('apad,atrim=0:8.000000')
  })

  it('still refuses an overlong crossfade between actual neighboring music cues', () => {
    expect(() => validateEpisodePlan({ episode: '01', body_duration_seconds: 8,
      music_decision: 'music', decision_reason: '相接曲目', segments: [
        { track: 'short', source: 'short.wav', start_seconds: 2, end_seconds: 3, reason: '短段' },
        { track: 'next', source: 'next.wav', start_seconds: 3, end_seconds: 6, reason: '接续' },
      ] }, 8)).toThrow('交叉淡化不能长于最短剧情段')
  })

  it('preserves the legacy short-segment rejection when no explicit music decision is supplied', () => {
    expect(() => validateEpisodePlan({ episode: '01', body_duration_seconds: 1,
      segments: [{ track: 'short', source: 'short.wav', start_seconds: 0, end_seconds: 1, reason: '旧调用' }] }, 1))
      .toThrow('交叉淡化不能长于最短剧情段')
  })
})

describe('mix calculations', () => {
  it('refuses a nonfinite loudness and unequal mix arrays before building a graph', () => {
    expect(() => appliedGain(Number.NaN)).toThrow('不是有效数值')
    expect(() => buildMixFilter([], [], [], 5, 1.5)).toThrow('数量不一致')
    expect(() => buildMixFilter([5], [], [0], 5, 1.5)).toThrow('数量不一致')
    expect(() => buildMixFilter([5], [0], [], 5, 1.5)).toThrow('数量不一致')
  })

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
    const project = resolve('project')
    expect(resolveOutputPath(project, 'audio/bgm/05.wav')).toBe(join(project, 'audio/bgm/05.wav'))
    expect(() => resolveOutputPath(project, '../05.wav')).toThrow('项目目录')
    expect(() => resolveOutputPath(project, resolve('outside/05.wav'))).toThrow('项目目录')
  })

  it('resolves relative and absolute project paths to the same canonical path', () => {
    const project = resolve('剧变项目')
    const absolute = join(project, 'editing', '配乐计划.json')
    expect(resolveProjectPath(project, 'editing/配乐计划.json', 'BGM 计划')).toEqual({
      input: 'editing/配乐计划.json',
      project,
      resolved: absolute,
    })
    expect(resolveProjectPath(project, absolute, 'BGM 计划')).toEqual({
      input: absolute,
      project,
      resolved: absolute,
    })
  })

  it('reports every path field and the reason when a path escapes the project', () => {
    const project = resolve('剧变项目')
    const operation = () => resolveProjectPath(project, '../outside.json', 'BGM 计划')
    expect(operation).toThrow('input="../outside.json"')
    expect(operation).toThrow(`project="${project}"`)
    expect(operation).toThrow(/resolved=".+outside\.json"/u)
    expect(operation).toThrow('reason=路径越出项目目录')
  })
})
