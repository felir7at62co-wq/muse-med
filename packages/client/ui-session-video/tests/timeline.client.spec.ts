/** Session filmstrips preserve exact source ranges across multiple generated files. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionVideoSource, SessionVideoSourceId, SessionVideoAnalysis, SessionVideoShotId } from '@deepseek-ai/dsh-session-video'
import { assembleTimeline } from '../src/client/timeline.ts'

function source(name: string): SessionVideoSource {
  return { id: brandString<SessionVideoSourceId>(name), label: name, origin: 'generated', path: `/work/${name}.mp4`, eventSeq: 4,
    presentedIndex: null, callId: 'call', status: 'local', version: 'v1', playbackUrl: `/api/session-video?id=${name}`, remoteUrl: null, issue: null }
}
function analysis(video: SessionVideoSource): SessionVideoAnalysis {
  return { sourceId: video.id, sourceVersion: 'v1', state: 'ready', durationSeconds: 6, width: 320, height: 180,
    method: 'ffmpeg-scene', threshold: 0.3, issue: null, shots: [
      { id: brandString<SessionVideoShotId>(`${video.id}-1`), index: 1, startSeconds: 0, endSeconds: 2, thumbnail: null },
      { id: brandString<SessionVideoShotId>(`${video.id}-2`), index: 2, startSeconds: 2, endSeconds: 6, thumbnail: null },
    ] }
}
it('concatenates sources while retaining the selected source-local regeneration range', () => {
  const a = source('first'), b = source('second')
  const result = assembleTimeline([a, b], [analysis(a), analysis(b)])
  expect(result.duration).toBe(12)
  expect(result.offsets[b.id]).toBe(6)
  expect(result.shots.map(shot => [shot.startSeconds, shot.endSeconds])).toEqual([[0, 2], [2, 6], [6, 8], [8, 12]])
  expect(result.shots[3]).toMatchObject({ index: 4, source: b, localStart: 2, localEnd: 6, id: 'second-2' })
})
it('does not present failed, pending or stale media as detected shots', () => {
  const a = source('first'), b = source('second')
  expect(assembleTimeline([a, b], [analysis(a), { ...analysis(b), sourceVersion: 'old' }]).shots).toHaveLength(2)
  expect(assembleTimeline([a], [{ ...analysis(a), state: 'failed' }]).shots).toEqual([])
  expect(assembleTimeline([a], []).duration).toBe(0)
})
