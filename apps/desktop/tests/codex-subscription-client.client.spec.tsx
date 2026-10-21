// @vitest-environment jsdom
/** Built community Codex browser entry against current Cordis, slots and primitives. */
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
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SlotRegistry } from '../../../packages/client/ui-renderer/src/client/registry.ts'
import { LocaleRuntime } from '../../../packages/client/locale/src/client/index.ts'

interface BrowserPlugin { inject: string[]; apply: (ctx: Context) => void }
interface BrowserRow { id: string; factory: (require: (name: string) => object) => BrowserPlugin }

const client = process.env['MUSE_CODEX_CLIENT_BUNDLE']
const previousLoader = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__')
let context: Context | undefined
afterEach(async () => {
  cleanup()
  await context?.fiber.dispose()
  context = undefined
  if (previousLoader === undefined) Reflect.deleteProperty(window, '__ModuleLoader__')
  else Object.defineProperty(window, '__ModuleLoader__', previousLoader)
  vi.unstubAllGlobals()
})

it.skipIf(client === undefined)('mounts login, changes the current model and removes all contributions on unload', async () => {
  if (client === undefined) throw new Error('MUSE_CODEX_CLIENT_BUNDLE must name the staged lib/client.js')
  const modules: Record<string, object> = {
    react, 'react/jsx-runtime': jsxRuntime, 'react-dom': reactDom,
    '@deepseek-ai/cordis': cordis,
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
    '@deepseek-ai/dsh-client-ui-slots': slots,
  }
  let plugin: BrowserPlugin | undefined
  Object.defineProperty(window, '__ModuleLoader__', { configurable: true, value: {
    load: (row: BrowserRow) => { plugin = row.factory((name) => {
      const value = modules[name]
      if (value === undefined) throw new Error(`Unexpected browser external ${name}`)
      return value
    }) },
  } })
  runInThisContext(readFileSync(client, 'utf8'), { filename: client })
  if (plugin === undefined) throw new Error('Browser bundle did not register its entry')
  const ctx = context = new Context()
  await ctx.plugin(SlotRegistry)
  const names: Record<string, { kind: 'list' | 'single' | 'keyed'; scope: 'root' | 'session' }> = {
    'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
    'conversation.input.right': { kind: 'list', scope: 'session' }, 'conversation.input.model': { kind: 'single', scope: 'session' },
    'conversation.input.attachments': { kind: 'single', scope: 'session' }, 'conversation.message.images': { kind: 'single', scope: 'session' },
    'conversation.trajectory.images': { kind: 'single', scope: 'session' }, 'conversation.input.left': { kind: 'list', scope: 'session' },
    'conversation.chat.node': { kind: 'keyed', scope: 'session' }, 'tool.call.toolview': { kind: 'keyed', scope: 'session' },
  }
  ctx.slots.register({ name: 'root', children: names }, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const requests: string[] = []
  const rpc = { call: vi.fn(async (_channel: string, method: string) => {
    requests.push(method)
    const endpoint = method.replace('codex-subscription/', '')
    if (endpoint === 'status') return { ok: true, value: { authenticated: false, accounts: [] } }
    if (endpoint === 'preferences/status') return { ok: true, value: { writable: true } }
    if (endpoint === 'preferences/models') return { ok: true, value: { contextModels: [], verbosityModels: [], fastModels: [] } }
    if (endpoint === 'login/start') return { ok: true, value: { id: 'fixture-login', phase: 'waiting_browser', authUrl: 'https://fixture.invalid/login' } }
    if (endpoint === 'diagnostics') return { ok: true, value: { pluginVersion: 'fixture' } }
    return { ok: true, value: {} }
  }) }
  ctx.provide('connection', { rpc })
  ctx.provide('remote', {})
  const listeners = new Set<() => void>()
  let state = { groups: [{ id: 'openai-codex', name: 'Codex', models: [
    { id: 'gpt-6-sol', name: 'GPT-6 Sol' }, { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  ] }], current: { provider: 'openai-codex', model: 'gpt-6-sol' }, status: 'ready', failures: [], error: null }
  const select = vi.fn(async (next: { provider: string; model: string }) => {
    state = { ...state, current: next }
    for (const notify of listeners) notify()
  })
  const directory = {
    store: {
      getSnapshot: () => state,
      subscribe: (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify) } },
    },
    load: async () => {}, select,
  }
  ctx.provide('modelDirectories', { directoryFor: () => directory })
  ctx.provide('sessions', { subagentAddress: () => undefined, scope: () => ctx })
  ctx.provide('conversation', {})
  ctx.provide('uiConversation', { events: { register: () => () => {} } })
  const fiber = ctx.plugin(plugin)
  await fiber.await()
  const settings = ctx.slots.entries('settings.section').find(entry => entry.options.id === 'codex-subscription')
  if (settings === undefined) throw new Error('Codex settings section was not registered')
  const props = settings.inject?.() ?? {}
  render(createElement(settings.component as ComponentType<Record<string, unknown>>, props))
  await waitFor(() => { expect(screen.getByRole('button', { name: /browser|浏览器/iu })).toBeDefined() })
  fireEvent.click(screen.getByRole('button', { name: /browser|浏览器/iu }))
  await waitFor(() => { expect(requests).toContain('codex-subscription/login/start') })
  expect(rpc.call).toHaveBeenCalledWith('/api', 'codex-subscription/login/start', { method: 'browser', openExternal: true }, expect.any(AbortSignal))
  cleanup()
  const picker = ctx.slots.entries('conversation.input.model')[0]
  if (picker === undefined) throw new Error('Codex model selector was not registered')
  const modelProps = picker.inject?.('fixture-session' as never) ?? {}
  render(createElement(picker.component as ComponentType<Record<string, unknown>>, { ...modelProps, locked: false, t: props['t'] }))
  fireEvent.click(screen.getByRole('button', { name: 'GPT-6 Sol' }))
  fireEvent.click(screen.getByRole('menuitem', { name: /Model|模型/u }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'GPT-6 Luna' }))
  await waitFor(() => { expect(select).toHaveBeenCalledWith({ provider: 'openai-codex', model: 'gpt-6-luna' }) })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'GPT-6 Luna' })).toBeDefined() })
  cleanup()
  await fiber.dispose()
  for (const name of Object.keys(names) as (keyof slots.SlotMap)[]) expect(ctx.slots.entries(name)).toHaveLength(0)
  expect(document.querySelector('style[data-plugin="dsh-codex-subscription"]')).toBeNull()
  expect(requests.some(method => method.includes('consume') || method.includes('image/'))).toBe(false)
})
