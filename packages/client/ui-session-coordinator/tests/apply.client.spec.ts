// @vitest-environment jsdom
/** The coordinator client plugin mounts its Remote, hides the retained Main Session and reports failures. */
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import type { ReportCardActions } from '../src/client/ReportCard.tsx'
import type { TaskToastInjected } from '../src/client/TaskToast.tsx'

afterEach(() => { vi.restoreAllMocks() })

type Step<T> = { readonly value: T } | { readonly error: unknown }

/** A hand-driven async stream: tests push values or a failure and observe how far the consumer read it. */
function channel<T>() {
  const steps: PromiseWithResolvers<Step<T>>[] = [Promise.withResolvers()]
  let tail = 0
  let requested = 0
  let closed = false
  return {
    push(step: Step<T>): void { steps[tail]!.resolve(step); steps.push(Promise.withResolvers()); tail++ },
    /** Number of values the consumer asked for; it exceeds `n` once the consumer handled value `n - 1`. */
    requested: (): number => requested,
    /** Whether the stream ended because the consumer stopped reading or a pushed failure was thrown. */
    closed: (): boolean => closed,
    async *stream(): AsyncGenerator<T> {
      try {
        for (let index = 0; ; index++) {
          requested = index + 1
          const step = await steps[index]!.promise
          if ('error' in step) throw step.error
          yield step.value
        }
      } finally { closed = true }
    },
  }
}

/** Let every pending promise continuation run; the stubbed streams settle without timers. */
const drain = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** Record a registration and remove it again when its disposer runs. */
function track<T>(list: T[], item: T): () => void {
  list.push(item)
  return () => { list.splice(list.indexOf(item), 1) }
}

type Entry = { readonly name: string; readonly key?: string; readonly id?: string; readonly inject: () => object }
type Ok<T> = { readonly ok: true; readonly value: T } | { readonly ok: false }
type Result = { ok: boolean; value?: unknown; error?: unknown }
type Provider = { readonly protocol: string; open(address: string, options: { signal: AbortSignal }): AsyncIterable<Result> }

/** Build a Browser context stub, run `apply` against it and expose everything the plugin registered. */
async function mount(options: {
  readonly openMain?: () => Promise<Ok<SessionId>>
  readonly watchMain?: (signal: AbortSignal) => AsyncIterable<SessionId | null>
  readonly watch?: (id: SessionId, signal: AbortSignal) => AsyncIterable<unknown>
  readonly openInitialSession?: (
    open: (navigation: { aborted: boolean }) => Promise<SessionId | undefined>,
    signal: AbortSignal,
  ) => Promise<void>
  readonly fiberFails?: Error
} = {}) {
  const disposers: (() => void)[] = []
  const handlers: (() => void)[] = []
  const guards = new Map<string, () => () => void>()
  const entries: Entry[] = []
  const hidden: SessionId[] = []
  const unhidden: SessionId[] = []
  const opened: SessionId[] = []
  const resources: Provider[] = []
  const definitions: unknown[] = []
  const dictionaries: unknown[] = []
  const filters: ((id: SessionId) => boolean)[] = []
  const openedResources: string[] = []
  const disposeRemote = vi.fn(async () => {})
  const mounted: unknown[] = []
  const scope = {
    effect: (install: () => (() => void) | undefined) => { const dispose = install(); if (dispose) disposers.push(dispose) },
    on: (_event: string, handler: () => void) => track(handlers, handler),
    locale: { register: (_ns: string, dictionary: unknown) => track(dictionaries, dictionary) },
    resources: { register: (provider: Provider) => track(resources, provider) },
    uiConversation: { events: { register: (definition: unknown) => track(definitions, definition) } },
    slots: {
      inject: (_name: string, install: () => (() => void) | undefined) => {
        const dispose = install()
        if (dispose) disposers.push(dispose)
      },
      register: (entry: Entry) => track(entries, entry),
    },
    uiWorkspace: {
      hideSession: (id: SessionId) => { hidden.push(id); return () => { unhidden.push(id) } },
      openSession: (id: SessionId) => { opened.push(id) },
      openInitialSession: options.openInitialSession
        ?? (async (open: (navigation: { aborted: boolean }) => Promise<SessionId | undefined>) => { await open({ aborted: false }) }),
      registerBlankSessionFilter: (filter: (id: SessionId) => boolean) => track(filters, filter),
    },
    sidebarRight: { openResource: (address: string) => { openedResources.push(address) } },
    remoteAccess: { whenAccess: (action: string, install: () => () => void) => { guards.set(action, install); return () => {} } },
    remote: {
      sessionCoordinator: {
        openMain: options.openMain ?? (async () => ({ ok: true as const, value: SessionId('main') })),
        watchMain: options.watchMain ?? (() => channel<SessionId | null>().stream()),
        watch: options.watch ?? (() => channel<unknown>().stream()),
      },
    },
  }
  const fiber = {
    await: async () => { if (options.fiberFails) throw options.fiberFails },
    dispose: vi.fn(async () => { for (const dispose of disposers.splice(0).reverse()) dispose() }),
  }
  const ctx = {
    remote: { $mount: async (remote: unknown) => { mounted.push(remote); return disposeRemote } },
    inject: (_deps: string[], callback: (scope: unknown) => void) => { callback(scope); return fiber },
  }
  const settled = await apply(ctx as never).then(dispose => ({ dispose }), (error: unknown) => ({ error }))
  const entry = (name: string): Entry => entries.find(candidate => candidate.name === name)!
  return {
    failure: 'error' in settled ? settled.error : undefined,
    dispose: (): Promise<void> => {
      if ('error' in settled) throw new Error('apply failed', { cause: settled.error })
      return settled.dispose()
    },
    fiber, disposeRemote, mounted, guards, entries, entry, hidden, unhidden, opened, resources, definitions,
    dictionaries, filters, openedResources, handlers,
    notice: () => (entry('shell.overlay').inject() as TaskToastInjected).hooks.taskNotice.getSnapshot(),
    dismiss: () => { (entry('shell.overlay').inject() as TaskToastInjected).dismiss() },
    reportActions: () => entry('conversation.chat.node').inject() as ReportCardActions,
    openMain: () => (entry('sidebar.workspaces.entry').inject() as { openMain(): Promise<void> }).openMain(),
  }
}

it('declares the Browser services it uses before mounting', () => {
  expect(inject).toEqual(expect.arrayContaining(['slots', 'locale', 'remote', 'resources', 'uiWorkspace', 'remoteAccess', 'uiConversation', 'sidebarRight']))
})

it('registers dictionaries, the task resource, the report definition and three slot entries, and removes them on dispose', async () => {
  const mounted = await mount()
  expect(mounted.mounted).toHaveLength(1)
  expect(mounted.dictionaries).toHaveLength(1)
  expect(mounted.resources.map(provider => provider.protocol)).toEqual(['muse-tasks'])
  expect(mounted.definitions).toHaveLength(1)
  expect(mounted.entries.map(entry => entry.key ?? entry.id).sort()).toEqual(['muse-coordination-report', 'muse-coordination-toast', 'muse-main-session'])
  await mounted.dispose()
  expect(mounted.fiber.dispose).toHaveBeenCalledOnce()
  expect(mounted.disposeRemote).toHaveBeenCalledOnce()
  expect(mounted.dictionaries).toEqual([])
  expect(mounted.resources).toEqual([])
  expect(mounted.definitions).toEqual([])
  expect(mounted.entries).toEqual([])
})

it('disposes the Remote mount and the fiber and rethrows when the fiber fails to settle', async () => {
  const failure = new Error('fiber failed')
  const mounted = await mount({ fiberFails: failure })
  expect(mounted.failure).toBe(failure)
  expect(mounted.fiber.dispose).toHaveBeenCalledOnce()
  expect(mounted.disposeRemote).toHaveBeenCalledOnce()
})

it('routes report card actions to the workspace and the right-hand resource viewer', async () => {
  const mounted = await mount()
  const actions = mounted.reportActions()
  actions.openExecution(SessionId('worker'))
  actions.openDelivery(SessionId('worker'), '/work', '/work/out/report.md')
  expect(mounted.opened).toEqual([SessionId('worker')])
  expect(mounted.openedResources).toEqual([fileAddressFor('worker', '/work', '/work/out/report.md')])
})

it('streams task records for the percent-decoded session address and reports a typed stream failure as a result error', async () => {
  const feed = channel<unknown>()
  const watch = vi.fn(() => feed.stream())
  const mounted = await mount({ watch })
  const provider = mounted.resources[0]!
  const received: Result[] = []
  const controller = new AbortController()
  const reading = (async () => { for await (const item of provider.open('muse-tasks://session/main%20one', { signal: controller.signal })) received.push(item) })()
  feed.push({ value: [{ id: 't1' }] })
  feed.push({ error: new RemoteError('gateway/internal', 'boom', {}) })
  await reading
  expect(watch).toHaveBeenCalledWith(SessionId('main one'), controller.signal)
  expect(received[0]).toEqual({ ok: true, value: [{ id: 't1' }] })
  expect(received[1]).toMatchObject({ ok: false, error: { code: 'gateway/internal', message: 'boom' } })
})

it('reports an untyped stream failure as an unavailable task status and stays silent after abort', async () => {
  const feed = channel<unknown>()
  const mounted = await mount({ watch: () => feed.stream() })
  const provider = mounted.resources[0]!
  const live: Result[] = []
  const first = (async () => { for await (const item of provider.open('muse-tasks://session/main', { signal: new AbortController().signal })) live.push(item) })()
  feed.push({ error: new Error('socket closed') })
  await first
  expect(live).toMatchObject([{ ok: false, error: { code: 'gateway/internal', message: 'Task status is unavailable' } }])

  const aborted = new AbortController()
  const quiet = channel<unknown>()
  const silent = await mount({ watch: () => quiet.stream() })
  const seen: Result[] = []
  const second = (async () => { for await (const item of silent.resources[0]!.open('muse-tasks://session/main', { signal: aborted.signal })) seen.push(item) })()
  aborted.abort()
  quiet.push({ error: new Error('closed after abort') })
  await second
  expect(seen).toEqual([])
})

it('opens the initial Main Session and hides it from the Workspace browser', async () => {
  let target: SessionId | undefined
  const mounted = await mount({ openInitialSession: async (open) => { target = await open({ aborted: false }) } })
  mounted.guards.get('sessionCoordinator/openMain')!()
  await vi.waitFor(() => { expect(target).toBe(SessionId('main')) })
  expect(mounted.hidden).toEqual([SessionId('main')])
  expect(mounted.notice()).toBeNull()
})

it('ignores an initial open that was superseded, and reports a failed initial open', async () => {
  let navigated: SessionId | undefined = SessionId('unset')
  const aborted = await mount({
    openInitialSession: async (open) => { navigated = await open({ aborted: true }) },
  })
  aborted.guards.get('sessionCoordinator/openMain')!()
  await vi.waitFor(() => { expect(navigated).toBeUndefined() })
  expect(aborted.hidden).toEqual([])
  expect(aborted.notice()).toBeNull()

  const refused = await mount({ openMain: async () => ({ ok: false }) })
  refused.guards.get('sessionCoordinator/openMain')!()
  await vi.waitFor(() => { expect(refused.notice()).toMatchObject({ key: 'failedMain', success: false }) })
  expect(refused.hidden).toEqual([])
})

it('warns and shows the failure notice when the initial navigation rejects, and retries after a connection reset', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const attempts = vi.fn(async () => { throw new Error('offline') })
  const mounted = await mount({ openInitialSession: attempts })
  mounted.guards.get('sessionCoordinator/openMain')!()
  await vi.waitFor(() => { expect(mounted.notice()).toMatchObject({ key: 'failedMain', seq: 1 }) })
  expect(warn).toHaveBeenCalledWith('Initial Main Session unavailable:', expect.objectContaining({ message: 'offline' }))
  mounted.handlers.at(-1)!()
  await vi.waitFor(() => { expect(mounted.notice()).toMatchObject({ key: 'failedMain', seq: 2 }) })
  expect(attempts).toHaveBeenCalledTimes(2)
})

it('hides the watched Main Session, reuses no blank Session until its identity is known nor the Main Session itself, and withdraws both on revocation', async () => {
  const feed = channel<SessionId | null>()
  const mounted = await mount({ watchMain: () => feed.stream() })
  const withdraw = mounted.guards.get('sessionCoordinator/watchMain')!()
  const filter = mounted.filters[0]!
  expect(filter(SessionId('other'))).toBe(false)
  feed.push({ value: SessionId('main') })
  await vi.waitFor(() => { expect(mounted.hidden).toEqual([SessionId('main')]) })
  expect(filter(SessionId('other'))).toBe(true)
  expect(filter(SessionId('main'))).toBe(false)
  feed.push({ value: SessionId('main') })
  feed.push({ value: SessionId('next') })
  await vi.waitFor(() => { expect(mounted.hidden).toEqual([SessionId('main'), SessionId('next')]) })
  expect(mounted.unhidden).toEqual([SessionId('main')])
  withdraw()
  expect(mounted.filters).toEqual([])
  expect(mounted.unhidden).toEqual([SessionId('main'), SessionId('next')])
  expect(filter(SessionId('other'))).toBe(false)
})

it('reveals the Main Session when the watch reports none, unless a newer identity was installed meanwhile', async () => {
  const feed = channel<SessionId | null>()
  const mounted = await mount({ watchMain: () => feed.stream() })
  mounted.guards.get('sessionCoordinator/watchMain')!()
  feed.push({ value: SessionId('main') })
  await vi.waitFor(() => { expect(mounted.hidden).toEqual([SessionId('main')]) })
  feed.push({ value: null })
  await vi.waitFor(() => { expect(mounted.unhidden).toEqual([SessionId('main')]) })
  expect(mounted.filters[0]!(SessionId('main'))).toBe(true)

  const raced = channel<SessionId | null>()
  const second = await mount({ watchMain: () => raced.stream() })
  second.guards.get('sessionCoordinator/watchMain')!()
  await second.openMain()
  expect(second.hidden).toEqual([SessionId('main')])
  raced.push({ value: null })
  await vi.waitFor(() => { expect(raced.requested()).toBe(2) })
  expect(second.unhidden).toEqual([])
  expect(second.filters[0]!(SessionId('main'))).toBe(false)
  expect(second.filters[0]!(SessionId('other'))).toBe(true)
})

it('restarts the identity watch after a connection reset and ignores values from the replaced watch', async () => {
  const feeds: ReturnType<typeof channel<SessionId | null>>[] = []
  const mounted = await mount({ watchMain: () => { const feed = channel<SessionId | null>(); feeds.push(feed); return feed.stream() } })
  mounted.guards.get('sessionCoordinator/watchMain')!()
  expect(feeds).toHaveLength(1)
  mounted.handlers.at(-1)!()
  expect(feeds).toHaveLength(2)
  feeds[0]!.push({ value: SessionId('stale') })
  feeds[1]!.push({ value: SessionId('fresh') })
  await vi.waitFor(() => { expect(feeds[0]!.closed()).toBe(true) })
  await vi.waitFor(() => { expect(mounted.hidden).toEqual([SessionId('fresh')]) })
})

it('warns and shows the failure notice when the identity watch fails, but not after it was withdrawn', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const feed = channel<SessionId | null>()
  const mounted = await mount({ watchMain: () => feed.stream() })
  mounted.guards.get('sessionCoordinator/watchMain')!()
  feed.push({ error: new Error('watch lost') })
  await vi.waitFor(() => { expect(mounted.notice()).toMatchObject({ key: 'failedMain', success: false }) })
  expect(warn).toHaveBeenCalledWith('Main Session identity unavailable:', expect.objectContaining({ message: 'watch lost' }))

  const late = channel<SessionId | null>()
  const withdrawn = await mount({ watchMain: () => late.stream() })
  const withdraw = withdrawn.guards.get('sessionCoordinator/watchMain')!()
  withdraw()
  late.push({ error: new Error('after withdraw') })
  await vi.waitFor(() => { expect(late.closed()).toBe(true) })
  await drain()
  expect(withdrawn.notice()).toBeNull()
  expect(warn).toHaveBeenCalledTimes(1)
})

it('stops reading the identity watch once it was withdrawn even if a value was already queued', async () => {
  const feed = channel<SessionId | null>()
  const mounted = await mount({ watchMain: () => feed.stream() })
  const withdraw = mounted.guards.get('sessionCoordinator/watchMain')!()
  withdraw()
  feed.push({ value: SessionId('late') })
  await vi.waitFor(() => { expect(feed.closed()).toBe(true) })
  expect(mounted.hidden).toEqual([])
})

it('opens the retained Main Session from the sidebar entry on every request, hides each new identity once and reports a refusal', async () => {
  const ids = [SessionId('main'), SessionId('main'), SessionId('moved')]
  const mounted = await mount({ openMain: async () => ({ ok: true, value: ids.shift()! }) })
  await mounted.openMain()
  await mounted.openMain()
  await mounted.openMain()
  expect(mounted.opened).toEqual([SessionId('main'), SessionId('main'), SessionId('moved')])
  expect(mounted.hidden).toEqual([SessionId('main'), SessionId('moved')])
  expect(mounted.unhidden).toEqual([SessionId('main')])

  const refused = await mount({ openMain: async () => ({ ok: false }) })
  await refused.openMain()
  expect(refused.opened).toEqual([])
  expect(refused.notice()).toMatchObject({ key: 'failedMain', success: false })
})

it('clears the notice when the toast is dismissed', async () => {
  const mounted = await mount({ openMain: async () => ({ ok: false }) })
  await mounted.openMain()
  expect(mounted.notice()).not.toBeNull()
  mounted.dismiss()
  expect(mounted.notice()).toBeNull()
})

it('reveals the hidden Main Session when the plugin is disposed', async () => {
  const mounted = await mount()
  await mounted.openMain()
  await mounted.dispose()
  expect(mounted.unhidden).toEqual([SessionId('main')])
})
