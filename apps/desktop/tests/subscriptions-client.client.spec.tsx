// @vitest-environment jsdom
/** Exercise the built replacement with current slots, native attachment injection and login UI. */
import { readFileSync } from 'node:fs'
import { runInThisContext } from 'node:vm'
import { createElement, type ComponentType } from 'react'
import * as react from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as reactDom from 'react-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as cordis from '@deepseek-ai/cordis'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '../../../packages/client/ui-renderer/src/client/registry.ts'
import { LocaleRuntime } from '../../../packages/client/locale/src/client/index.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

interface BrowserPlugin { inject: string[]; apply: (ctx: Context) => void }
interface BrowserRow { factory: (require: (name: string) => object) => BrowserPlugin }
const client = process.env['MUSE_SUBSCRIPTIONS_CLIENT_BUNDLE']
let context: Context | undefined
const previousLoader = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__')
const previousDialogClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
afterEach(async () => {
  cleanup()
  await context?.fiber.dispose()
  context = undefined
  if (previousLoader === undefined) Reflect.deleteProperty(window, '__ModuleLoader__')
  else Object.defineProperty(window, '__ModuleLoader__', previousLoader)
  if (previousDialogClose === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  else Object.defineProperty(HTMLDialogElement.prototype, 'close', previousDialogClose)
  vi.restoreAllMocks()
})

it.skipIf(client === undefined)('keeps the native attachment entry mounted and opens the replacement login settings', async () => {
  if (client === undefined) throw new Error('MUSE_SUBSCRIPTIONS_CLIENT_BUNDLE must name the staged browser bundle')
  const modules: Record<string, object> = {
    react, 'react/jsx-runtime': jsxRuntime, 'react-dom': reactDom,
    '@deepseek-ai/cordis': cordis,
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
    '@deepseek-ai/dsh-client-ui-slots': slots,
  }
  let plugin: BrowserPlugin | undefined
  Object.defineProperty(window, '__ModuleLoader__', { configurable: true, value: {
    load: (row: BrowserRow) => { plugin = row.factory((name) => {
      const module = modules[name]
      if (module === undefined) throw new Error(`Unexpected browser external ${name}`)
      return module
    }) },
  } })
  runInThisContext(readFileSync(client, 'utf8'), { filename: client })
  if (plugin === undefined) throw new Error('Subscription browser entry did not register')
  const ctx = context = new Context()
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
    'conversation.input.right': { kind: 'list', scope: 'session' },
    'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
    'conversation.composer.dock': { kind: 'list', scope: 'session' },
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
  } }, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const readFileDrag = vi.fn()
  ctx.slots.register({ name: 'conversation.input.attachments', locale: 'conversation',
    inject: () => ({ readFileDrag }),
  }, (() => null) as never)
  const nativeAttachment = ctx.slots.entries('conversation.input.attachments')[0]
  const calls: string[] = []
  const rpc = { call: vi.fn(async (_channel: string, method: string) => {
    calls.push(method)
    const endpoint = method.replace('subscriptions-auth.', '')
    if (endpoint === 'status') return { ok: true, value: { providers: Object.fromEntries(
      ['codex', 'claude', 'grok', 'copilot', 'antigravity'].map(provider => [provider, { busy: false, accounts: [] }]),
    ) } }
    if (endpoint === 'providerSettings') return { ok: true, value: { codex: {} } }
    if (endpoint === 'proxyGet') return { ok: true, value: { enabled: false, url: '' } }
    if (endpoint === 'login') return { ok: true, value: { authorizeUrl: 'https://fixture.invalid/oauth' } }
    return { ok: true, value: {} }
  }) }
  ctx.provide('connection', { rpc })
  vi.spyOn(window, 'open').mockReturnValue(null)
  // jsdom omits the native dialog close method used by the unchanged settings page.
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true,
    value(this: HTMLDialogElement) { this.removeAttribute('open') },
  })
  const fiber = ctx.plugin(plugin)
  await fiber.await()
  expect(ctx.slots.entries('conversation.input.attachments')).toEqual([nativeAttachment])
  expect(nativeAttachment?.inject?.('fixture-session' as never)).toEqual({ readFileDrag })
  const settings = ctx.slots.entries('settings.section').find(entry => entry.options.id === 'subscriptions')
  if (settings === undefined) throw new Error('Subscription settings were not registered')
  render(createElement(settings.component as ComponentType<Record<string, unknown>>, settings.inject?.() ?? {}))
  await waitFor(() => { expect(calls).toContain('subscriptions-auth.status') })
  await waitFor(() => { expect(screen.getAllByRole('button', { name: /log in|登录|连接/iu }).length).toBeGreaterThan(0) })
  fireEvent.click(screen.getAllByRole('button', { name: /log in|登录|连接/iu })[0]!)
  await waitFor(() => { expect(calls).toContain('subscriptions-auth.login') })
  cleanup()
  await fiber.dispose()
  expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  expect(ctx.slots.entries('conversation.input.attachments')).toEqual([nativeAttachment])
  expect(document.querySelector('style[data-plugin="dsh-plugin-subscriptions"]')).toBeNull()
  expect(calls.some(method => /consume|image|video/u.test(method))).toBe(false)
})
