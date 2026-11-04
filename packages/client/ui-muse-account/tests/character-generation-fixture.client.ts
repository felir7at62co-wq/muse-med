/* Deterministic in-memory generation tasks using prepared artwork, never a live image service. */
import { stockDirectorAnimation } from '../src/client/market-stock-art.ts'
import type { CharacterAnimation, CharacterCandidate, CharacterGenerationActions, CharacterJob, CharacterJobId,
  CharacterCandidateId, CharacterVersionId } from '../src/client/market-character-generation.ts'

/** Prepared sprite shared with the real website's labeled sample artwork. */
export const directorAnimation: CharacterAnimation = stockDirectorAnimation

/** Create preview-only task storage and a one-shot failure callback owned by the harness.
 * @param fail Whether the next task should fail after entering the running state.
 * @returns A stable adapter whose operations do not contact a generation service.
 */
export function createCharacterGenerationPreview(fail: () => boolean): CharacterGenerationActions {
  let sequence = 0
  const jobs = new Map<CharacterJobId, { reads: number; completed: CharacterJob }>()
  const start = (completed: CharacterJob): CharacterJob => {
    jobs.set(completed.id, { reads: 0, completed })
    return { id: completed.id, kind: completed.kind, status: 'queued' }
  }
  return {
    mode: 'preview', pollIntervalMs: 500, timeoutMs: 30000,
    startPortraits: async (brief, signal) => {
      signal.throwIfAborted(); ++sequence
      const candidate: CharacterCandidate = { ...brief, id: `preview-portrait-${sequence}` as CharacterCandidateId,
        posterUrl: new URL('../src/client/assets/storyboard-director-chibi.png', import.meta.url).href }
      return start({ id: `preview-job-${sequence}` as CharacterJobId, kind: 'portraits', status: 'succeeded', candidates: [candidate] })
    },
    startAnimation: async (candidate, signal) => {
      signal.throwIfAborted(); ++sequence
      return start({ id: `preview-job-${sequence}` as CharacterJobId, kind: 'animation', status: 'succeeded',
        version: { id: `preview-character-${sequence}` as CharacterVersionId, candidate, animation: directorAnimation } })
    },
    readJob: async (id, signal) => {
      signal.throwIfAborted()
      const entry = jobs.get(id)
      if (!entry) throw new Error('missing-preview-job')
      if (++entry.reads === 1) return { id, kind: entry.completed.kind, status: 'running' }
      jobs.delete(id)
      return fail() ? { id, kind: entry.completed.kind, status: 'failed' } : entry.completed
    },
  }
}
