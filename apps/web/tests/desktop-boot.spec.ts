// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const boot = vi.hoisted(() => ({
  run: vi.fn(),
  applyIndexInjections: vi.fn(async () => {}),
}))
vi.mock('@deepseek-ai/dsh-client-web', () => ({
  AppWebEntry: class { run = boot.run },
  applyIndexInjections: boot.applyIndexInjections,
}))

beforeEach(() => {
  boot.run.mockResolvedValue(undefined)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.resetModules()
  document.body.replaceChildren()
})

it('forwards client initialization failures to native recovery', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const gate = Promise.withResolvers<undefined>()
  const failed = vi.fn(async () => {})
  const failure = new Error('client plugin activation failed')
  boot.run.mockImplementationOnce(async (report: (reason: unknown) => void) => { report(failure) })
  vi.stubGlobal('__DSH_BOOT_READY__', gate)
  vi.stubGlobal('dshDesktopBoot', { ready: async () => ({ injections: [], streamBaseUrl: 'http://127.0.0.1:3080' }), failed,
    clientPluginsLoading: vi.fn(), clientPluginsLoaded: vi.fn(), uiInteractive: vi.fn() })
  vi.stubGlobal('__DSH_TRANSPORT__', undefined)
  await import('../src/main.ts')
  await gate.promise
  expect(boot.applyIndexInjections).toHaveBeenCalledWith([], expect.any(Function))
  await vi.waitFor(() => { expect(failed).toHaveBeenCalledWith('client plugin activation failed') })
})

it('rejects the shared boot wait when the Desktop Host cannot start', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const gate = Promise.withResolvers<undefined>()
  const failure = new Error('Host failed')
  const rejected = expect(gate.promise).rejects.toBe(failure)
  vi.stubGlobal('__DSH_BOOT_READY__', gate)
  vi.stubGlobal('dshDesktopBoot', { ready: async () => { throw failure }, failed: vi.fn(),
    clientPluginsLoading: vi.fn(), clientPluginsLoaded: vi.fn(), uiInteractive: vi.fn() })
  await import('../src/main.ts')
  await rejected
  expect(boot.applyIndexInjections).not.toHaveBeenCalled()
  expect(boot.run).toHaveBeenCalledWith(expect.any(Function))
})

it('leaves browser failure presentation with the Web boot kernel', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  vi.stubGlobal('dshDesktopBoot', undefined)
  await import('../src/main.ts')
  expect(boot.run).toHaveBeenCalledWith(undefined)
})

it.each(['root', 'readiness'])('reports missing %s before client plugin startup', async (missing) => {
  if (missing !== 'root') document.body.innerHTML = '<div id="root"></div>'
  const failed = vi.fn(async () => {})
  vi.stubGlobal('dshDesktopBoot', { ready: vi.fn(), failed,
    clientPluginsLoading: vi.fn(), clientPluginsLoaded: vi.fn(), uiInteractive: vi.fn() })
  vi.stubGlobal('__DSH_BOOT_READY__', undefined)
  await import('../src/main.ts')
  expect(failed).toHaveBeenCalledWith(missing === 'root'
    ? 'web app: missing #root' : 'desktop web: boot readiness is missing')
  expect(boot.run).not.toHaveBeenCalled()
})

it('reports plugin completion before a separately rendered interactive frame', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const gate = Promise.withResolvers<undefined>()
  const mounted = Promise.withResolvers<undefined>()
  const events: string[] = []
  boot.run.mockReturnValueOnce(mounted.promise)
  vi.stubGlobal('__DSH_BOOT_READY__', gate)
  vi.stubGlobal('dshDesktopBoot', {
    ready: async () => ({ injections: [], streamBaseUrl: 'http://127.0.0.1:3080' }),
    failed: vi.fn(),
    clientPluginsLoading: () => { events.push('loading') },
    clientPluginsLoaded: () => { events.push('loaded') },
    uiInteractive: () => { events.push('interactive') },
  })
  await import('../src/main.ts')
  expect(events).toEqual(['loading'])
  mounted.resolve(undefined)
  await vi.waitFor(() => { expect(events).toEqual(['loading', 'loaded', 'interactive']) })
})
