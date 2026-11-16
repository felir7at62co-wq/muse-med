// @vitest-environment jsdom
/** Exact Remote forwarding, account lifetimes, downloads and shell-owned feedback. */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { parseMarketIdentity, parseMarketUploadRequestId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import { archiveBase64, defaultFor, downloadMarketFile, marketFailureOutcome } from '../src/client/market-actions.ts'
import type { MarketActions, MarketOutcomeKey } from '../src/client/market-actions.ts'
import { MarketController, MarketAccessChanged } from '../src/client/market-controller.ts'
import { createMarketFeedback, MarketFeedbackOverlay } from '../src/client/market-feedback.tsx'
import { createMarketOperations } from '../src/client/market-remote.ts'
import { apply as applyHost } from '../src/index.ts'
import { marketEn } from '../src/client/market-locales.ts'
import { installation, operations, original, publication } from './discovery-fixtures.client.ts'
import { marketTranslate } from './market-fixtures.client.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('forwards every generated operation without replacing results, arguments or failures', async () => {
  const item = installation(), legacy = original(), pub = publication()
  const failure = new RemoteError('muse-market/cloud-failed', 'Conflict', { code: 'conflict', status: 409 })
  const fail = async (..._args: readonly unknown[]): Promise<RemoteResult<never>> => ({ ok: false, error: failure })
  const local = { sources: vi.fn(fail), prepare: vi.fn(fail), prepareUpload: vi.fn(fail),
    installed: vi.fn(async () => ({ ok: true as const, value: [item] })), importPackage: vi.fn(fail),
    exportPackage: vi.fn(fail), removePackage: vi.fn(fail) }
  const activation = { defaults: vi.fn(fail), setDefault: vi.fn(fail), binding: vi.fn(fail) }
  const cloud = { catalog: vi.fn(fail), legacyCatalog: vi.fn(fail), identity: vi.fn(fail), getPublication: vi.fn(fail),
    publishDraft: vi.fn(fail), installPublication: vi.fn(fail), installLegacy: vi.fn(fail), review: vi.fn(fail) }
  const remote = { museMarket: local, museMarketActivation: activation, museMarketCloud: cloud } satisfies
    Pick<ClientRemote, 'museMarket' | 'museMarketActivation' | 'museMarketCloud'>
  const actual = createMarketOperations(remote), controller = new MarketController(actual)
  const raw = { ...local, ...activation, ...cloud }, key = parseMarketUploadRequestId('exact-upload-key')
  const selection = { skillName: item.release.manifest.skills[0]!.name, expected: null, target: item.release.id }
  const session = { sessionId: brandString<SessionId>('snapshot-session') }
  for (const op of [actual, controller.operations]) {
    await expect(op.installed()).resolves.toEqual([item])
    const calls: Array<[keyof MarketActions, () => Promise<unknown>, readonly unknown[]]> = [
      ['sources', () => op.sources(), []],
      ['prepare', () => op.prepare(pub.manifest, 'storyboard-review'), [pub.manifest, 'storyboard-review']],
      ['prepareUpload', () => op.prepareUpload(item.release.id, 'storyboard-reviewer'), [item.release.id, 'storyboard-reviewer']],
      ['importPackage', () => op.importPackage('UEs='), ['UEs=']],
      ['exportPackage', () => op.exportPackage(item.release.id), [item.release.id]],
      ['removePackage', () => op.removePackage(item.release.id), [item.release.id]],
      ['defaults', () => op.defaults(), []],
      ['setDefault', () => op.setDefault(selection), [selection]],
      ['binding', () => op.binding(session), [session]],
      ['catalog', () => op.catalog('review', true), ['review', true]],
      ['catalog', () => op.catalog('review', false), ['review', false]],
      ['legacyCatalog', () => op.legacyCatalog('original'), ['original']],
      ['identity', () => op.identity(), []],
      ['getPublication', () => op.getPublication(pub.id), [pub.id]],
      ['publishDraft', () => op.publishDraft(item.release.id, pub.publisherId, key), [item.release.id, pub.publisherId, key]],
      ['installPublication', () => op.installPublication(pub.id, pub.sha256), [pub.id, pub.sha256]],
      ['installLegacy', () => op.installLegacy(legacy.id, legacy.sha256), [legacy.id, legacy.sha256]],
      ['review', () => op.review(pub.id, 1, 'reject', 'Add examples'), [pub.id, 1, 'reject', 'Add examples']],
    ]
    for (const [name, call, args] of calls) {
      await expect(call()).rejects.toBe(failure)
      expect(raw[name]).toHaveBeenLastCalledWith(...args)
    }
  }
  controller.dispose()
  applyHost()
})

it('revokes only current private work and does not restart disposed controllers', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['installed']>>>()
  const controller = new MarketController(operations({ installed: () => pending.promise }))
  const listener = vi.fn(), stop = controller.access.subscribe(listener)
  controller.invalidateInventory(); controller.invalidateInventory()
  expect(controller.access.getSnapshot().inventoryRevision).toBe(2)
  expect(listener).toHaveBeenCalledTimes(2)
  const result = controller.operations.installed(), rejected = expect(result).rejects.toBeInstanceOf(MarketAccessChanged)
  controller.dispose(); pending.resolve([]); await rejected
  controller.invalidateAccess(); controller.invalidateInventory(); stop()
  await expect(controller.operations.sources()).rejects.toBeInstanceOf(MarketAccessChanged)
  await expect(controller.operations.identity()).rejects.toBeInstanceOf(MarketAccessChanged)
  expect(listener).toHaveBeenCalledTimes(2)
})

it.each([null, 'offline', new Error('Disconnected'), { details: null }, { details: {} },
  { details: { status: 409, code: 'account-changed' } }])('revokes unverifiable private access once for %j', async (failure) => {
  const identity = parseMarketIdentity({ accountId: 'c'.repeat(16), publishers: [], admin: false })
  const controller = new MarketController(operations({ identity: async () => identity,
    getPublication: async () => { throw failure } }))
  await controller.operations.identity()
  const before = controller.access.getSnapshot().revision
  for (let attempt = 0; attempt < 2; ++attempt) await expect(controller.operations.getPublication(publication().id)).rejects.toBe(failure)
  expect(controller.access.getSnapshot()).toEqual({ revision: before + 1 })
  await controller.operations.identity()
  expect(controller.access.getSnapshot().identity).toEqual(identity)
  controller.dispose()
})

it('encodes all binary ZIP bytes and downloads the exact exported archive', async () => {
  vi.useFakeTimers()
  const bytes = Uint8Array.from({ length: 16390 }, (_, index) => index % 256)
  const file = new File([bytes], 'complete.zip', { type: 'application/zip' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
  const base64 = await archiveBase64(file)
  expect(Uint8Array.from(atob(base64), character => character.charCodeAt(0))).toEqual(bytes)
  let saved: Blob | undefined
  const createObjectURL = vi.fn((blob: Blob) => { saved = blob; return 'blob:market-test' })
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = createObjectURL; static override revokeObjectURL = revokeObjectURL })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('complete.zip'); expect(this.href).toBe('blob:market-test')
  })
  downloadMarketFile({ name: 'complete.zip', base64 })
  expect(click).toHaveBeenCalledOnce(); expect(saved?.type).toBe('application/zip'); expect(saved?.size).toBe(bytes.length)
  expect(revokeObjectURL).not.toHaveBeenCalled()
  await vi.runAllTimersAsync()
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:market-test')
})

it('finds defaults by the invoked Skill rather than a package alias', () => {
  const item = installation(), selected = { skillName: item.release.manifest.skills[0]!.name, releaseId: item.release.id }
  expect(defaultFor(item, { revision: 1, defaults: [selected] })).toBe(selected)
  expect(defaultFor(item, { revision: 1, defaults: [] })).toBeUndefined()
})

it.each<[unknown, MarketOutcomeKey]>([
  [null, 'failed'], ['offline', 'failed'], [new Error('Network error'), 'cloudUnavailable'],
  [{ code: 'muse-market/access-changed' }, 'signInRequired'], [{ details: null }, 'cloudUnavailable'],
  [{ details: { status: 401 } }, 'signInRequired'], [{ details: { status: 403 } }, 'permissionDenied'],
  [{ details: { status: 400 } }, 'failed'], [{ code: 'default-conflict' }, 'defaultConflict'],
  [{ code: 'release-in-use' }, 'releaseInUse'], [{ code: 'default-in-use' }, 'releaseInUse'],
  [{ code: 'account-changed' }, 'signInRequired'], [{ code: 'invalid-archive' }, 'invalidPackage'],
  [{ code: 'cloud-unavailable', status: 503 }, 'cloudUnavailable'], [{ code: 'unrecognized' }, 'cloudUnavailable'],
])('uses recovery copy for a carrier error without revealing its message: %j', (failure, expected) => {
  expect(marketFailureOutcome(failure)).toBe(expected)
})

it('keeps feedback in its shell host, dismisses it and ignores late reports after disposal', async () => {
  vi.useFakeTimers()
  const feedback = createMarketFeedback(), listener = vi.fn(), stop = feedback.hooks.outcome.subscribe(listener)
  const useOutcome = bindSnapshotSelector(feedback.hooks.outcome)
  render(<MarketFeedbackOverlay {...({} as GlobalStandardProps)} useOutcome={useOutcome} dismiss={feedback.dismiss} t={marketTranslate} />)
  expect(screen.queryByText(marketEn.done)).toBeNull()
  act(() => { feedback.report('done', false) })
  expect(screen.getByText(marketEn.done)).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(feedback.hooks.outcome.getSnapshot()).toBeNull()
  act(() => { feedback.report('permissionDenied', true) })
  expect(screen.getByText(marketEn.permissionDenied)).toBeTruthy()
  stop(); feedback.dispose(); feedback.report('done', false); feedback.dismiss()
  expect(feedback.hooks.outcome.getSnapshot()).toBeNull()
  expect(listener).toHaveBeenCalledTimes(3)
})
