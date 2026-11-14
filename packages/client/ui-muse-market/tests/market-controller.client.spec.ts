/** Request lifetimes and account changes keep private callbacks out of a later market view. */
import { describe, expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { parseMarketIdentity } from '@deepseek-ai/dsh-muse-market/cloud-values'
import { MarketAccessChanged, MarketController } from '../src/client/market-controller.ts'
import type { MarketActions } from '../src/client/market-actions.ts'

const account = (id: string) => parseMarketIdentity({ accountId: id.repeat(16), publishers: [], admin: false })
const unavailable = async (): Promise<never> => { throw new Error('Unexpected operation in this request-lifetime test') }
function operations(overrides: Partial<MarketActions> = {}): MarketActions {
  return { sources: unavailable, prepare: unavailable, installed: async () => [], importPackage: unavailable,
    exportPackage: unavailable, removePackage: unavailable, defaults: unavailable, setDefault: unavailable,
    binding: unavailable, catalog: async () => [], identity: async () => account('a'), getPublication: unavailable,
    installPublication: unavailable, publishDraft: unavailable, review: unavailable, ...overrides }
}

describe('market account request lifetimes', () => {
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

  it('rejects local results arriving after disposal and refuses new private requests', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['installed']>>>()
    const controller = new MarketController(operations({ installed: () => pending.promise }))
    const read = expect(controller.operations.installed()).rejects.toBeInstanceOf(MarketAccessChanged)
    controller.dispose()
    controller.invalidateAccess(); controller.invalidateInventory()
    pending.resolve([])
    await read
    await expect(controller.operations.catalog('', false)).rejects.toBeInstanceOf(MarketAccessChanged)
    expect(controller.access.getSnapshot()).toEqual({ revision: 0 })
  })

  it('refreshes local inventory without revoking the verified account', async () => {
    const controller = new MarketController(operations())
    await controller.operations.identity()
    controller.invalidateInventory(); controller.invalidateInventory()
    expect(controller.access.getSnapshot()).toEqual({ revision: 0, inventoryRevision: 2, identity: account('a') })
    controller.dispose()
  })

  it.each([
    { error: null, revoke: true }, { error: { details: null }, revoke: true },
    { error: { details: {} }, revoke: true }, { error: { details: { status: 400 } }, revoke: false },
    { error: { details: { status: 409 } }, revoke: false },
    { error: { details: { status: 409, code: 'account-changed' } }, revoke: true },
  ])('revokes authority according to the structured remote failure $error', async ({ error, revoke }) => {
    const controller = new MarketController(operations({ catalog: async () => { throw error } }))
    await controller.operations.identity()
    await expect(controller.operations.catalog('', true)).rejects.toBe(error)
    expect(controller.access.getSnapshot().revision).toBe(revoke ? 1 : 0)
    await expect(controller.operations.catalog('', true)).rejects.toBe(error)
    expect(controller.access.getSnapshot().revision).toBe(revoke ? 1 : 0)
    controller.dispose()
  })
})
