/** Session catalogue refreshes retain usable options and own their outstanding reads. */
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { VideoDirectory, type VideoSelectionClient } from '../src/client/video-directory.ts'
import type { VideoModelOption } from '../src/video-session-types.ts'

const option: VideoModelOption = { key: '61:480p', standardId: 61, modelId: 'seedance-25',
  modelName: 'Seedance 2.5', platformId: 'CHANNEL', resolution: '480p', genTypes: [3], ratios: ['9:16'], maxDurationSeconds: 30 }
const options = [option]
function fixture() {
  const read = Promise.withResolvers<RemoteResult<VideoModelOption[]>>()
  const catalogue = vi.fn(() => read.promise)
  const remote: VideoSelectionClient = {
    catalogue,
    select: vi.fn<VideoSelectionClient['select']>(async () => ({ ok: true, value: { ...option, revision: 1 } })),
    async *watch(_session, signal) {
      const stopped = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      yield { ...option, revision: 1 }
      await stopped
    },
  }
  const directory = new VideoDirectory(remote, SessionId('video-directory-fixture'))
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
