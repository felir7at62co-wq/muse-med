// @vitest-environment jsdom
/** Workshop drafts retain validated revisions and editor choices across recovery. */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScriptDraft, ScriptDraftEpisode, ScriptDraftList, ScriptDraftStoryboard, ScriptSummary } from '@deepseek-ai/dsh-workbench-connection/types'
import { afterEach, expect, it, vi } from 'vitest'
import { DraftLibrary, DraftView, type DraftActions } from '../src/client/DrawerScriptDraft.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const draft: ScriptDraft = {
  id: 31, title: 'The night shuttle', status: 'created', episodeCount: 1, updatedAt: null, revision: 'draft-1',
  canFinalize: true, context: { outline: null, storyBible: null }, episodes: [{ episode: 2, title: '' }],
}
const chapter: ScriptDraftEpisode = {
  draftId: draft.id, episode: 2, title: '', revision: 'chapter-1', version: 1, content: 'Last shuttle at midnight.', candidate: null,
}
const failed = { status: 'failed', value: undefined, failure: undefined } as const
const loading = { ...failed, status: 'loading' } as const

afterEach(cleanup)

function live<T>(value: T) { return { status: 'live' as const, value, failure: undefined } }

type ViewProps = Parameters<typeof DraftView>[0]
type Resource = ReturnType<ViewProps['useResource']>

function fixture(read: (url: URL) => Resource | undefined = () => undefined) {
  const reads: URL[] = []
  const useResource = ((input: string) => {
    const url = new URL(input)
    reads.push(url)
    const response = read(url)
    if (response !== undefined) return response
    if (url.hostname === 'workshop-draft') return live(draft)
    if (url.hostname === 'workshop-draft-episode') return live(chapter)
    return { ...loading, status: 'none' }
  }) as ViewProps['useResource']
  const openScript = vi.fn<ViewProps['openScript']>()
  const draftActions = {
    createDraft: vi.fn<DraftActions['createDraft']>(), saveEpisode: vi.fn<DraftActions['saveEpisode']>(),
    finalizeDraft: vi.fn<DraftActions['finalizeDraft']>(), exportDraft: vi.fn(), saveStoryboard: vi.fn(),
    restoreHistory: vi.fn(), applyCandidate: vi.fn(), discardCandidate: vi.fn(),
  }
  const props: ViewProps = { draftId: draft.id, t, epoch: 7, openScript, quote: vi.fn(), useResource, draftActions }
  return { props, reads, openScript, ...draftActions }
}

it('retries the draft list and clears a search from any result page', () => {
  let ready = false
  const { props, reads, createDraft, openScript } = fixture((url) => {
    if (url.hostname !== 'workshop-drafts') return undefined
    if (url.searchParams.get('revision') === '0') return failed
    if (!ready) return loading
    if (url.searchParams.get('query') === 'unpublished title') return live<ScriptDraftList>({ items: [], nextOffset: null })
    if (url.searchParams.get('offset') === '30') {
      if (url.searchParams.get('revision') === '1') return failed
      return live<ScriptDraftList>({ items: [{ ...draft, id: 32, title: 'Shuttle at dawn' }], nextOffset: null })
    }
    return live<ScriptDraftList>({ items: [draft], nextOffset: 30 })
  })
  const view = render(<DraftLibrary {...props} />)
  const alert = within(view.getByRole('alert'))
  expect(alert.getByText(en.draftsFailed)).toBeTruthy()
  fireEvent.click(alert.getByRole('button', { name: en.retry }))
  expect(view.getByRole('status').textContent).toBe(en.loading)
  ready = true
  view.rerender(<DraftLibrary {...props} />)
  const search = view.getByRole('textbox', { name: en.searchScripts })
  fireEvent.change(search, { target: { value: '  shuttle  ' } })
  fireEvent.submit(view.getByRole('search'))
  const query = () => Object.fromEntries(reads.filter(url => url.hostname === 'workshop-drafts').at(-1)!.searchParams)
  expect(query()).toMatchObject({ query: 'shuttle', offset: '0', epoch: '7', revision: '1' })
  fireEvent.click(view.getByRole('button', { name: en.next }))
  expect(query()).toMatchObject({ query: 'shuttle', offset: '30' })
  expect(view.getByRole('button', { name: en.next })).toHaveProperty('disabled', true)
  fireEvent.click(within(view.getByRole('alert')).getByRole('button', { name: en.retry }))
  expect(query()).toMatchObject({ query: 'shuttle', offset: '30', revision: '2' })
  expect(view.getByRole('button', { name: en.next })).toHaveProperty('disabled', true)
  fireEvent.click(view.getByRole('button', { name: /Shuttle at dawn/u }))
  expect(openScript).toHaveBeenCalledExactlyOnceWith({ id: 'draft:32', title: 'Shuttle at dawn' })
  fireEvent.click(view.getByRole('button', { name: en.previous }))
  expect(query()).toMatchObject({ query: 'shuttle', offset: '0' })
  fireEvent.click(view.getByRole('button', { name: en.next }))
  fireEvent.change(search, { target: { value: '' } })
  expect(query()).toMatchObject({ query: '', offset: '0' })
  expect(view.getByRole('button', { name: /The night shuttle/u })).toBeTruthy()
  fireEvent.change(search, { target: { value: 'unpublished title' } })
  fireEvent.submit(view.getByRole('search'))
  expect(view.getByText(en.nothingHere)).toBeTruthy()
  expect(view.queryByRole('button', { name: /The night shuttle/u })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: en.newDraft }))
  const creator = within(view.getByRole('dialog', { name: en.newDraft }))
  fireEvent.click(creator.getByRole('button', { name: en.cancel }))
  expect(view.queryByRole('dialog')).toBeNull()
  expect(createDraft).not.toHaveBeenCalled()
})

it('retries the draft and episode independently and waits for both before finalizing', () => {
  let detailReady = false
  let episodeReady = false
  const revised = { ...draft, revision: 'draft-reviewed' }
  const { props, reads } = fixture((url) => {
    const revision = url.searchParams.get('revision')
    if (url.hostname === 'workshop-draft') {
      if (url.searchParams.has('confirmation')) return live(revised)
      if (url.searchParams.has('refresh')) return revision === '1' ? failed : live(revised)
      return revision === '0' ? failed : detailReady ? live(draft) : loading
    }
    if (url.hostname === 'workshop-draft-episode') return revision === '0' ? failed : episodeReady ? live(chapter) : loading
    return undefined
  })
  const view = render(<DraftView {...props} />)
  const retry = () => fireEvent.click(within(view.getByRole('alert')).getByRole('button', { name: en.retry }))
  retry()
  expect(view.getByRole('status').textContent).toBe(en.loading)
  detailReady = true
  view.rerender(<DraftView {...props} />)
  expect(view.getByRole('heading', { name: draft.title })).toBeTruthy()
  const finalize = view.getByRole('button', { name: en.finalizeDraft })
  expect(finalize).toHaveProperty('disabled', true)
  retry()
  expect(view.getByRole('alert').textContent).toContain(en.draftsFailed)
  expect(view.getByRole('status').textContent).toBe(en.loading)
  expect(finalize).toHaveProperty('disabled', true)
  retry()
  expect(view.queryByRole('alert')).toBeNull()
  expect(finalize).toHaveProperty('disabled', true)
  episodeReady = true
  view.rerender(<DraftView {...props} />)
  expect(view.getByRole('heading', { name: t('episodeNumber', { number: '2' }) })).toBeTruthy()
  expect(view.getByText(chapter.content)).toBeTruthy()
  expect(finalize).toHaveProperty('disabled', false)
  fireEvent.click(finalize)
  expect(within(view.getByRole('dialog', { name: en.finalizeDraft })).getByRole('combobox', { name: en.scriptRights })).toBeTruthy()
  expect(reads.filter(url => url.hostname === 'workshop-draft' && url.searchParams.has('refresh')).at(-1)?.searchParams.get('revision')).toBe('2')
})

it('leaves an empty draft readable while episode actions are unavailable', () => {
  const { props } = fixture(url => url.hostname === 'workshop-draft'
    ? live({ ...draft, episodes: [], episodeCount: 0, canFinalize: false }) : undefined)
  const view = render(<DraftView {...props} />)
  expect(view.getByRole('heading', { name: draft.title })).toBeTruthy()
  expect(view.getByText(en.emptyEpisodes)).toBeTruthy()
  expect(view.queryByRole('button', { name: en.finalizeDraft })).toBeNull()
  expect(view.queryByRole('button', { name: en.episodeHistory })).toBeNull()
})

it('reviews a long proposed edit and blocks manual writes until a conflicting revision is reread', async () => {
  const old = { ...chapter, content: Array.from({ length: 20 }, (_, index) => `Original line ${index + 1}.`).join('\n') }
  const candidate = {
    id: 'new-scene', baseRevision: old.revision, summary: '', createdAt: '2026-11-15T12:00:00Z',
    content: Array.from({ length: 20 }, (_, index) => `Proposed line ${index + 1}.`).join('\n'),
  }
  const updated: ScriptDraftEpisode = { ...chapter, revision: 'chapter-2', content: 'A later shuttle leaves at one.' }
  const storyboard: ScriptDraftStoryboard = {
    draftId: draft.id, episode: chapter.episode, title: 'The shuttle stop', revision: 'board-2', version: 2,
    shotsJson: '[{"scene":1,"action":"Lights appear beyond the shelter."}]', exists: true, stale: false,
  }
  const { props, saveEpisode } = fixture((url) => {
    if (url.hostname === 'workshop-draft-storyboard') return live(storyboard)
    return url.hostname === 'workshop-draft-episode'
      ? live(url.searchParams.get('revision') === '0' ? { ...old, candidate } : updated) : undefined
  })
  saveEpisode.mockRejectedValueOnce({ code: 'SCRIPT_EDITOR_VERSION_CHANGED' })
  const view = render(<DraftView {...props} />)
  const fold = view.getByRole('button', { name: /^Show \d+ more lines$/u })
  expect(view.queryByText('Proposed line 10.')).toBeNull()
  fireEvent.click(fold)
  expect(view.getByText('Proposed line 10.')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.diffCollapse }))
  expect(view.queryByText('Proposed line 10.')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: en.currentDraft }))
  expect(view.queryByRole('button', { name: en.applyDraftCandidate })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: en.candidateChanges }))
  expect(view.getByRole('button', { name: en.applyDraftCandidate })).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.currentDraft }))
  fireEvent.click(view.getByRole('button', { name: en.editEpisode }))
  const editor = view.getByRole('textbox', { name: en.editEpisode })
  const form = editor.closest('form')
  if (form === null) throw new Error('Expected the chapter edit form')
  act(() => { form.requestSubmit() })
  fireEvent.change(editor, { target: { value: '  ' } })
  act(() => { form.requestSubmit() })
  expect(saveEpisode).not.toHaveBeenCalled()
  const content = 'A passenger waits until one.'
  fireEvent.change(editor, { target: { value: content } })
  fireEvent.click(view.getByRole('button', { name: en.save }))
  expect((await view.findByRole('alert')).textContent).toBe(en.draftConflict)
  expect(editor).toHaveProperty('value', content)
  expect(view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  act(() => { form.requestSubmit() })
  expect(saveEpisode).toHaveBeenCalledExactlyOnceWith({ draftId: draft.id, episode: chapter.episode, baseRevision: old.revision, content })
  fireEvent.click(view.getByRole('button', { name: en.cancel }))
  fireEvent.click(view.getByRole('button', { name: en.refresh }))
  expect(view.getByText(updated.content)).toBeTruthy()
  expect(view.queryByRole('alert')).toBeNull()
  const layer = view.getByRole('combobox', { name: en.draftLayer })
  fireEvent.change(layer, { target: { value: 'storyboard' } })
  expect(view.getByText('Lights appear beyond the shelter.')).toBeTruthy()
  fireEvent.change(layer, { target: { value: 'chapter' } })
  expect(view.getByText(updated.content)).toBeTruthy()
})

it('keeps the finalization form closed to actions when a fresh eligibility check fails', () => {
  let confirmation: Resource = loading
  const { props, finalizeDraft } = fixture(url => url.searchParams.has('confirmation') ? confirmation : undefined)
  const view = render(<DraftView {...props} />)
  fireEvent.click(view.getByRole('button', { name: en.finalizeDraft }))
  const dialog = within(view.getByRole('dialog', { name: en.finalizeDraft }))
  expect(dialog.getByRole('status').textContent).toBe(en.loading)
  expect(dialog.getByRole('button', { name: en.finalizeDraft })).toHaveProperty('disabled', true)
  confirmation = failed
  view.rerender(<DraftView {...props} />)
  expect(dialog.getByRole('alert').textContent).toBe(en.draftsFailed)
  expect(dialog.queryByRole('combobox', { name: en.scriptRights })).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: en.close }))
  expect(view.queryByRole('dialog')).toBeNull()
  confirmation = live({ ...draft, canFinalize: false })
  fireEvent.click(view.getByRole('button', { name: en.finalizeDraft }))
  const ineligible = within(view.getByRole('dialog', { name: en.finalizeDraft }))
  expect(ineligible.getByText(en.draftCannotFinalize)).toBeTruthy()
  expect(ineligible.getByRole('button', { name: en.finalizeDraft })).toHaveProperty('disabled', true)
  expect(finalizeDraft).not.toHaveBeenCalled()
})

it('retries publishing a licensed narration without losing its choices or closing the pending dialog', async () => {
  const { props, finalizeDraft, openScript } = fixture()
  const published: ScriptSummary = {
    id: 71, title: draft.title, owner: { id: 12, name: 'Editor' }, rights: 'licensed',
    originWorkId: 'fanqie:700', originTitle: 'The Terminal', kind: 'narration', style: '3d',
    episodes: 1, words: 900, status: 'waiting', latestVersion: 1, picked: null, project: null, createdAt: null, updatedAt: null,
  }
  const pending = Promise.withResolvers<ScriptSummary>()
  finalizeDraft.mockRejectedValueOnce(new Error('Workshop unavailable')).mockReturnValueOnce(pending.promise)
  const view = render(<DraftView {...props} />)
  fireEvent.click(view.getByRole('button', { name: en.finalizeDraft }))
  const dialog = within(view.getByRole('dialog', { name: en.finalizeDraft }))
  fireEvent.change(dialog.getByRole('combobox', { name: en.scriptRights }), { target: { value: 'licensed' } })
  const origin = dialog.getByRole('textbox', { name: en.sourceWorkId })
  fireEvent.change(origin, { target: { value: '  ' } })
  const form = origin.closest('form')
  if (form === null) throw new Error('Expected the draft finalization form')
  act(() => { form.requestSubmit() })
  expect(finalizeDraft).not.toHaveBeenCalled()
  const submit = dialog.getByRole('button', { name: en.finalizeDraft })
  expect(submit).toHaveProperty('disabled', true)
  fireEvent.change(origin, { target: { value: '  fanqie:700  ' } })
  const kind = dialog.getByRole('combobox', { name: en.scriptForm })
  const style = dialog.getByRole('combobox', { name: en.look })
  fireEvent.change(kind, { target: { value: 'narration' } })
  fireEvent.change(style, { target: { value: '3d' } })
  fireEvent.change(kind, { target: { value: 'drama' } })
  fireEvent.change(style, { target: { value: 'realistic' } })
  fireEvent.click(submit)
  expect((await dialog.findByRole('alert')).textContent).toBe(en.finalizeDraftFailed)
  expect(origin).toHaveProperty('value', '  fanqie:700  ')
  expect(kind).toHaveProperty('value', 'drama')
  expect(style).toHaveProperty('value', 'realistic')
  fireEvent.change(kind, { target: { value: 'narration' } })
  fireEvent.change(style, { target: { value: '3d' } })
  fireEvent.change(dialog.getByRole('textbox', { name: en.scriptOrigin }), { target: { value: '  The Terminal  ' } })
  try {
    fireEvent.click(submit)
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.click(dialog.getByRole('button', { name: en.close }))
    expect(view.getByRole('dialog', { name: en.finalizeDraft })).toBeTruthy()
    expect(openScript).not.toHaveBeenCalled()
  } finally {
    await act(async () => { pending.resolve(published) })
  }
  const request = { draftId: draft.id, baseRevision: draft.revision, rights: 'licensed', originWorkId: 'fanqie:700' }
  expect(finalizeDraft.mock.calls).toEqual([
    [{ ...request, kind: 'drama', style: 'realistic' }],
    [{ ...request, kind: 'narration', style: '3d', originTitle: published.originTitle }],
  ])
  expect(view.queryByRole('dialog')).toBeNull()
  expect(openScript).toHaveBeenCalledExactlyOnceWith({ id: String(published.id), title: published.title })
})
