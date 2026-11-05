// @vitest-environment jsdom
/** Built Deep View cards against the shipped Client registries and React primitives. */
import { readFileSync } from 'node:fs'
import { runInThisContext } from 'node:vm'
import { createElement, type ComponentType } from 'react'
import * as react from 'react'
import * as reactDom from 'react-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotRegistry } from '../../../packages/client/ui-renderer/src/client/registry.ts'
import { LocaleRuntime } from '../../../packages/client/locale/src/client/index.ts'
import { ConversationEventRegistry } from '../../../packages/client/ui-conversation/src/client/conversation/event-registry.ts'
import { CHAT_NODE_INJECT } from '../../../packages/client/ui-chat/src/client/apply.ts'

interface BrowserPlugin { inject: string[]; apply(ctx: Context): void }
interface BrowserRow { id: string; factory(require: (name: string) => object): BrowserPlugin }

const bundle = process.env['MUSE_DEEP_VIEW_CLIENT_BUNDLE']
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

it.skipIf(bundle === undefined)('registers ordinary-session cards, submits one answer and removes its contributions', async () => {
  if (bundle === undefined) throw new Error('MUSE_DEEP_VIEW_CLIENT_BUNDLE must name the staged client.js')
  const modules: Record<string, object> = { react, 'react-dom': reactDom, '@deepseek-ai/dsh-client-ui-primitives': primitives }
  let plugin: BrowserPlugin | undefined
  Object.defineProperty(window, '__ModuleLoader__', { configurable: true, value: {
    load: (row: BrowserRow) => { plugin = row.factory((name) => {
      const value = modules[name]
      if (value === undefined) throw new Error(`Unexpected browser external ${name}`)
      return value
    }) },
  } })
  runInThisContext(readFileSync(bundle, 'utf8'), { filename: bundle })
  if (plugin === undefined) throw new Error('Deep View did not register its browser entry')
  const ctx = context = new Context()
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
    'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
  } }, (_props: PropsRenderSlots<'conversation.chat.turnTail' | 'conversation.chat.node'>) => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const events = new ConversationEventRegistry(ctx)
  ctx.provide('uiConversation', { events })
  const fiber = ctx.plugin(plugin)
  await fiber.await()
  expect(events.entries().map(entry => entry.kind)).toEqual(['deep-view-views', 'deep-view-reply'])
  const entry = ctx.slots.entries('conversation.chat.turnTail').find(value => value.options.id === 'deep-view-views')
  if (entry === undefined) throw new Error('Deep View did not mount its native turn-tail slot')
  const choices = { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] }
  const record = { id: 'view-1', callId: 'call-1', title: 'Choose a source', view: choices, askedAt: 1 }
  const requests: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected card request')
    requests.push({ op: 'op' in body ? body.op : undefined,
      sessionId: 'sessionId' in body ? body.sessionId : undefined, viewId: 'viewId' in body ? body.viewId : undefined })
    return Response.json({ ok: true, value: 'op' in body && body.op === 'pending' ? record : true })
  }))
  const data = { views: [{ callId: 'call-1', args: { title: record.title, view: choices } }] }
  const turn = { data: { source: () => ({ getSnapshot: () => data, subscribe: () => () => {} }) } }
  const props = entry.inject?.() ?? {}
  render(createElement(entry.component as ComponentType<Record<string, unknown>>, {
    ...props, turn, sessionId: 'deep-view-session',
    useConversation: (select: (value: object) => unknown) => select({ views: new Map() }),
  }))
  const option = await screen.findByRole('button', { name: /A/u })
  fireEvent.click(option)
  await waitFor(() => { expect(requests.some(request => request.op === 'reply')).toBe(true) })
  expect(requests.filter(request => request.op === 'reply')).toHaveLength(1)
  expect(requests.find(request => request.op === 'reply')).toMatchObject({ sessionId: 'deep-view-session', viewId: 'view-1' })
  cleanup()
  await fiber.dispose()
  expect(events.entries()).toEqual([])
  expect(ctx.slots.entries('conversation.chat.turnTail')).toEqual([])
  expect(document.querySelector('style[data-plugin="deep-view"]')).toBeNull()
})
