/** Source-owner admission rejects invalid batches, copied tokens and nested publication calls. */
import { readFile } from 'node:fs/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { ApprovedVideoSourceLease } from '../src/types.ts'
import { createVideoRecoveryFixture } from './fixtures/video-recovery-service.ts'

async function selected() {
  const f = await createVideoRecoveryFixture()
  await f.service.configure({ enabled: false, projectDir: f.project })
  await f.service.review({ ...f.input, action: 'approve' })
  onTestFinished(() => { expect(f.fetch).not.toHaveBeenCalled() })
  return { ...f, request: { items: [f.input], metadataMaxBytes: 65536 } }
}

const signal = () => new AbortController().signal

it.each([0, -1, 1.5, Number.NaN])('refuses metadata budget %s before entering a consumer', async (metadataMaxBytes) => {
  const f = await selected(), consume = vi.fn(async () => 'unexpected consumer')
  await expect(f.service.withApprovedSources({ ...f.request, metadataMaxBytes }, signal(), consume)).rejects.toThrow('validated metadata budget')
  expect(consume).not.toHaveBeenCalled()
})

it.each(['empty', 'duplicate'] as const)('refuses an %s original-key batch without dispatching work', async (kind) => {
  const f = await selected(), consume = vi.fn(async () => 'unexpected consumer')
  const items = kind === 'empty' ? [] : [f.input, f.input]
  await expect(f.service.withApprovedSources({ ...f.request, items }, signal(), consume)).rejects.toThrow('unique original keys')
  expect(consume).not.toHaveBeenCalled()
})

it('reports the saved selection through a cheap getter and refuses source access before selection', async () => {
  const f = await createVideoRecoveryFixture(), consume = vi.fn(async () => 'unexpected consumer')
  expect(f.service.selectedProjectDirectory()).toBeNull()
  await expect(f.service.withApprovedSources({ items: [f.input], metadataMaxBytes: 65536 }, signal(), consume))
    .rejects.toThrow('Select a Jubian project first')
  expect(consume).not.toHaveBeenCalled()
  await f.service.configure({ enabled: false, projectDir: f.project })
  expect(f.service.selectedProjectDirectory()).toBe(f.project)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('rejects a copied source token while permitting the exact original token from the same owner', async () => {
  const f = await selected()
  const admission = await f.service.withApprovedSources(f.request, signal(), async lease => lease.admission)
  const consume = vi.fn(async () => 'captured original')
  await expect(f.service.withApprovedSources(f.request, signal(), consume, undefined, { ...admission }))
    .rejects.toThrow('another recovery owner')
  expect(consume).not.toHaveBeenCalled()
  expect(await f.service.withApprovedSources(f.request, signal(), consume, undefined, admission)).toBe('captured original')
  expect(consume).toHaveBeenCalledTimes(1)
})

it('observes an already cancelled caller before entering the source consumer', async () => {
  const f = await selected(), caller = new AbortController(), consume = vi.fn(async () => 'unexpected consumer')
  const beforeCancel = vi.fn(async () => {})
  caller.abort('operator cancelled before admission')
  await expect(f.service.withApprovedSources(f.request, caller.signal, consume, beforeCancel)).rejects.toThrow()
  expect(consume).not.toHaveBeenCalled()
  expect(beforeCancel).toHaveBeenCalledExactlyOnceWith('caller-cancelled')
})

it('refuses a recovery RPC inside publication without changing the saved configuration', async () => {
  const f = await selected(), before = await readFile(f.settingsPath)
  await expect(f.service.withApprovedSources(f.request, signal(), async lease =>
    lease.commit(async () => f.service.status()))).rejects.toThrow('cannot be nested')
  expect(await readFile(f.settingsPath)).toEqual(before)
})

it('refuses rechecking a second active lease inside another lease publication', async () => {
  const f = await selected()
  await expect(f.service.withApprovedSources(f.request, signal(), async first =>
    f.service.withApprovedSources(f.request, signal(), async second => first.commit(() => second.recheck()))))
    .rejects.toThrow('cannot be nested')
})

it('refuses lease operations in the cancellation journal callback and joins the consumer afterwards', async () => {
  const f = await selected(), caller = new AbortController()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let lease: ApprovedVideoSourceLease | undefined, checked = false
  const operation = f.service.withApprovedSources(f.request, caller.signal, async (captured) => {
    lease = captured; entered.resolve(undefined); await release.promise; return 'consumer joined'
  }, async () => {
    try {
      if (lease === undefined) throw new Error('The actual consumer has not entered')
      const current = lease
      expect(() => { current.assertActive() }).toThrow('cannot be nested')
      await expect(current.recheck()).rejects.toThrow('cannot be nested')
      checked = true
    } finally { release.resolve(undefined) }
  })
  const rejected = expect(operation).rejects.toThrow()
  try { await entered.promise; caller.abort(new Error('Stop this source consumer')); await rejected }
  finally { release.resolve(undefined); await operation.catch(() => {}) }
  expect(checked).toBe(true)
})
