/** Version changes discard obsolete detection errors and failed results. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionVideoAnalysis, SessionVideoSource, SessionVideoSourceId } from '@deepseek-ai/dsh-session-video'
import { createVideoStore } from '../src/client/store.ts'

it('forgets a provider error across download and eviction, including delayed failures', () => {
  const id = brandString<SessionVideoSourceId>('provider')
  const remote: SessionVideoSource = { id, label: 'provider', origin: 'generated', path: null, eventSeq: 1,
    presentedIndex: null, callId: null, status: 'remote-only', version: 'url:v1',
    playbackUrl: 'https://101.aigc.jubianai.net/test.mp4', remoteUrl: 'https://101.aigc.jubianai.net/test.mp4', issue: null }
  const local: SessionVideoSource = { ...remote, status: 'local', version: 'file:v1', playbackUrl: '/local' }
  const failed: SessionVideoAnalysis = { sourceId: id, sourceVersion: 'url:v1', state: 'failed', durationSeconds: null,
    width: null, height: null, shots: [], method: 'ffmpeg-scene', threshold: 0.3, issue: 'unavailable' }
  const store = createVideoStore().create('session')
  const inventory = (source: SessionVideoSource) => { store.actions.inventory({ sessionId: SessionId('session'), sources: [source], complete: true, issues: [] }) }
  inventory(remote)
  store.actions.detectionFailed(id, 'url:v1')
  store.actions.analysis(failed)
  inventory(remote)
  expect(store.store.getSnapshot().detectErrors[id]).toBe('url:v1')
  expect(store.store.getSnapshot().analyses[id]).toEqual(failed)
  inventory(local)
  expect(store.store.getSnapshot().detectErrors[id]).toBeUndefined()
  expect(store.store.getSnapshot().analyses[id]).toBeUndefined()
  const current = { ...failed, state: 'ready' as const, durationSeconds: 1, sourceVersion: 'file:v1' }
  store.actions.analysis(current)
  store.actions.detectionFailed(id, 'url:v1')
  store.actions.analysis(failed)
  store.actions.analysis({ ...failed, state: 'ready', durationSeconds: 1, sourceVersion: 'url:v1' })
  expect(store.store.getSnapshot().analyses[id]).toEqual(current)
  inventory(remote)
  expect(store.store.getSnapshot().detectErrors[id]).toBeUndefined()
  expect(store.store.getSnapshot().analyses[id]).toBeUndefined()
})
