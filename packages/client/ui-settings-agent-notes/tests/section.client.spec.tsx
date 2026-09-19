// @vitest-environment jsdom
/**
 * The Agent Notes page's presentation behavior: catalog grouping and states,
 * opening a note, the edit/save/cancel path, dirty indication, and the two
 * failure paths a save can take.
 *
 * Props are fed directly (the documented component tier): `t` is built from the
 * package's own `en` dictionary so every assertion reads the copy a user sees,
 * and the injected face is a stub standing in for the Host.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentNotesCatalog } from '@deepseek-ai/dsh-api-agent-notes/types'
import { AgentNotesSection } from '../src/client/AgentNotesSection.tsx'
import type {
  AgentNoteOutcome,
  AgentNotesCatalogOutcome,
  AgentNotesSectionProps,
  AgentNoteSaveOutcome,
} from '../src/client/AgentNotesSection.tsx'
import { en, type AgentNotesLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: AgentNotesLocaleKey, params?: Record<string, string | number>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    en[key],
  )) as AgentNotesSectionProps['t']

/** A catalog with two categories and one uncategorized note. */
function catalog(): AgentNotesCatalog {
  return {
    state: 'ready',
    root: '/repo/.agents/notes',
    truncated: false,
    notes: [
      { id: 'bug-fix/a.md', category: 'bug-fix', title: 'A defect', status: 'implemented' },
      { id: 'bug-fix/b.md', category: 'bug-fix', title: 'Another defect' },
      { id: 'implemented/c.md', category: 'implemented', title: 'A decision', modifiedMs: 1 },
    ],
  }
}

const SOURCE = '# Agent Note: A defect\n\nStatus: implemented\n\nBody.\n'

/** Props for one render, with a stubbed Host face. */
function props(overrides: {
  list?: () => Promise<AgentNotesCatalogOutcome>
  read?: (id: string) => Promise<AgentNoteOutcome>
  save?: (id: string, text: string, expectedVersion: string) => Promise<AgentNoteSaveOutcome>
} = {}): AgentNotesSectionProps {
  const id = 'bug-fix/a.md'
  return {
    t,
    close: vi.fn(),
    list: overrides.list ?? (async () => ({ ok: true, catalog: catalog() })),
    read: overrides.read ?? (async () => ({
      ok: true,
      note: { id, title: 'A defect', status: 'implemented', text: SOURCE, version: 'v1', bytes: SOURCE.length },
    })),
    save: overrides.save ?? (async () => ({ ok: true, version: 'v2', bytes: SOURCE.length })),
  } as unknown as AgentNotesSectionProps
}

/** Open the first note and wait for its body. */
async function openFirstNote(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Open A defect' }))
  await screen.findByRole('button', { name: 'Edit' })
}

describe('AgentNotesSection — the catalog', () => {
  it('groups notes by category, shows each status, and reports the root and count', async () => {
    render(<AgentNotesSection {...props()} />)

    await screen.findByText('A defect')
    expect(screen.getByText('/repo/.agents/notes', { exact: false })).toBeDefined()
    expect(screen.getByText('3 notes', { exact: false })).toBeDefined()
    const groups = [...document.querySelectorAll('[data-note-category]')]
      .map(node => node.getAttribute('data-note-category'))
    expect(groups).toEqual(['bug-fix', 'implemented'])
    expect(screen.getAllByText('implemented')).toHaveLength(2)
  })

  it('shows an empty state for a root with no notes, not an error', async () => {
    render(<AgentNotesSection {...props({
      list: async () => ({ ok: true, catalog: { state: 'ready', root: '/notes', notes: [], truncated: false } }),
    })} />)

    await screen.findByText(en.empty)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('explains a notes root that does not exist yet', async () => {
    render(<AgentNotesSection {...props({
      list: async () => ({ ok: true, catalog: { state: 'absent', root: '/notes', notes: [], truncated: false } }),
    })} />)

    await screen.findByText(en.missingRoot.replace('{root}', '/notes'))
  })

  it('filters the catalog and says so when nothing matches', async () => {
    render(<AgentNotesSection {...props()} />)
    await screen.findByText('A defect')

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'decision' } })
    expect(screen.queryByText('A defect')).toBeNull()
    expect(screen.getByText('A decision')).toBeDefined()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing' } })
    expect(screen.getByText(en.emptySearch)).toBeDefined()
  })

  it('reports a catalog failure with a retry that reads again', async () => {
    const list = vi.fn<(typeof props) extends never ? never : () => Promise<AgentNotesCatalogOutcome>>(async () => ({
      ok: false, code: 'gateway/internal', message: 'host exploded',
    }))
    render(<AgentNotesSection {...props({ list })} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('host exploded')
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
  })
})

describe('AgentNotesSection — opening a note', () => {
  it('renders the note as Markdown under its status and returns to the list', async () => {
    render(<AgentNotesSection {...props()} />)
    await screen.findByText('A defect')

    fireEvent.click(screen.getByRole('button', { name: 'Open A defect' }))
    await screen.findByRole('button', { name: 'Edit' })
    expect(screen.getByText('bug-fix/a.md')).toBeDefined()
    // The Markdown renderer turns the note's own heading into a heading element.
    expect(screen.getByRole('heading', { name: 'Agent Note: A defect' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: en.back }))
    expect(screen.getByText('A decision')).toBeDefined()
  })

  it('reports a failed read without opening the note', async () => {
    render(<AgentNotesSection {...props({
      read: async () => ({ ok: false, code: 'agent-note/not-found', message: 'no note at "bug-fix/a.md"' }),
    })} />)
    await screen.findByText('A defect')

    fireEvent.click(screen.getByRole('button', { name: 'Open A defect' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('no note at "bug-fix/a.md"')
  })
})

describe('AgentNotesSection — editing', () => {
  it('saves an edit, then shows the saved text without a dirty marker', async () => {
    const save = vi.fn(async () => ({ ok: true as const, version: 'v2', bytes: 9 }))
    render(<AgentNotesSection {...props({ save })} />)
    await screen.findByText('A defect')
    await openFirstNote()

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    const editor = screen.getByRole('textbox', { name: en.editorLabel })
    fireEvent.change(editor, { target: { value: `${SOURCE}\nMore.\n` } })
    // The dirty marker appears only once the draft differs from the saved text.
    expect(screen.getByText(en.dirty)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith('bug-fix/a.md', `${SOURCE}\nMore.\n`, 'v1')
    })
    await screen.findByRole('button', { name: en.edit })
    expect(screen.queryByText(en.dirty)).toBeNull()
  })

  it('keeps the save control disabled until the draft actually differs', async () => {
    render(<AgentNotesSection {...props()} />)
    await screen.findByText('A defect')
    await openFirstNote()

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    const save = screen.getByRole('button', { name: en.save }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: en.editorLabel }), { target: { value: 'changed' } })
    await waitFor(() => { expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(false) })
  })

  it('cancels back to the saved text', async () => {
    render(<AgentNotesSection {...props()} />)
    await screen.findByText('A defect')
    await openFirstNote()

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    fireEvent.change(screen.getByRole('textbox', { name: en.editorLabel }), { target: { value: 'discarded' } })
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await screen.findByRole('button', { name: en.edit })
    expect(screen.getByRole('heading', { name: 'Agent Note: A defect' })).toBeDefined()
  })

  it('reports an ordinary save failure and keeps the editor open', async () => {
    render(<AgentNotesSection {...props({
      save: async () => ({ ok: false, code: 'agent-note/outside-root', message: 'resolves outside the notes root' }),
    })} />)
    await screen.findByText('A defect')
    await openFirstNote()

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    fireEvent.change(screen.getByRole('textbox', { name: en.editorLabel }), { target: { value: 'changed' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('resolves outside the notes root')
    expect(screen.getByRole('textbox', { name: en.editorLabel })).toBeDefined()
  })

  it('treats a version conflict as a reload, keeping the draft and saying what happened', async () => {
    const read = vi.fn(async () => ({
      ok: true as const,
      note: { id: 'bug-fix/a.md', title: 'A defect', text: '# Somebody else\n', version: 'v9', bytes: 16 },
    }))
    render(<AgentNotesSection {...props({
      read,
      save: async () => ({ ok: false, code: 'agent-note/stale', message: 'changed since it was read' }),
    })} />)
    await screen.findByText('A defect')
    await openFirstNote()

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    fireEvent.change(screen.getByRole('textbox', { name: en.editorLabel }), { target: { value: 'mine' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await screen.findByText(en.saveStale)
    // The reloaded version is now the editor's baseline, and nothing typed was lost.
    await waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
    expect((screen.getByRole('textbox', { name: en.editorLabel }) as HTMLTextAreaElement).value).toBe('mine')
  })
})
