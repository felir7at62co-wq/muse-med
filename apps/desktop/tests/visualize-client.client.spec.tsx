// @vitest-environment jsdom
/** Final Visualize browser artifact through real Slots, selector hooks and Session scopes. */
import { readFileSync } from 'node:fs'
import { runInThisContext } from 'node:vm'
import { createElement } from 'react'
import * as react from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as reactDom from 'react-dom'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderSlots, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { InputZone, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SlotRegistry } from '../../../packages/client/ui-renderer/src/client/registry.ts'
import { createSlotRenderer } from '../../../packages/client/ui-renderer/src/client/scoped-slots.tsx'
import { renderSessionArea } from '../../../packages/client/ui-session/src/client/session-provider.tsx'
import { ConversationEventRegistry } from '../../../packages/client/ui-conversation/src/client/conversation/event-registry.ts'

interface BrowserPlugin { inject: string[]; apply(ctx: Context): void }
interface BrowserRow { id: string; factory(require: (name: string) => object): BrowserPlugin }
interface ComposerFixture { draft: string; attachmentIds: string[]; occurrences: string[]; changes: string[]; notices: string[] }
const bundle = process.env['MUSE_VISUALIZE_CLIENT_BUNDLE']
const previousLoader = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__')
const contexts: Context[] = []
afterEach(async () => {
  cleanup()
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
  contexts.length = 0
  if (previousLoader === undefined) Reflect.deleteProperty(window, '__ModuleLoader__')
  else Object.defineProperty(window, '__ModuleLoader__', previousLoader)
  vi.unstubAllGlobals()
})
function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: T) => { value = next; for (const listener of listeners) listener() },
  }
}

it.skipIf(bundle === undefined)('renders the packed plugin with native Session injection and protects frame and composer ownership', async () => {
  if (bundle === undefined) throw new Error('MUSE_VISUALIZE_CLIENT_BUNDLE must name the final lib/client.js')
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('URL', class extends URL { static override createObjectURL() { return 'blob:unused' } })
  const modules: Record<string, object> = { react, 'react/jsx-runtime': jsxRuntime, 'react-dom': reactDom }
  let plugin: BrowserPlugin | undefined
  Object.defineProperty(window, '__ModuleLoader__', { configurable: true, value: { load: (row: BrowserRow) => {
    plugin = row.factory((name) => {
      const value = modules[name]
      if (value === undefined) throw new Error(`Unexpected browser external ${name}`)
      return value
    })
  } } })
  runInThisContext(readFileSync(bundle, 'utf8'), { filename: bundle })
  if (plugin === undefined) throw new Error('Visualize browser entry did not register')
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SlotRegistry)
  ctx.slots.install(createSlotRenderer())
  const locale = source({ active: 'en' })
  ctx.provide('locale', locale)
  ctx.provide('configForms', { get: () => source({ value: { transcriptView: 'standard' } }) })
  const events = new ConversationEventRegistry(ctx)
  ctx.provide('uiConversation', { events })
  const scopes = new Map<string, Context>(), bindings = new Map<string, ReturnType<typeof source<StandardSourceBinding>>>()
  const inputs = new Map<string, ComposerFixture>()
  const streams = new Map<string, ReturnType<typeof source<{ callId: string; argsRaw: string } | undefined>>>()
  const references: SessionReference[] = []
  const meta = { kind: 'visualize', title: 'Actual card', fragment: '<div>verified chart</div>', mode: 'inline', path: 'same-card', style: 'whale' }
  const cards = [{ callId: 'call-viz', seq: 3, meta }]
  const turnData = { get: () => ({ cards }), source: () => source(undefined) }
  const turn = { turn: 1, start: undefined, end: undefined, status: 'closed', steps: [], data: turnData } as TurnLocation
  for (const id of ['visual-a', 'visual-b']) {
    const scope = new Context(); contexts.push(scope); scopes.set(id, scope)
    const input: ComposerFixture = { draft: '', attachmentIds: [], occurrences: [], changes: [], notices: [] }
    inputs.set(id, input)
    scope.provide('conversation', { input: { for: () => ({
      state: { getSnapshot: () => ({ ...input, phase: 'plain' }) },
      setDraft: (text: string) => { input.draft = text; input.changes.push(text) },
      notify: (_level: string, text: string) => { input.notices.push(text) }, focus: () => {},
    }) } })
    const stream = source<{ callId: string; argsRaw: string } | undefined>(undefined)
    streams.set(id, stream)
    const streamingTurn = { ...turn, data: { get: () => undefined, source: () => stream } } as TurnLocation
    const binding = { key: id, ctx: scope, props: { sessionId: id },
      hooks: { chat: source({ timeline: { turnOrder: [1], turns: new Map([[1, streamingTurn]]) } }) }, keyedHooks: {} }
    bindings.set(id, source<StandardSourceBinding>(binding))
    const controllerBinding = { sessionId: id, ctx: scope } as SessionBinding
    references.push({ sessionId: id as SessionId, binding: controllerBinding,
      ready: Promise.resolve(controllerBinding), release: () => {}, [Symbol.dispose]: () => {} })
  }
  ctx.provide('sessions', { scope: (id: string) => scopes.get(id) })
  const absent = source<StandardSourceBinding>({ key: undefined, props: {}, hooks: {}, keyedHooks: {} })
  ctx.slots.installScope('session', { current: absent, bindingSource: reference => reference === undefined ? absent : bindings.get(reference.sessionId) ?? absent, renderArea: renderSessionArea })
  type FrameProps = PropsRenderSlots<'tool.call.toolview' | 'conversation.input.dock' | 'conversation.chat.turnTail' | 'settings.section'>
  const owner: ToolCallOwnerProps = { phase: 'result', callId: 'call-viz', toolName: 'visualize',
    block: { kind: 'tool-result', seq: 3, time: 1, callId: 'call-viz', name: 'visualize', args: PartialArguments.EMPTY,
      call: { name: 'visualize', argsRaw: '{}' }, callTime: 1, content: [], isError: false, meta, subCalls: [] },
    openFile: () => {}, loadImage: async () => { throw new Error('No image expected') }, useDisclosure: () => ({ expanded: false, setExpanded: () => {}, toggle: () => {} }) }
  let selectPage: (value: boolean) => void = () => { throw new Error('Fixture root is not mounted') }
  ctx.slots.register({ name: 'root', children: {
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    'conversation.input.dock': { kind: 'list', scope: 'session' },
    'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
    'settings.section': { kind: 'list', scope: 'root' },
  } }, ({ SessionProvider, renderSlot }: FrameProps) => {
    const [page, setPage] = react.useState(false)
    selectPage = setPage
    const toolOwner: ToolCallOwnerProps = page ? { ...owner, block: { ...owner.block, meta: { ...meta, mode: 'page' } } } : owner
    return <>{references.map(reference =>
      <SessionProvider key={reference.sessionId} session={reference}><div data-viz-session={reference.sessionId}>
        {renderSlot('tool.call.toolview', toolOwner, { entryKey: 'visualize' })}
        {renderSlot('conversation.input.dock', {} as InputZone)}
        {renderSlot('conversation.chat.turnTail', { turn, seq: 4, openFile: () => {} })}
      </div></SessionProvider>)}</>
  })
  const fiber = await ctx.plugin(plugin)
  expect(events.entries().map(entry => entry.kind).sort()).toEqual(['dsh-visualize', 'dsh-visualize-stream'])
  expect(ctx.slots.entries('settings.section').some(entry => entry.options.id === 'dsh-visualize')).toBe(true)
  const view = render(createElement(react.Fragment, null, ctx.slots.renderSlot('root', {})))
  const frameA = view.container.querySelector<HTMLIFrameElement>('[data-viz-session="visual-a"] iframe')
  const frameB = view.container.querySelector<HTMLIFrameElement>('[data-viz-session="visual-b"] iframe')
  if (frameA === null || frameB === null) throw new Error('Native session slots did not render visualization frames')
  expect(frameA.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frameA.getAttribute('srcdoc')).toContain('var PROMPT_TOKEN = "call-viz"')
  expect(view.container.querySelector('[data-slot-error]')).toBeNull()
  const message = (
    frame: HTMLIFrameElement, type: string, data: Record<string, unknown>, sourceWindow: MessageEventSource | null = frame.contentWindow,
  ) => {
    act(() => { window.dispatchEvent(new MessageEvent('message', { source: sourceWindow, data: { type, token: 'call-viz', ...data } })) })
  }
  message(frameA, 'dsh-visualize:height', { height: 650 }, frameB.contentWindow)
  expect(frameA.style.height).toBe('48px')
  message(frameA, 'dsh-visualize:height', { height: 321 })
  expect(frameA.style.height).toBe('321px')
  const streamA = streams.get('visual-a')
  if (streamA === undefined) throw new Error('Missing fixture stream')
  await act(async () => { streamA.set({ callId: 'stream-call', argsRaw: '{"fragment":"<div>stream preview</div>"}' }) })
  const preview = view.container.querySelector<HTMLIFrameElement>('[data-viz-session="visual-a"] iframe[title="Visualization streaming preview"]')
  if (preview === null) throw new Error('Native useChat and Turn source did not render the streaming preview')
  message(preview, 'dsh-visualize:height', { token: 'streaming-preview', height: 500 }, frameB.contentWindow)
  expect(preview.style.height).toBe('0px')
  message(preview, 'dsh-visualize:height', { token: 'streaming-preview', height: 123 })
  expect(preview.style.height).toBe('123px')
  await act(async () => { streamA.set(undefined) })
  expect(view.container.querySelector('iframe[title="Visualization streaming preview"]')).toBeNull()
  const inputA = inputs.get('visual-a'), inputB = inputs.get('visual-b')
  if (inputA === undefined || inputB === undefined) throw new Error('Missing fixture composer')
  const prompt = (frame: HTMLIFrameElement, text: string) => { frame.focus(); message(frame, 'dsh-visualize:prompt', { text }) }
  prompt(frameA, 'draft for A')
  expect(inputA.draft).toBe('draft for A')
  expect(inputB.draft).toBe('')
  inputB.attachmentIds = ['keep-image']
  prompt(frameB, 'replace attachments')
  expect(inputB.draft).toBe('')
  expect(inputB.attachmentIds).toEqual(['keep-image'])
  expect(inputB.changes).toEqual([])
  expect(inputB.notices).toHaveLength(1)
  await act(async () => { locale.set({ active: 'zh-CN' }) })
  await waitFor(() => { expect(view.container.querySelector('button')?.getAttribute('aria-label')).toBe('在新窗口打开') })
  vi.stubGlobal('dshDesktop', { protocolVersion: 1 })
  vi.stubGlobal('URL', class extends URL { static override createObjectURL() { return 'blob:unused' } })
  expect(typeof window.open).toBe('function')
  expect(typeof URL.createObjectURL).toBe('function')
  await act(async () => { locale.set({ active: 'en' }) })
  expect(view.container.querySelectorAll('button')).toHaveLength(0)
  await act(async () => { selectPage(true) })
  const page = view.container.querySelector('[data-viz-session="visual-a"] [data-visualize-launcher]')
  expect(page).not.toBeNull()
  expect(page?.querySelectorAll('button')).toHaveLength(0)
  const desktopFrame = page?.querySelector('iframe')
  expect(desktopFrame?.getAttribute('sandbox')).toBe('allow-scripts')
  expect(desktopFrame?.getAttribute('srcdoc')).toContain('.viz-page-header')
  expect(desktopFrame?.style.pointerEvents).not.toBe('none')
  cleanup()
  await fiber.dispose()
  expect(events.entries()).toEqual([])
  for (const slot of ['tool.call.toolview', 'conversation.input.dock', 'conversation.chat.turnTail', 'settings.section'] as const) expect(ctx.slots.entries(slot)).toEqual([])
  // Reapplying the same artifact must not claim its previous draft as replaceable card text.
  await ctx.plugin(plugin)
  const reopened = render(createElement(react.Fragment, null, ctx.slots.renderSlot('root', {})))
  const reloaded = reopened.container.querySelector<HTMLIFrameElement>('[data-viz-session="visual-a"] iframe')
  if (reloaded === null) throw new Error('Reloaded visualization frame missing')
  prompt(reloaded, 'replacement after reload')
  expect(inputA.draft).toBe('draft for A')
  expect(inputA.changes).toEqual(['draft for A'])
})
