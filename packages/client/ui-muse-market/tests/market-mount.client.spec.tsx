// @vitest-environment jsdom
/** Cordis service tracing is real here; the browser fixture owns HTTP and storage integration. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-muse-market/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import marketRemote from '@deepseek-ai/dsh-muse-market/remote'
import * as BrowserEntry from '../src/client/index.ts'
import * as HostEntry from '../src/index.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mountMuseMarket } from '../src/client/mount.ts'
import type { MarketInjected } from '../src/client/market-actions.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    'remote.museMarket': ClientRemote['museMarket']
    'remote.museMarketActivation': ClientRemote['museMarketActivation']
    'remote.museMarketCloud': ClientRemote['museMarketCloud']
  }
}

const unused = async (): Promise<never> => { throw new Error('Unexpected operation in namespace tracing test') }
const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-muse-market', descriptors: [] }

function MarketRoot({ renderSlot }: PropsRenderSlots<'main' | 'sidebar.panellist' | 'settings.section' | 'shell.overlay'>) {
  return <>
    {renderSlot('main', {})}
    {renderSlot('sidebar.panellist', { size: 20, active: false })}
    {renderSlot('settings.section', { close: () => {} })}
    {renderSlot('shell.overlay', {})}
  </>
}

class TracedRemote extends Service {
  readonly listeners = new Map<string, () => void>()
  constructor(ctx: Context, private readonly calls: string[], private readonly expected = contribution) { super(ctx, 'remote') }
  async $mount(value: TypertRemoteContribution): Promise<() => Promise<void>> {
    expect(value).toBe(this.expected)
    const owner = this.ctx.plugin((scope) => {
      scope.provide('remote.museMarket', {
        sources: unused, prepare: unused, importPackage: unused, exportPackage: unused, removePackage: unused,
        installed: async () => { this.calls.push('installed'); return { ok: true, value: [] } },
      } satisfies ClientRemote['museMarket'])
      scope.provide('remote.museMarketActivation', {
        setDefault: unused, binding: unused,
        defaults: async () => { this.calls.push('defaults'); return { ok: true, value: { revision: 0, defaults: [] } } },
      } satisfies ClientRemote['museMarketActivation'])
      scope.provide('remote.museMarketCloud', {
        catalog: unused, getPublication: unused, publishDraft: unused, installPublication: unused, review: unused,
        identity: async () => { this.calls.push('identity'); throw new Error('Cloud is offline') },
      } satisfies ClientRemote['museMarketCloud'])
    })
    await owner
    return async () => { await owner.dispose() }
  }
  $on(event: string, listener: () => void): () => void {
    this.listeners.set(event, listener)
    return () => { this.listeners.delete(event) }
  }
  get museMarket(): ClientRemote['museMarket'] { return this.ctx['remote.museMarket'] }
  get museMarketActivation(): ClientRemote['museMarketActivation'] { return this.ctx['remote.museMarketActivation'] }
  get museMarketCloud(): ClientRemote['museMarketCloud'] { return this.ctx['remote.museMarketCloud'] }
}

it('uses declared traced namespaces in a plugin scope and keeps local operations usable when cloud fails', async () => {
  const ctx = new Context(), calls: string[] = []
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx)); ctx.provide('layout', { selectPanel: () => {} })
  ctx.slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
  } }, MarketRoot)
  await ctx.plugin((scope) => { new TracedRemote(scope, calls) })
  for (let round = 0; round < 2; ++round) {
    const plugin = ctx.plugin({ inject: ['slots', 'locale', 'remote'],
      apply: scope => mountMuseMarket(scope, contribution) })
    await plugin
    const panel = ctx.slots.entries('main')[0]
    const injected = panel?.inject?.() as MarketInjected | undefined
    if (injected === undefined) throw new Error('Market panel has no operations')
    expect(await injected.operations.installed()).toEqual([])
    expect(await injected.operations.defaults()).toEqual({ revision: 0, defaults: [] })
    await expect(injected.operations.identity()).rejects.toThrow('Cloud is offline')
    expect(await injected.operations.installed()).toEqual([])
    await plugin.dispose()
    expect(ctx.slots.entries('main')).toEqual([])
    expect(ctx.slots.entries('sidebar.panellist')).toEqual([])
    expect(ctx.get('remote.museMarket')).toBeUndefined()
    expect(ctx.get('remote.museMarketActivation')).toBeUndefined()
    expect(ctx.get('remote.museMarketCloud')).toBeUndefined()
  }
  expect(calls).toEqual(['installed', 'defaults', 'identity', 'installed', 'installed', 'defaults', 'identity', 'installed'])
})

it('releases the mounted namespaces when UI initialization fails', async () => {
  const ctx = new Context(), locale = new LocaleRuntime(ctx)
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', locale); ctx.provide('layout', { selectPanel: () => {} })
  await ctx.plugin((scope) => { new TracedRemote(scope, []) })
  const registration = vi.spyOn(locale, 'register').mockImplementation(() => { throw new Error('Locale initialization failed') })
  onTestFinished(() => { registration.mockRestore() })
  const plugin = ctx.plugin({ inject: ['slots', 'locale', 'remote'],
    apply: scope => mountMuseMarket(scope, contribution) })
  await expect(plugin).rejects.toThrow('Locale initialization failed')
  expect(ctx.get('remote.museMarket')).toBeUndefined()
  expect(ctx.get('remote.museMarketActivation')).toBeUndefined()
  expect(ctx.get('remote.museMarketCloud')).toBeUndefined()
})

it('loads the shipped browser descriptors and fences private and inventory callbacks until disposal', async () => {
  const ctx = new Context(), calls: string[] = []
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(HostEntry).await()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx)); ctx.provide('layout', { selectPanel: () => {} })
  ctx.slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
  } }, MarketRoot)
  const remote = new TracedRemote(ctx, calls, marketRemote)
  const dispose = await BrowserEntry.apply(ctx)
  const injected = ctx.slots.entries('main')[0]?.inject?.() as MarketInjected | undefined
  if (!injected) throw Error('Shipped browser entry did not register the market panel')
  const before = injected.hooks.access.getSnapshot()
  ctx.emit('connection/reset')
  remote.listeners.get('muse-account/session-changed')?.()
  expect(injected.hooks.access.getSnapshot().revision).toBe(before.revision + 2)
  remote.listeners.get('muse-market/inventory-changed')?.()
  remote.listeners.get('muse-market/defaults-changed')?.()
  expect(injected.hooks.access.getSnapshot().inventoryRevision).toBe(2)
  await dispose()
  expect(remote.listeners.size).toBe(0)
  expect(ctx.slots.entries('main')).toEqual([])
})
