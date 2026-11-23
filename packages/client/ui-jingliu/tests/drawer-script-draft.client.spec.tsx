// @vitest-environment jsdom
/** Draft review stays scoped to the selected episode and applies only after a human action. */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScriptDraft, ScriptDraftEpisode } from '@deepseek-ai/dsh-workbench-connection/types'
import { afterEach, expect, it, vi } from 'vitest'
import { DrawerScripts, type DrawerScriptsProps } from '../src/client/DrawerScripts.tsx'
import { en } from '../src/client/locales.ts'

const draft: ScriptDraft = {
  id: 45, title: 'The ledger', status: 'created', episodeCount: 2, updatedAt: null, revision: 'draft-revision',
  canFinalize: true, context: { outline: null, storyBible: null },
  episodes: [{ episode: 3, title: 'The visitor' }, { episode: 4, title: 'The account book' }],
}
const pending: NonNullable<ScriptDraftEpisode['candidate']> = {
  id: 'candidate-4', baseRevision: 'episode-4', content: 'Jin opens the ledger.',
  createdAt: '2026-11-22T20:00:00Z', summary: 'Keep the reveal and clarify the action.',
}
const current = 'Jin picks up the ledger.'

afterEach(cleanup)

function setup({ stale = false, canFinalize = true, changedBeforeConfirmation = false } = {}) {
  const reads: URL[] = []
  let latestRevision = draft.revision
  const episodeRow = (episode: number): ScriptDraftEpisode => ({
    draftId: draft.id, episode, title: draft.episodes.find(item => item.episode === episode)?.title ?? '',
    revision: stale ? 'new-revision' : 'episode-' + String(episode), version: 2,
    content: episode === 4 ? current : 'A visitor arrives.', candidate: episode === 4 ? pending : null,
  })
  const useResource = ((address: string) => {
    const url = new URL(address)
    reads.push(url)
    let value
    switch (url.hostname) {
      case 'workshop-drafts': value = { items: [draft], nextOffset: null }; break
      case 'workshop-scripts': value = { items: [], total: 0, counts: { all: 0, waiting: 0, picked: 0, inProduction: 0 } }; break
      case 'workshop-draft': value = { ...draft, canFinalize,
        revision: url.searchParams.has('confirmation') && changedBeforeConfirmation ? 'unreviewed-revision' : latestRevision }; break
      case 'workshop-draft-episode': value = episodeRow(Number(url.searchParams.get('episode'))); break
    }
    return { status: value === undefined ? 'failed' : 'live', value, failure: undefined }
  }) as DrawerScriptsProps['useResource']
  const openScript = vi.fn()
  const quote = vi.fn()
  const applyCandidate = vi.fn(async (): Promise<ScriptDraftEpisode> => ({
    ...episodeRow(4), revision: 'episode-4-applied', version: 3, content: pending.content, candidate: null,
  }))
  const saveEpisode = vi.fn(async (): Promise<ScriptDraftEpisode> => {
    latestRevision = 'draft-revised'
    return { ...episodeRow(3), revision: 'episode-3-saved', version: 3, content: 'A visitor knocks.' }
  })
  const discardCandidate = vi.fn(async (): Promise<ScriptDraftEpisode> => ({ ...episodeRow(4), candidate: null }))
  const finalizeDraft = vi.fn<DrawerScriptsProps['draftActions']['finalizeDraft']>()
  const props: DrawerScriptsProps = {
    t: makeTranslate(en), useResource, useAccountEpoch: select => select(1),
    script: null, openScript, quote, compose: vi.fn(), pick: vi.fn(), link: vi.fn(),
    draftActions: { applyCandidate, saveEpisode, discardCandidate, finalizeDraft },
  }
  return { props, reads, openScript, quote, applyCandidate, saveEpisode, discardCandidate, finalizeDraft }
}

it('opens a draft tab from search and keeps the finalized library available', () => {
  const { props, reads, openScript } = setup()
  const view = render(<DrawerScripts {...props} />)
  fireEvent.change(view.getByRole('textbox', { name: en.searchScripts }), { target: { value: 'The ledger' } })
  fireEvent.submit(view.getByRole('search'))
  expect(reads.some(url => url.hostname === 'workshop-drafts' && url.searchParams.get('query') === 'The ledger')).toBe(true)
  fireEvent.click(view.getByRole('button', { name: /The ledger/u }))
  expect(openScript).toHaveBeenCalledWith({ id: 'draft:45', title: 'The ledger' })
  fireEvent.click(view.getByRole('tab', { name: en.scriptLibrary }))
  expect(reads.at(-1)?.hostname).toBe('workshop-scripts')
})

it('quotes the selected episode and shows a visible difference before applying one candidate', async () => {
  const { props, reads, quote, applyCandidate, saveEpisode } = setup()
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  expect(view.getByText('A visitor arrives.')).toBeTruthy()
  fireEvent.change(view.getByRole('combobox', { name: en.scriptEpisodes }), { target: { value: '4' } })
  expect(view.getByText(pending.summary)).toBeTruthy()
  expect(view.getByText(pending.content)).toBeTruthy()
  expect(view.getByText(current)).toBeTruthy()
  expect(applyCandidate).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: en.quoteAsset }))
  expect(quote).toHaveBeenCalledWith('Draft “The ledger” (draft ID 45), episode 4')
  fireEvent.click(view.getByRole('button', { name: en.applyDraftCandidate }))
  await waitFor(() => { expect(view.getByRole('status').textContent).toContain(en.draftSaved) })
  expect(applyCandidate).toHaveBeenCalledWith({ draftId: 45, episode: 4, candidateId: 'candidate-4' })
  expect(saveEpisode).not.toHaveBeenCalled()
  expect(view.queryByText(current)).toBeNull()
  fireEvent.click(view.getByRole('button', { name: en.refresh }))
  expect(reads.at(-1)?.searchParams.get('revision')).toBe('1')
  expect(reads.at(-1)?.searchParams.get('episode')).toBe('4')
})

it('blocks stale proposals and lets the editor discard one without changing the manuscript', async () => {
  const { props, applyCandidate, discardCandidate } = setup({ stale: true, canFinalize: false })
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  expect(view.queryByRole('button', { name: en.finalizeDraft })).toBeNull()
  fireEvent.change(view.getByRole('combobox', { name: en.scriptEpisodes }), { target: { value: '4' } })
  expect(view.getByRole('status').textContent).toBe(en.draftConflict)
  fireEvent.click(view.getByRole('button', { name: en.applyDraftCandidate }))
  expect(applyCandidate).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: en.discardDraftCandidate }))
  await waitFor(() => { expect(view.getByText(current)).toBeTruthy() })
  expect(discardCandidate).toHaveBeenCalledWith({ draftId: 45, episode: 4, candidateId: 'candidate-4' })
})

it('saves a manual edit against the displayed revision and asks before finalization', async () => {
  const { props, reads, saveEpisode, finalizeDraft } = setup()
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  fireEvent.click(view.getByRole('button', { name: en.editEpisode }))
  expect(view.getByRole('combobox', { name: en.scriptEpisodes })).toHaveProperty('disabled', true)
  fireEvent.change(view.getByRole('textbox', { name: en.editEpisode }), { target: { value: 'A visitor knocks.' } })
  fireEvent.click(view.getByRole('button', { name: en.save }))
  await waitFor(() => { expect(view.getByText('A visitor knocks.')).toBeTruthy() })
  expect(saveEpisode).toHaveBeenCalledWith({ draftId: 45, episode: 3, baseRevision: 'episode-3', content: 'A visitor knocks.' })
  expect(view.getByRole('button', { name: en.finalizeDraft })).toHaveProperty('disabled', true)
  fireEvent.click(view.getByRole('button', { name: en.refresh }))
  expect(view.getByRole('combobox', { name: en.scriptEpisodes })).toHaveProperty('value', '3')
  fireEvent.click(view.getByRole('button', { name: en.finalizeDraft }))
  const dialog = within(view.getByRole('dialog', { name: en.finalizeDraft }))
  expect(dialog.getByText('Publish all 2 episodes of “The ledger” to the finalized library.')).toBeTruthy()
  expect(reads.at(-1)?.searchParams.get('confirmation')).toBe('1')
  expect(finalizeDraft).not.toHaveBeenCalled()
  expect(dialog.getByRole('button', { name: en.finalizeDraft })).toHaveProperty('disabled', true)
  fireEvent.change(dialog.getByRole('combobox', { name: en.scriptRights }), { target: { value: 'original' } })
  finalizeDraft.mockRejectedValueOnce({ code: 'SCRIPT_EDITOR_VERSION_CHANGED' })
  fireEvent.click(dialog.getByRole('button', { name: en.finalizeDraft }))
  await waitFor(() => { expect(dialog.getByRole('alert').textContent).toBe(en.draftConflict) })
  expect(finalizeDraft).toHaveBeenCalledWith({ draftId: 45, baseRevision: 'draft-revised',
    rights: 'original', kind: 'drama', style: 'realistic' })
})

it('refuses a newer draft discovered inside the confirmation dialog', () => {
  const { props, finalizeDraft } = setup({ changedBeforeConfirmation: true })
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  fireEvent.click(view.getByRole('button', { name: en.finalizeDraft }))
  const dialog = within(view.getByRole('dialog', { name: en.finalizeDraft }))
  expect(dialog.getByRole('alert').textContent).toBe(en.draftConflict)
  fireEvent.click(dialog.getByRole('button', { name: en.finalizeDraft }))
  expect(finalizeDraft).not.toHaveBeenCalled()
})
