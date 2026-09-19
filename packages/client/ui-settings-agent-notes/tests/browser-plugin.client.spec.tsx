// @vitest-environment jsdom
/**
 * The section's registration into the real Settings registry, and the injected
 * face it hands its component.
 *
 * The registry is the production `SlotRegistry`, the declaring parent is
 * registered the same way the Settings shell registers it, and the locale is a
 * real `LocaleRuntime` — so what this asserts is the behavior a booting client
 * gets, not a hand-built context. The Host Remote is the one substitute: the
 * injected face is called directly, which is exactly the surface the component
 * receives, so a fake `remote.agentNotes` would only prove the mock.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { apply, inject, NS } from '../src/client/index.ts'
import { AgentNotesSection } from '../src/client/AgentNotesSection.tsx'
import type { AgentNotesSectionInjected } from '../src/client/AgentNotesSection.tsx'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

/** One successful Remote result, shaped exactly as the generated Client returns it. */
function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One failed Remote result carrying the failure class the Host gateway sends. */
function fail(error: RemoteFailure): RemoteResult<never> {
  return { ok: false, error }
}

/**
 * One live client root with the real slot registry and locale runtime.
 *
 * The injected namespace is provided as its own service because the plugin
 * declares `remote.agentNotes`: a client whose gateway has not mounted the
 * namespace must stay pending rather than half-activate, which is the behavior
 * the production client has.
 * @param agentNotes - the namespace face this plugin's injected methods call.
 * @returns the booted bench.
 */
async function bench(agentNotes: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.provide('remote.agentNotes', agentNotes)
  // `ctx.remote` is a store whose namespace properties are its child services,
  // so this delegate reaches the same face the plugin declares.
  ctx.provide('remote', {
    get agentNotes() { return ctx.get('remote.agentNotes') },
  })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

/** Stand in for the Settings shell's declaration of the section slot. */
function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-agent-notes browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the locale, the slot registry, and the notes Remote namespace', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.agentNotes'])
  })

  it('registers the notes page with localized nav copy that follows the locale', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(AgentNotesSection)
    expect(entry.options).toMatchObject({ id: 'agent-notes', order: 30 })
    expect(entry.locale).toBe(NS)
    expect(NS).toBe('settings.agentNotes')
    expect(resolveSlotLabel(entry.options.label)).toBe('Agent 笔记')

    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Agent notes')
    await b.ctx.fiber.dispose()
  })

  it('reports a Host failure as a value instead of throwing through the component', async () => {
    const list = vi.fn(async () => ok({ state: 'ready' as const, root: '/notes', notes: [], truncated: false }))
    const read = vi.fn(async () => fail(new RemoteError('agent-note/not-found', 'no note at "bug-fix/gone.md"', { id: 'bug-fix/gone.md' })))
    const save = vi.fn(async () => fail(new RemoteError('agent-note/stale', 'changed since it was read', { id: 'bug-fix/gone.md' })))
    const b = await bench({ list, read, save })
    // The delegate reaches the very face the plugin declares.
    expect(b.ctx.get('remote.agentNotes')).toBeDefined()
    expect((b.ctx.get('remote.agentNotes') as Record<string, unknown>).read).toBe(read)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.section')[0]!
    const injected = (entry.inject as unknown as () => AgentNotesSectionInjected)()
    await expect(injected.list()).resolves.toEqual({ ok: true, catalog: { state: 'ready', root: '/notes', notes: [], truncated: false } })
    await expect(injected.read('bug-fix/gone.md')).resolves.toEqual({
      ok: false,
      code: 'agent-note/not-found',
      message: 'no note at "bug-fix/gone.md"',
    })
    await expect(injected.save('bug-fix/gone.md', 'text', 'v0'))
      .resolves.toEqual({ ok: false, code: 'agent-note/stale', message: 'changed since it was read' })
    expect(read).toHaveBeenCalledWith('bug-fix/gone.md')
    expect(save).toHaveBeenCalledWith('bug-fix/gone.md', 'text', 'v0')
    await b.ctx.fiber.dispose()
  })

  it('unwraps a successful read into the draft the component edits', async () => {
    const text = '# Agent Note: A defect\n'
    const b = await bench({
      read: async () => ok({ id: 'bug-fix/a.md', title: 'A defect', text, version: 'v1', bytes: text.length }),
      save: async () => ok({ id: 'bug-fix/a.md', version: 'v2', bytes: 5 }),
    })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const injected = ((b.slots.entries('settings.section')[0]!.inject) as unknown as () => AgentNotesSectionInjected)()
    // A note that declares no status carries no status field, not an empty one.
    await expect(injected.read('bug-fix/a.md')).resolves.toEqual({
      ok: true,
      note: { id: 'bug-fix/a.md', title: 'A defect', text, version: 'v1', bytes: text.length },
    })
    await expect(injected.save('bug-fix/a.md', 'text', 'v1')).resolves.toEqual({ ok: true, version: 'v2', bytes: 5 })
    await b.ctx.fiber.dispose()
  })

  it('follows a late declaration and releases everything on unload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.section')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })

    stop()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('settings.section')[0]?.component).toBe(AgentNotesSection)
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    // The dictionary disposer ran with the fiber: the (ns, locale) seats are free again.
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
