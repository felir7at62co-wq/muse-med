/** Window split of oversized cross-episode schedules and rejected-field feedback for reviewer submissions. */
import { expect, it } from 'vitest'
import { z } from 'zod'
import { continuityAssessmentSchema, submissionIssueSummary } from '../src/manuscript-continuity-assessment.ts'
import { episodeWindows } from '../src/manuscript-episode-windows.ts'

const episodes = Array.from({ length: 9 }, (_value, index) => ({ episode: index + 1, start: index * 10 + 1, end: index * 10 + 10 }))
const pairs = (from: number, to: number) => Array.from({ length: to - from }, (_value, index) =>
  ({ from_episode: from + index, to_episode: from + index + 1 }))

it('splits one chain into balanced windows whose lines hold exactly their complete episodes', () => {
  expect(episodeWindows(pairs(1, 9), episodes, 3)).toEqual([
    { checks: pairs(1, 4), lines: { start: 1, end: 40 } },
    { checks: pairs(4, 7), lines: { start: 31, end: 70 } },
    { checks: pairs(7, 9), lines: { start: 61, end: 90 } },
  ])
  expect(episodeWindows(pairs(1, 8), episodes, 6).map(window => window.checks.length)).toEqual([4, 3])
  expect(episodeWindows(pairs(1, 3), episodes, 6)).toEqual([{ checks: pairs(1, 3), lines: { start: 1, end: 30 } }])
})

it('never spans an unscheduled boundary, so unread or partial episodes stay out of every window', () => {
  const checks = [...pairs(1, 3), ...pairs(5, 7)]
  expect(episodeWindows(checks, episodes, 6)).toEqual([
    { checks: pairs(1, 3), lines: { start: 1, end: 30 } },
    { checks: pairs(5, 7), lines: { start: 41, end: 70 } },
  ])
  expect(episodeWindows(pairs(1, 4), episodes, 1).map(window => window.lines)).toEqual([
    { start: 1, end: 20 }, { start: 11, end: 30 }, { start: 21, end: 40 },
  ])
})

it('fails loudly when a scheduled episode is absent from the same version index', () => {
  expect(() => episodeWindows([{ from_episode: 9, to_episode: 10 }], episodes, 6)).toThrow('CROSS_EPISODE_WINDOW')
})

it('names each rejected field path once and counts repeats across array items', () => {
  const parsed = continuityAssessmentSchema.safeParse({ findings: [], unknowns: [], episode_checks: [1, 2].map(from => ({
    from_episode: from, to_episode: from + 1, status: 'consistent', explanation: '承接成立。', evidence: [], unknowns: [] })) })
  expect(parsed.success).toBe(false)
  const summary = submissionIssueSummary(parsed.error?.issues ?? [])
  expect(summary).toMatch(/^status: /u)
  expect(summary).toContain('episode_checks[]: Unrecognized key: "unknowns" (2 items)')
  expect(submissionIssueSummary(z.object({}).strict().safeParse(1).error?.issues ?? [])).toMatch(/^\(root\): /u)
})
