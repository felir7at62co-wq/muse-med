/** The Session video store keeps selection, observer counts, and detection results consistent with the current inventory. */
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

const srcOf = (name: string, eventSeq: number): SessionVideoSource => ({ id: brandString<SessionVideoSourceId>(name), label: name,
  origin: 'generated', path: null, eventSeq, presentedIndex: null, callId: null, status: 'local', version: `${name}:v1`,
  playbackUrl: `/${name}`, remoteUrl: null, issue: null })
const inventoryOf = (...sources: SessionVideoSource[]) => ({ sessionId: SessionId('session'), sources, complete: true, issues: [] })

it('keeps the selected video open across an inventory refresh that still lists it and closes it once it disappears', () => {
  const a = srcOf('a', 1), b = srcOf('b', 2)
  const store = createVideoStore().create('session')
  store.actions.inventory(inventoryOf(a, b))
  store.actions.openSource(a.id)
  expect(store.store.getSnapshot()).toMatchObject({ selected: a.id, open: true })
  store.actions.inventory(inventoryOf(a))
  expect(store.store.getSnapshot()).toMatchObject({ selected: a.id, open: true })
  store.actions.inventory(inventoryOf(b))
  expect(store.store.getSnapshot()).toMatchObject({ selected: null, open: false })
})

it('toggles the history player and bumps the inventory revision on refresh', () => {
  const store = createVideoStore().create('session')
  store.actions.toggle()
  expect(store.store.getSnapshot().open).toBe(true)
  store.actions.toggle()
  expect(store.store.getSnapshot().open).toBe(false)
  store.actions.refreshInventory()
  expect(store.store.getSnapshot().inventoryRevision).toBe(1)
})

it('counts observers per source and drops the entry when the last observer leaves', () => {
  const store = createVideoStore().create('session')
  const id = brandString<SessionVideoSourceId>('a')
  store.actions.observe(id, 1)
  store.actions.observe(id, 1)
  expect(store.store.getSnapshot().observed[id]).toBe(2)
  store.actions.observe(id, -1)
  expect(store.store.getSnapshot().observed[id]).toBe(1)
  store.actions.observe(id, -1)
  expect(store.store.getSnapshot().observed).toEqual({})
})

it('retry keeps only ready analyses and clears detection errors', () => {
  const a = srcOf('a', 1), b = srcOf('b', 2)
  const store = createVideoStore().create('session')
  store.actions.inventory(inventoryOf(a, b))
  const base = { sourceVersion: 'a:v1', durationSeconds: 1, width: 1, height: 1, shots: [], method: 'ffmpeg-scene' as const,
    threshold: 0.3, issue: null }
  store.actions.analysis({ ...base, sourceId: a.id, state: 'ready' })
  store.actions.analysis({ ...base, sourceId: b.id, sourceVersion: 'b:v1', state: 'failed' })
  store.actions.detectionFailed(b.id, 'b:v1')
  store.actions.retryFailed()
  const snapshot = store.store.getSnapshot()
  expect(Object.keys(snapshot.analyses)).toEqual([a.id])
  expect(snapshot.detectErrors).toEqual({})
})
