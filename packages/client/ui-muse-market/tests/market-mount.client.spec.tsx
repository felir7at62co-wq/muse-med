// @vitest-environment jsdom
/** Cordis service tracing is real here; the browser fixture owns HTTP and storage integration. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-muse-market/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mountMuseMarket } from '../src/client/mount.ts'
import type { MarketInjected } from '../src/client/market-actions.ts'
import * as client from '../src/client/index.ts'
import * as host from '../src/index.ts'

const { contribution } = vi.hoisted(() => ({
  contribution: { package: '@deepseek-ai/dsh-muse-market', descriptors: [] } satisfies TypertRemoteContribution,
}))
vi.mock('@deepseek-ai/dsh-muse-market/remote', () => ({ default: contribution }))

declare module '@deepseek-ai/cordis' {
  interface Context {
    'remote.museMarket': ClientRemote['museMarket']
    'remote.museMarketActivation': ClientRemote['museMarketActivation']
    'remote.museMarketCloud': ClientRemote['museMarketCloud']
  }
}

const unused = async (): Promise<never> => { throw new Error('Unexpected operation in namespace tracing test') }

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
  constructor(ctx: Context, private readonly calls: string[]) { super(ctx, 'remote') }
  async $mount(value: TypertRemoteContribution): Promise<() => Promise<void>> {
    expect(value).toBe(contribution)
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
  $on(event: string, callback: () => void): () => void {
    this.listeners.set(event, callback)
    return () => { this.listeners.delete(event) }
  }
  get museMarket(): ClientRemote['museMarket'] { return this.ctx['remote.museMarket'] }
  get museMarketActivation(): ClientRemote['museMarketActivation'] { return this.ctx['remote.museMarketActivation'] }
  get museMarketCloud(): ClientRemote['museMarketCloud'] { return this.ctx['remote.museMarketCloud'] }
}

it('keeps the Host entry inert and the browser entry explicitly injected', () => {
  expect(host.apply()).toBeUndefined()
  expect('default' in host).toBe(false)
  expect('default' in client).toBe(false)
  expect(client.inject).toEqual(['slots', 'locale', 'remote'])
})

it('uses declared traced namespaces in a plugin scope and keeps local operations usable when cloud fails', async () => {
  const ctx = new Context(), calls: string[] = []
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx)); ctx.provide('layout', { selectPanel: () => {} })
  ctx.slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
  } }, MarketRoot)
  let remote: TracedRemote | undefined
  await ctx.plugin((scope) => { remote = new TracedRemote(scope, calls) })
  if (remote === undefined) throw new Error('Market remote was not registered')
  for (let round = 0; round < 2; ++round) {
    const plugin = ctx.plugin(client)
    await plugin
    const panel = ctx.slots.entries('main')[0]
    const injected = panel?.inject?.() as MarketInjected | undefined
    if (injected === undefined) throw new Error('Market panel has no operations')
    expect(await injected.operations.installed()).toEqual([])
    expect(await injected.operations.defaults()).toEqual({ revision: 0, defaults: [] })
    await expect(injected.operations.identity()).rejects.toThrow('Cloud is offline')
    expect(await injected.operations.installed()).toEqual([])
    const access = injected.hooks.access
    const revision = access.getSnapshot().revision
    expect(injected.isCurrentAccess(revision)).toBe(true)
    ctx.emit('connection/reset')
    expect(injected.isCurrentAccess(revision)).toBe(false)
    const resetRevision = access.getSnapshot().revision
    remote.listeners.get('muse-account/session-changed')?.()
    expect(access.getSnapshot().revision).toBe(resetRevision + 1)
    remote.listeners.get('muse-market/inventory-changed')?.()
    expect(access.getSnapshot().inventoryRevision).toBe(1)
    remote.listeners.get('muse-market/defaults-changed')?.()
    expect(access.getSnapshot().inventoryRevision).toBe(2)
    await plugin.dispose()
    expect(remote.listeners.size).toBe(0)
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
