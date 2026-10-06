/**
 * The plugin's registrations, and their removal when the plugin goes.
 *
 * The registry is real, because "registered" means what it says a type is; the
 * slot, locale, and Remote faces are recorders, because what matters here is
 * what was handed to them — one body seat under the type's id with its store
 * and face — and that every registration is gone after dispose, which is what
 * makes a reload safe.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ShortcutCommand } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { WorkspaceFileReferenceActions, WorkspaceFileDragTicket } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { FILES_ID, FILES_KIND } from '../src/client/definition.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { FilesBody } from '../src/client/FilesBody.tsx'
import { FilesTitle } from '../src/client/FilesTitle.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { FilesInjected } from '../src/client/face.ts'
import type { createFilesStore } from '../src/client/store.ts'

interface Recorded {
  name: string
  key: string
  locale: string
  store: unknown
  inject: unknown
  component: unknown
}

async function boot(references?: WorkspaceFileReferenceActions) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    // Copy is the dictionary's contract; the key stands in for the translation.
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  const workspaceFiles = { list: vi.fn() }
  const sidebar = { commandTarget: vi.fn(), openTabFromTarget: vi.fn(),
    mounted: createSnapshotStore<SessionId | undefined>(undefined), isExpanded: vi.fn(() => false), toggleExpanded: vi.fn(),
  }
  if (references !== undefined) ctx.provide('workspaceFileReferences', references)
  const commands: ShortcutCommand[] = []
  ctx.provide('shortcuts', { register: (command: ShortcutCommand) => {
    commands.push(command)
    return () => { commands.splice(commands.indexOf(command), 1) }
  } } as never)
  ctx.provide('sidebarRight', sidebar as never)
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('remote', { workspaceFiles } as never)
  ctx.provide('remote.workspaceFiles', workspaceFiles as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { tabs, registered, dictionaries, fiber, sidebar, commands }
}

describe('ui-sidebar-files apply', () => {
  it('opens files for the command target and refuses without a selected Session', async () => {
    const h = await boot()
    try {
      const command = h.commands[0]!
      expect(command.label()).toBe('guide.title')
      const input = { region: 'page', modal: null, target: null } as const
      expect(command.resolve(input)).toEqual({ status: 'blocked', reason: 'shortcut.noSession' })
      const target = { sessionId: 'files-session' }
      h.sidebar.commandTarget.mockReturnValue(target)
      const result = command.resolve(input)
      if (result.status !== 'handled') throw new Error('Expected files command to be available')
      result.run()
      expect(h.sidebar.openTabFromTarget).toHaveBeenCalledWith('files', target)
    } finally { await h.fiber.dispose() }
    expect(h.commands).toEqual([])
  })
  it('binds file gestures to the source Session and reveals only its expanded conversation', async () => {
    const session = SessionId('source-files')
    const ticket = 'file-ticket' as WorkspaceFileDragTicket
    const startDrag = vi.fn(() => ticket)
    const endDrag = vi.fn()
    const add = vi.fn(async () => true)
    const references: WorkspaceFileReferenceActions = {
      dragType: 'application/x-dsh-workspace-file', startDrag, endDrag, add, drop: vi.fn(async () => false),
    }
    const h = await boot(references)
    const body = h.registered[0]!
    const store = body.store as ReturnType<typeof createFilesStore>
    const instance = store.create()
    const makeFace = body.inject as (id: SessionId, actions: typeof instance.actions) => FilesInjected
    const face = makeFace(session, instance.actions).workspaceReferences!
    expect(face.type).toBe(references.dragType)
    expect(face.start('/work', ['/work/report.mp4'])).toBe(ticket)
    expect(startDrag).toHaveBeenCalledExactlyOnceWith(session, '/work', ['/work/report.mp4'])
    face.end(ticket)
    expect(endDrag).toHaveBeenCalledExactlyOnceWith(ticket)
    expect(await face.add('/work', ['/work/report.mp4'])).toBe(true)
    expect(add).toHaveBeenCalledExactlyOnceWith(session, '/work', ['/work/report.mp4'])
    h.sidebar.isExpanded.mockReturnValue(true)
    h.sidebar.mounted.set(SessionId('other-files'))
    face.revealConversation!()
    expect(h.sidebar.toggleExpanded).not.toHaveBeenCalled()
    h.sidebar.mounted.set(session)
    h.sidebar.isExpanded.mockReturnValue(false)
    face.revealConversation!()
    expect(h.sidebar.toggleExpanded).not.toHaveBeenCalled()
    h.sidebar.isExpanded.mockReturnValue(true)
    face.revealConversation!()
    expect(h.sidebar.toggleExpanded).toHaveBeenCalledOnce()
  })
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('registers the type, its dictionaries, and the body and title seats under the type\'s id', async () => {
    const { tabs, registered, dictionaries } = await boot()
    const definition = tabs.get(FILES_KIND)
    expect(definition?.id).toBe(FILES_ID)
    expect(definition?.priority).toBe('builtin')
    expect(definition?.title('sidebar://files')).toBe('type.label')
    expect(definition?.guide?.map(entry => [entry.order, entry.title(), entry.description?.()]))
      .toEqual([[10, 'guide.title', 'guide.description']])
    expect(dictionaries.get('sidebarFiles')).toEqual({ zh, en })
    // The seat key is the implementation's id, not the kind: an extension may
    // take the kind over, and the seat must still find this body.
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', FILES_ID, 'sidebarFiles', FilesBody],
      ['sidebar.right.pane.tab.title', FILES_ID, undefined, FilesTitle],
    ])
    expect(registered[0]?.store).toBeDefined()
    expect(typeof registered[0]?.inject).toBe('function')
    const body = registered[0]!
    const store = body.store as ReturnType<typeof createFilesStore>
    const instance = store.create()
    const makeFace = body.inject as (id: SessionId, actions: typeof instance.actions) => FilesInjected
    expect(makeFace(SessionId('files-without-conversation'), instance.actions).workspaceReferences).toBeUndefined()
  })

  it('takes every registration back when the plugin is disposed', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(FILES_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})
