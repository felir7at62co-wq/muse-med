/** Session catalogue refreshes retain usable options and own their outstanding reads. */
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { VideoDirectory, type VideoSelectionClient } from '../src/client/video-directory.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionVideoSelection, VideoModelOption } from '../src/video-session-types.ts'

const option: VideoModelOption = { key: '61:480p', standardId: 61, modelId: 'seedance-25',
  modelName: 'Seedance 2.5', platformId: 'CHANNEL', resolution: '480p', genTypes: [3], ratios: ['9:16'], maxDurationSeconds: 30 }
const options = [option]
function fixture() {
  const read = Promise.withResolvers<RemoteResult<VideoModelOption[]>>()
  const catalogue = vi.fn(() => read.promise)
  const remote: VideoSelectionClient = {
    defaults: async () => ({ ok: true, value: null }),
    catalogue,
    select: vi.fn<VideoSelectionClient['select']>(async () => ({ ok: true, value: { ...option, revision: 1 } })),
  }
  const directory = new VideoDirectory(remote, SessionId('video-directory-fixture'), createSnapshotStore({ ...option, revision: 1 }))
  return { directory, catalogue, read }
}

it('shares an in-flight prefetch with menu opens and retains cached options during later refreshes', async () => {
  const { directory, catalogue, read } = fixture()
  const next = Promise.withResolvers<RemoteResult<VideoModelOption[]>>()
  try {
    const prefetch = directory.load()
    const opened = directory.load()
    expect(catalogue).toHaveBeenCalledTimes(1)
    read.resolve({ ok: true, value: options })
    await Promise.all([prefetch, opened])
    catalogue.mockReturnValueOnce(next.promise)
    const refresh = directory.load()
    expect(directory.store.getSnapshot()).toMatchObject({ options, loading: true })
    next.resolve({ ok: true, value: [...options, { ...option, key: '61:720p', resolution: '720p' }] })
    await refresh
    expect(directory.store.getSnapshot().options).toHaveLength(2)
    expect(directory.store.getSnapshot().current?.resolution).toBe('480p')
  } finally { read.resolve({ ok: true, value: options }); next.resolve({ ok: true, value: options }); await directory.dispose() }
})

it('retains the last catalogue on failure and permits a later successful refresh', async () => {
  const { directory, catalogue, read } = fixture()
  try {
    read.resolve({ ok: true, value: options })
    await directory.load()
    catalogue.mockRejectedValueOnce(new Error('unavailable'))
    await directory.load()
    expect(directory.store.getSnapshot()).toMatchObject({ options, loading: false, error: 'unavailable' })
    await directory.load()
    expect(directory.store.getSnapshot()).toMatchObject({ options, error: null })
  } finally { await directory.dispose() }
})

it('awaits the owned catalogue read on disposal without publishing late results', async () => {
  const { directory, catalogue, read } = fixture()
  const loading = directory.load()
  const closing = directory.dispose()
  const before = directory.store.getSnapshot()
  read.resolve({ ok: true, value: options })
  await Promise.all([loading, closing])
  expect(directory.store.getSnapshot()).toBe(before)
  await directory.load()
  expect(catalogue).toHaveBeenCalledTimes(1)
})

it('displays defaults without resuming an Agent and clears a catalogue failure on retry', async () => {
  const defaults = { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', resolution: '480p' }
  const initial = { ...option, ...defaults }
  const selection = createSnapshotStore<SessionVideoSelection | null | undefined>(undefined)
  const select = vi.fn<VideoSelectionClient['select']>()
  const watch = vi.fn(async function* () { throw new Error('Agent resume must not be attempted') })
  const catalogue = vi.fn<VideoSelectionClient['catalogue']>(async () => ({ ok: true, value: [initial] }))
    .mockRejectedValueOnce(new Error('catalogue unavailable'))
  const remote: VideoSelectionClient & { watch: typeof watch } = {
    defaults: async () => ({ ok: true, value: defaults }),
    catalogue, select, watch,
  }
  const directory = new VideoDirectory(remote, SessionId('resume-default'), selection)
  try {
    await directory.load()
    expect(directory.store.getSnapshot()).toMatchObject({ current: null, defaultModel: null })
    expect(directory.store.getSnapshot().error).toBe('catalogue unavailable')
    selection.set(null)
    expect(directory.store.getSnapshot()).toMatchObject({ current: null, defaultModel: defaults })
    await directory.load()
    expect(directory.store.getSnapshot()).toMatchObject({ current: null, defaultModel: defaults, error: null })
    expect(watch).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  } finally { await directory.dispose() }
})

it('keeps an old explicit choice ahead of a late default response and ignores stale projection revisions', async () => {
  const defaults = Promise.withResolvers<RemoteResult<{ modelId: string; platformId: string; resolution: string } | null>>()
  const saved = { ...option, modelName: 'Explicit old choice', resolution: '720p', revision: 4 }
  const selection = createSnapshotStore<SessionVideoSelection | null>(saved)
  const select = vi.fn<VideoSelectionClient['select']>()
  const remote: VideoSelectionClient = {
    defaults: () => defaults.promise,
    catalogue: async () => ({ ok: true, value: options }), select,
  }
  const directory = new VideoDirectory(remote, SessionId('saved-default'), selection)
  try {
    const loading = directory.load()
    expect(directory.store.getSnapshot().current).toEqual(saved)
    defaults.resolve({ ok: true, value: { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', resolution: '480p' } })
    await loading
    selection.set(null)
    selection.set({ ...option, revision: 1 })
    expect(directory.store.getSnapshot()).toMatchObject({ current: saved, defaultModel: null })
    expect(select).not.toHaveBeenCalled()
  } finally { defaults.resolve({ ok: true, value: null }); await directory.dispose() }
})

it('does not replace a newer projected choice with a late select response', async () => {
  const older = { ...option, revision: 2 }
  const saved = { ...option, resolution: '720p', revision: 4 }
  const selection = createSnapshotStore<SessionVideoSelection | null>(older)
  const result = Promise.withResolvers<RemoteResult<SessionVideoSelection>>()
  const remote: VideoSelectionClient = {
    defaults: async () => ({ ok: true, value: null }),
    catalogue: async () => ({ ok: true, value: options }), select: () => result.promise,
  }
  const directory = new VideoDirectory(remote, SessionId('late-video-state'), selection)
  try {
    await directory.load()
    const selecting = directory.select(option.key)
    selection.set(saved)
    result.resolve({ ok: true, value: { ...option, revision: 3 } })
    await selecting
    expect(directory.store.getSnapshot()).toMatchObject({ current: saved, defaultModel: null, selecting: false, error: null })
  } finally { result.resolve({ ok: true, value: saved }); await directory.dispose() }
})
