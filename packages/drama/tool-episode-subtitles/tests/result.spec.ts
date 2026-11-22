/** Build results stay compact enough for the result pruner, even for 100 episodes. */
import { expect, it } from 'vitest'
import type { BuildOutcome } from '../src/build.ts'
import { buildResult } from '../src/tool.ts'

it('keeps a 100-episode result under 3 KB and caps shot lists', () => {
  const statuses = ['ready', 'needs_review', 'waiting', 'blocked'] as const
  const asr = { newSeconds: 4120, pendingPacks: 3, retryAfter: 20 }
  const outcome: BuildOutcome = { asr, episodes: Array.from({ length: 100 }, (_value, index) => {
    const episode = index + 1, status = statuses[index % 4]!
    return status === 'blocked' ? { episode, status, reason: 'selection_missing', shots: Array.from({ length: 30 }, (_shot, shot) => shot + 1) }
      : status === 'waiting' ? { episode, status, changed: [] }
        : { episode, status, pending: status === 'ready' ? 0 : 3, changed: index % 8 === 1 ? [2, 4] : [] }
  }) }
  const result = buildResult(outcome, { source: 'local', project: 'projects/盛夏芬德拉' }, 'projects/盛夏芬德拉/editing/NN.srt')
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(3072)
  expect(result).toMatchObject({ status: 'waiting', asr: { new_seconds: 4120, pending_packs: 3, retry_after: 20 } })
  expect((result.blocked as { shots: number[]; more: number }[])[0]).toMatchObject({ shots: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], more: 20 })
})
