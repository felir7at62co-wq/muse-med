/** Request lifetimes and account changes keep private callbacks out of a later market view. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { parseMarketIdentity } from '@deepseek-ai/dsh-muse-market/cloud-values'
import { MarketAccessChanged, MarketController } from '../src/client/market-controller.ts'
import type { MarketActions } from '../src/client/market-actions.ts'
import { installation, marketActions, metadata, publication, sources } from './market-fixtures.client.ts'
import { parseMarketUploadRequestId } from '@deepseek-ai/dsh-muse-market/cloud-values'

const account = (id: string) => parseMarketIdentity({ accountId: id.repeat(16), publishers: [], admin: false })
const unavailable = async (): Promise<never> => { throw new Error('Unexpected operation in this request-lifetime test') }
function operations(overrides: Partial<MarketActions> = {}): MarketActions {
  return { sources: unavailable, prepare: unavailable, installed: async () => [], importPackage: unavailable,
    exportPackage: unavailable, removePackage: unavailable, defaults: unavailable, setDefault: unavailable,
    binding: unavailable, catalog: async () => [], identity: async () => account('a'), getPublication: unavailable,
    installPublication: unavailable, publishDraft: unavailable, review: unavailable, ...overrides }
}

describe('market account request lifetimes', () => {
  it('forwards each local and cloud operation with its original arguments and value', async () => {
    const defaults = { revision: 1, defaults: [] }, binding = { phase: 'blank', releases: [] } as const
    const installed = [installation], catalog = [publication], exported = { name: 'writer.zip', base64: 'emlw' }
    const installedPublication = { publication, installation }
    const actual = {
      sources: vi.fn(async () => sources), prepare: vi.fn(async () => installation), installed: vi.fn(async () => installed),
      importPackage: vi.fn(async () => installation), exportPackage: vi.fn(async () => exported), removePackage: vi.fn(async () => {}),
      defaults: vi.fn(async () => defaults), setDefault: vi.fn(async () => defaults), binding: vi.fn(async () => binding),
      catalog: vi.fn(async () => catalog), identity: vi.fn(async () => account('a')), getPublication: vi.fn(async () => publication),
      publishDraft: vi.fn(async () => publication), installPublication: vi.fn(async () => installedPublication),
      review: vi.fn(async () => publication),
    }
    const controller = new MarketController(actual), actions = controller.operations
    onTestFinished(() => { controller.dispose() })
    const request = { skillName: 'writer', expected: null, target: installation.release.id }
    const bindingRequest = { sessionId: brandString<Parameters<MarketActions['binding']>[0]['sessionId']>('market-session') }
    const key = parseMarketUploadRequestId('original-upload')
    expect(await actions.sources()).toBe(sources)
    expect(await actions.prepare(metadata, 'writer')).toBe(installation)
    expect(actual.prepare).toHaveBeenCalledExactlyOnceWith(metadata, 'writer')
    expect(await actions.installed()).toBe(installed)
    expect(await actions.importPackage('emlw')).toBe(installation)
    expect(actual.importPackage).toHaveBeenCalledExactlyOnceWith('emlw')
    expect(await actions.exportPackage(installation.release.id)).toBe(exported)
    expect(actual.exportPackage).toHaveBeenCalledExactlyOnceWith(installation.release.id)
    await actions.removePackage(installation.release.id)
    expect(actual.removePackage).toHaveBeenCalledExactlyOnceWith(installation.release.id)
    expect(await actions.defaults()).toBe(defaults)
    expect(await actions.setDefault(request)).toBe(defaults)
    expect(actual.setDefault).toHaveBeenCalledExactlyOnceWith(request)
    expect(await actions.binding(bindingRequest)).toBe(binding)
    expect(actual.binding).toHaveBeenCalledExactlyOnceWith(bindingRequest)
    expect(await actions.catalog('writer', true)).toBe(catalog)
    expect(actual.catalog).toHaveBeenCalledExactlyOnceWith('writer', true)
    expect(await actions.getPublication(publication.id)).toBe(publication)
    expect(actual.getPublication).toHaveBeenCalledExactlyOnceWith(publication.id)
    expect(await actions.publishDraft(installation.release.id, publication.publisherId, key)).toBe(publication)
    expect(actual.publishDraft).toHaveBeenCalledExactlyOnceWith(installation.release.id, publication.publisherId, key)
    expect(await actions.installPublication(publication.id, publication.sha256)).toBe(installedPublication)
    expect(actual.installPublication).toHaveBeenCalledExactlyOnceWith(publication.id, publication.sha256)
    expect(await actions.review(publication.id, 2, 'submit', '')).toBe(publication)
    expect(actual.review).toHaveBeenCalledExactlyOnceWith(publication.id, 2, 'submit', '')
    expect(await actions.identity()).toEqual(account('a'))
  })

  it('rejects a local result and new private work after disposal', async () => {
    const pending = Promise.withResolvers<typeof sources>(), catalog = vi.fn(async () => [])
    const controller = new MarketController(marketActions({ sources: () => pending.promise, catalog }))
    const result = controller.operations.sources(), rejected = expect(result).rejects.toBeInstanceOf(MarketAccessChanged)
    controller.dispose()
    pending.resolve(sources)
    await rejected
    await expect(controller.operations.catalog('', true)).rejects.toBeInstanceOf(MarketAccessChanged)
    expect(catalog).not.toHaveBeenCalled()
    const state = controller.access.getSnapshot()
    controller.invalidateAccess(); controller.invalidateInventory()
    expect(controller.access.getSnapshot()).toBe(state)
  })

  it.each([
    [null, false], ['offline', false], [{}, false], [{ details: null }, false], [{ details: 'offline' }, false],
    [{ details: {} }, false], [{ details: { status: 400 } }, true], [{ details: { status: 409 } }, true],
    [{ details: { status: 403 } }, false], [{ details: { status: 409, code: 'account-changed' } }, false],
  ])('retains access only for an ordinary business refusal %#', async (error, retain) => {
    const controller = new MarketController(operations({ catalog: async () => { throw error } }))
    onTestFinished(() => { controller.dispose() })
    await controller.operations.identity()
    const initial = controller.access.getSnapshot()
    await expect(controller.operations.catalog('', true)).rejects.toBe(error)
    if (retain) expect(controller.access.getSnapshot()).toBe(initial)
    else expect(controller.access.getSnapshot()).toEqual({ revision: initial.revision + 1 })
  })

  it('publishes denial once and releases unsubscribed observers', async () => {
    const controller = new MarketController(operations({ catalog: async () => { throw new Error('offline') } }))
    onTestFinished(() => { controller.dispose() })
    const changed = vi.fn(), stop = controller.access.subscribe(changed)
    await expect(controller.operations.catalog('', true)).rejects.toThrow('offline')
    const denied = controller.access.getSnapshot()
    await expect(controller.operations.catalog('', true)).rejects.toThrow('offline')
    expect(controller.access.getSnapshot()).toBe(denied)
    expect(changed).toHaveBeenCalledOnce()
    controller.invalidateInventory(); controller.invalidateInventory()
    expect(controller.access.getSnapshot().inventoryRevision).toBe(2)
    stop()
    controller.invalidateAccess()
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it('rejects a private read that completes after logout while keeping local reads available', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['catalog']>>>()
    const controller = new MarketController(operations({ catalog: () => pending.promise }))
    await controller.operations.identity()
    const request = controller.operations.catalog('', true)
    const result = expect(request).rejects.toBeInstanceOf(MarketAccessChanged)
    controller.invalidateAccess()
    pending.resolve([])
    await result
    expect(controller.access.getSnapshot().identity).toBeUndefined()
    await expect(controller.operations.installed()).resolves.toEqual([])
    controller.dispose()
  })

  it('revokes a previous private capability when the cloud becomes unavailable', async () => {
    const controller = new MarketController(operations({ catalog: async () => {
      throw new RemoteError('muse-market/cloud-failed', 'Unavailable', { status: 503, code: 'cloud-unavailable' })
    } }))
    await controller.operations.identity()
    const revision = controller.access.getSnapshot().revision
    await expect(controller.operations.catalog('', true)).rejects.toMatchObject({ details: { status: 503 } })
    expect(controller.access.getSnapshot().identity).toBeUndefined()
    expect(controller.access.getSnapshot().revision).toBeGreaterThan(revision)
    await expect(controller.operations.installed()).resolves.toEqual([])
    controller.dispose()
  })

  it('does not let a slower identity request replace a newer account', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['identity']>>>()
    let calls = 0
    const controller = new MarketController(operations({ identity: () => ++calls === 1 ? pending.promise : Promise.resolve(account('b')) }))
    const first = controller.operations.identity()
    const result = expect(first).rejects.toBeInstanceOf(MarketAccessChanged)
    await controller.operations.identity()
    pending.resolve(account('a'))
    await result
    expect(controller.access.getSnapshot().identity?.accountId).toBe('b'.repeat(16))
    controller.dispose()
  })

  it('invalidates private work when a verified identity changes', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['catalog']>>>()
    let current = account('a')
    const controller = new MarketController(operations({ identity: async () => current, catalog: () => pending.promise }))
    await controller.operations.identity()
    const read = controller.operations.catalog('', true)
    const result = expect(read).rejects.toBeInstanceOf(MarketAccessChanged)
    current = account('b')
    await controller.operations.identity()
    pending.resolve([])
    await result
    expect(controller.access.getSnapshot().identity?.accountId).toBe('b'.repeat(16))
    controller.dispose()
  })

  it('suppresses callbacks and observable updates after plugin disposal', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['identity']>>>()
    const controller = new MarketController(operations({ identity: () => pending.promise }))
    let notifications = 0
    const stop = controller.access.subscribe(() => { notifications++ })
    const request = controller.operations.identity()
    const result = expect(request).rejects.toBeInstanceOf(MarketAccessChanged)
    controller.dispose()
    pending.resolve(account('a'))
    await result
    expect(notifications).toBe(0)
    await expect(controller.operations.installed()).rejects.toBeInstanceOf(MarketAccessChanged)
    stop()
  })
})
