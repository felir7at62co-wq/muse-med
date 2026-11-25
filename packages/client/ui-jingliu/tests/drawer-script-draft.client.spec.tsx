// @vitest-environment jsdom
/** Draft review stays scoped to the selected episode and applies only after a human action. */
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScriptDraft, ScriptDraftEpisode, ScriptDraftStoryboard } from '@deepseek-ai/dsh-workbench-connection/types'
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
const shot = {
  scene_no: '3-1', time_loc: 'Night · interior', location: 'Bookroom', characters: ['Jin'],
  elements: [{ type: 'action', content: 'Jin locks the door.', framing: 'Keep' },
    { type: 'dialogue', character: 'Jin', content: 'Bring the book.', mode: 'whisper' }],
  subtitle: 'Six years earlier', plugin: { keep: true },
}

afterEach(cleanup)

function setup({ stale = false, canFinalize = true, changedBeforeConfirmation = false, legacyEmptyBoard = false, storedShots, history = 'live' }: {
  stale?: boolean
  canFinalize?: boolean
  changedBeforeConfirmation?: boolean
  legacyEmptyBoard?: boolean
  storedShots?: string
  history?: 'live' | 'loading' | 'empty' | 'retry' | 'stale-preview' | 'preview-retry' | 'multiple'
} = {}) {
  const reads: URL[] = []
  let latestRevision = draft.revision
  const episodeRow = (episode: number): ScriptDraftEpisode => ({
    draftId: draft.id, episode, title: draft.episodes.find(item => item.episode === episode)?.title ?? '',
    revision: stale ? 'new-revision' : 'episode-' + String(episode), version: 2,
    content: episode === 4 ? current : 'A visitor arrives.', candidate: episode === 4 ? pending : null,
  })
  const storyRow = (episode: number): ScriptDraftStoryboard => ({
    draftId: draft.id, episode, title: '', shotsJson: episode === 3 && storedShots !== undefined ? storedShots : JSON.stringify(episode === 3 && !legacyEmptyBoard ? [shot] : []),
    revision: 'board-' + String(episode), version: legacyEmptyBoard ? 1 : 2, exists: episode === 3 && !legacyEmptyBoard, stale: false,
  })
  const old = { id: 21, version: 1, createdAt: '2026-11-23T06:00:00Z', createdBy: '11' }
  const blank = { id: 22, version: 2, createdAt: null, createdBy: '11', content: '' }
  const hasBlankHistory = history === 'stale-preview' || history === 'preview-retry' || history === 'multiple'
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
      case 'workshop-draft-storyboard': value = storyRow(Number(url.searchParams.get('episode'))); break
      case 'workshop-draft-history':
        if (history === 'loading') return { status: 'loading', value: undefined, failure: undefined }
        if (history === 'retry' && url.searchParams.get('retry') === '0') return { status: 'failed', value: undefined, failure: undefined }
        value = { items: history === 'empty' ? [] : hasBlankHistory ? [old, blank] : [old] }
        break
      case 'workshop-draft-history-entry':
        if (history !== 'stale-preview' && url.searchParams.get('row') === '22') {
          if (history === 'preview-retry' && url.searchParams.get('retry') === '0') return { status: 'failed', value: undefined, failure: undefined }
          value = blank
        } else {
          value = { ...old, content: url.searchParams.get('layer') === 'storyboard'
            ? JSON.stringify([{ ...shot, location: 'Market' }]) : 'Jin watches the door.' }
        }
        break
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
  const createDraft = vi.fn<DrawerScriptsProps['draftActions']['createDraft']>().mockResolvedValue(draft)
  const saveStoryboard = vi.fn<DrawerScriptsProps['draftActions']['saveStoryboard']>().mockImplementation(async request => ({
    ...storyRow(request.episode), version: 3, revision: 'board-saved', shotsJson: request.shotsJson, exists: true,
  }))
  const restoreHistory = vi.fn<DrawerScriptsProps['draftActions']['restoreHistory']>().mockImplementation(async request => request.layer === 'chapter'
    ? { episode: { ...episodeRow(request.episode), content: request.historyId === blank.id ? blank.content : 'Jin watches the door.', version: 3 }, storyboard: null }
    : { episode: null, storyboard: { ...storyRow(request.episode), shotsJson: JSON.stringify([{ ...shot, location: 'Market' }]), version: 3 } })
  const exportDraft = vi.fn<DrawerScriptsProps['draftActions']['exportDraft']>().mockResolvedValue({
    filename: 'source.md', mime: 'text/markdown', base64: 'U2NyaXB0',
  })
  const props: DrawerScriptsProps = {
    t: makeTranslate(en), useResource, useAccountEpoch: select => select(1),
    script: null, openScript, quote, compose: vi.fn(), pick: vi.fn(), link: vi.fn(),
    draftActions: {
      applyCandidate, saveEpisode, discardCandidate, finalizeDraft, createDraft, saveStoryboard, restoreHistory, exportDraft,
    },
  }
  return { props, reads, openScript, quote, applyCandidate, saveEpisode, discardCandidate, finalizeDraft, createDraft, saveStoryboard,
    restoreHistory, exportDraft }
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

it('creates a blank numbered draft from the draft collection and reuses the same request on retry', async () => {
  const { props, createDraft, openScript } = setup()
  createDraft.mockRejectedValueOnce(new Error('Connection lost'))
  const view = render(<DrawerScripts {...props} />)
  fireEvent.click(view.getByRole('button', { name: en.newDraft }))
  const dialog = within(view.getByRole('dialog', { name: en.newDraft }))
  fireEvent.change(dialog.getByRole('textbox', { name: en.draftName }), { target: { value: 'New screenplay' } })
  fireEvent.change(dialog.getByRole('spinbutton', { name: en.draftEpisodes }), { target: { value: '3' } })
  fireEvent.click(dialog.getByRole('button', { name: en.newDraft }))
  await waitFor(() => { expect(dialog.getByRole('alert').textContent).toBe(en.draftCreateFailed) })
  fireEvent.click(dialog.getByRole('button', { name: en.newDraft }))
  await waitFor(() => { expect(openScript).toHaveBeenCalledWith({ id: 'draft:45', title: draft.title }) })
  const request = createDraft.mock.calls[0]?.[0]
  expect(request?.requestId).toBeTypeOf('string')
  expect(createDraft.mock.calls).toEqual([
    [{ title: 'New screenplay', episodeCount: 3, requestId: request?.requestId }],
    [request],
  ])
})

it('keeps a pending import open and reuses its Workshop request until the user edits it', async () => {
  const { props, createDraft, openScript } = setup()
  const firstResponse = Promise.withResolvers<undefined>()
  createDraft.mockImplementationOnce(async () => {
    await firstResponse.promise
    throw new Error('Response lost')
  }).mockRejectedValueOnce(new Error('Still offline'))
  const view = render(<DrawerScripts {...props} />)
  fireEvent.click(view.getByRole('button', { name: en.importDraft }))
  const dialog = within(view.getByRole('dialog', { name: en.importDraft }))
  const file = new File(['Episode 1'], 'Side story.txt', { type: 'text/plain' })
  const selector = dialog.getByLabelText(new RegExp(en.draftSource, 'u'))
  const name = dialog.getByRole('textbox', { name: en.draftName })
  fireEvent.change(selector, { target: { files: [file] } })
  const submit = dialog.getByRole('button', { name: en.importDraft })
  await waitFor(() => { expect(submit).toHaveProperty('disabled', false) })
  try {
    fireEvent.click(submit)
    expect(submit).toHaveProperty('disabled', true)
    expect(selector).toHaveProperty('disabled', true)
    expect(name).toHaveProperty('disabled', true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.getByRole('dialog', { name: en.importDraft })).toBeTruthy()
    fireEvent.click(submit)
    expect(createDraft).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => { firstResponse.resolve(undefined) })
  }
  expect(dialog.getByRole('alert').textContent).toBe(en.draftCreateFailed)
  const request = createDraft.mock.calls[0]?.[0]
  expect(request?.requestId).toBeTypeOf('string')
  expect(request).toEqual({ title: 'Side story', requestId: request?.requestId,
    file: { filename: 'Side story.txt', base64: 'RXBpc29kZSAx' } })
  fireEvent.click(submit)
  expect((await dialog.findByRole('alert')).textContent).toBe(en.draftCreateFailed)
  expect(createDraft).toHaveBeenNthCalledWith(2, request)
  expect(openScript).not.toHaveBeenCalled()

  fireEvent.change(name, { target: { value: '  Reviewed side story  ' } })
  expect(dialog.queryByRole('alert')).toBeNull()
  fireEvent.click(submit)
  await waitFor(() => { expect(openScript).toHaveBeenCalledExactlyOnceWith({ id: 'draft:45', title: draft.title }) })
  const reviewed = createDraft.mock.calls[2]?.[0]
  expect(reviewed?.requestId).toBeTypeOf('string')
  expect(reviewed).toEqual({ ...request, title: 'Reviewed side story', requestId: reviewed?.requestId })
  expect(reviewed?.requestId).not.toBe(request?.requestId)
})

it('rejects unsupported, empty and oversized imports and clears validation when the choice is canceled', () => {
  const { props, createDraft } = setup()
  const view = render(<DrawerScripts {...props} />)
  fireEvent.click(view.getByRole('button', { name: en.importDraft }))
  const dialog = within(view.getByRole('dialog', { name: en.importDraft }))
  const input = dialog.getByLabelText(new RegExp(en.draftSource, 'u'))
  const submit = dialog.getByRole('button', { name: en.importDraft })
  const invalid = [new File(['hello'], 'visual.png'), new File([], 'empty.md'),
    new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'long.txt')]
  for (const file of invalid) {
    fireEvent.change(input, { target: { files: [file] } })
    expect(dialog.getByRole('alert').textContent).toBe(en.draftSourceFormats)
    expect(submit).toHaveProperty('disabled', true)
  }
  fireEvent.change(input, { target: { files: [] } })
  expect(dialog.queryByRole('alert')).toBeNull()
  expect(submit).toHaveProperty('disabled', true)
  expect(createDraft).not.toHaveBeenCalled()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('dialog')).toBeNull()
})

it('keeps the latest selected source when an earlier file read fails', async () => {
  const { props, createDraft } = setup()
  const readers = new Map<Blob, FileReader>()
  const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader, file) { readers.set(file, this) })
  try {
    const view = render(<DrawerScripts {...props} />)
    fireEvent.click(view.getByRole('button', { name: en.importDraft }))
    const dialog = within(view.getByRole('dialog', { name: en.importDraft }))
    const input = dialog.getByLabelText(new RegExp(en.draftSource, 'u'))
    const submit = dialog.getByRole('button', { name: en.importDraft })
    const first = new File(['Old'], 'old.md')
    const second = new File(['New'], 'new.md')
    fireEvent.change(dialog.getByRole('textbox', { name: en.draftName }), { target: { value: 'Approved title' } })
    for (const file of [first, second]) fireEvent.change(input, { target: { files: [file] } })
    const stale = readers.get(first)!
    const currentReader = readers.get(second)!
    await act(async () => { stale.dispatchEvent(new ProgressEvent('error')) })
    expect(dialog.getByRole('status').textContent).toBe(en.loading)
    expect(dialog.queryByRole('alert')).toBeNull()
    expect(submit).toHaveProperty('disabled', true)
    vi.spyOn(currentReader, 'result', 'get').mockReturnValue('data:text/markdown;base64,TmV3')
    await act(async () => { currentReader.dispatchEvent(new ProgressEvent('load')) })
    fireEvent.click(submit)
    await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
    const request = createDraft.mock.calls[0]?.[0]
    expect(request?.requestId).toBeTypeOf('string')
    expect(createDraft).toHaveBeenCalledWith({ title: 'Approved title', requestId: request?.requestId,
      file: { filename: 'new.md', base64: 'TmV3' } })
  } finally { read.mockRestore() }
})

it('keeps a stale source from being imported when the latest file cannot be read', async () => {
  const { props, createDraft, openScript } = setup()
  const readers: FileReader[] = []
  const capture = function (this: FileReader) { readers.push(this) }
  const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementationOnce(capture).mockImplementationOnce(capture)
  try {
    const view = render(<DrawerScripts {...props} />)
    fireEvent.click(view.getByRole('button', { name: en.importDraft }))
    const dialog = within(view.getByRole('dialog', { name: en.importDraft }))
    const input = dialog.getByLabelText(new RegExp(en.draftSource, 'u'))
    const submit = dialog.getByRole('button', { name: en.importDraft })
    const choose = (file: File) => { fireEvent.change(input, { target: { files: [file] } }) }
    choose(new File(['Outdated'], 'first.md'))
    choose(new File(['Unreadable'], 'second.md'))
    const [stale, currentReader] = readers
    vi.spyOn(stale!, 'result', 'get').mockReturnValue('data:text/markdown;base64,T3V0ZGF0ZWQ=')
    await act(async () => { stale!.dispatchEvent(new ProgressEvent('load')) })
    expect(dialog.getByRole('status').textContent).toBe(en.loading)
    expect(submit).toHaveProperty('disabled', true)

    vi.spyOn(currentReader!, 'error', 'get').mockReturnValue(new DOMException('Source became unreadable', 'NotReadableError'))
    await act(async () => { currentReader!.dispatchEvent(new ProgressEvent('error')) })
    expect(dialog.getByRole('alert').textContent).toBe(en.draftCreateFailed)
    expect(dialog.queryByRole('status')).toBeNull()
    expect(submit).toHaveProperty('disabled', true)
    expect(createDraft).not.toHaveBeenCalled()

    fireEvent.change(dialog.getByRole('textbox', { name: en.draftName }), { target: { value: 'Recovered draft' } })
    choose(new File(['Current'], 'recovered.md'))
    await waitFor(() => { expect(submit).toHaveProperty('disabled', false) })
    fireEvent.click(submit)
    await waitFor(() => { expect(openScript).toHaveBeenCalledTimes(1) })
    const request = createDraft.mock.calls[0]?.[0]
    expect(request?.requestId).toBeTypeOf('string')
    expect(createDraft).toHaveBeenCalledExactlyOnceWith({ title: 'Recovered draft', requestId: request?.requestId,
      file: { filename: 'recovered.md', base64: 'Q3VycmVudA==' } })
  } finally { read.mockRestore() }
})

it('edits ordered dialogue in the scene script and retains fields that other Workshop features use', async () => {
  const { props, reads, saveStoryboard } = setup()
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  fireEvent.change(view.getByRole('combobox', { name: en.draftLayer }), { target: { value: 'storyboard' } })
  expect(view.getByText('Jin locks the door.')).toBeTruthy()
  expect(view.getByText(/Bring the book\./u)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.editStoryboard }))
  fireEvent.change(view.getByRole('textbox', { name: en.draftSceneDialogue }), { target: { value: 'Open the book.' } })
  fireEvent.click(view.getByRole('button', { name: en.save }))
  await waitFor(() => { expect(view.getByText(/Open the book\./u)).toBeTruthy() })
  const request = saveStoryboard.mock.calls[0]?.[0]
  expect(request).toMatchObject({ draftId: 45, episode: 3, baseRevision: 'board-3' })
  expect(JSON.parse(request?.shotsJson ?? '')).toEqual([{
    ...shot, elements: [shot.elements[0], { ...shot.elements[1], content: 'Open the book.' }],
  }])
  fireEvent.change(view.getByRole('combobox', { name: en.scriptEpisodes }), { target: { value: '4' } })
  expect(reads.some(url => url.hostname === 'workshop-draft-storyboard' && url.searchParams.get('episode') === '4')).toBe(true)
  expect(view.getByText(en.emptyStoryboard)).toBeTruthy()
})

it('shows scenes and history without rewriting an unsafe integer in stored scene metadata', () => {
  const storedShots = JSON.stringify([shot]).replace('"keep":true', '"keep":true,"externalId":9223372036854775807')
  const { props, saveStoryboard } = setup({ storedShots })
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  fireEvent.change(view.getByRole('combobox', { name: en.draftLayer }), { target: { value: 'storyboard' } })
  expect(view.getByText('Jin locks the door.')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.editStoryboard }))
  expect(view.getByRole('alert').textContent).toBe(en.draftStoryboardUnsafeNumbers)
  expect(view.queryByRole('button', { name: en.save })).toBeNull()
  expect(saveStoryboard).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: en.cancel }))
  expect(view.getByText('Jin locks the door.')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.episodeHistory }))
  const dialog = within(view.getByRole('dialog', { name: en.episodeHistory }))
  fireEvent.change(dialog.getByRole('combobox', { name: en.chooseDraftVersion }), { target: { value: '21' } })
  expect(dialog.getByText(/Market/u)).toBeTruthy()
  expect(dialog.getByRole('button', { name: en.restoreDraftVersion })).toHaveProperty('disabled', false)
})

it('restores a legacy revision for the chosen episode and layer when its version number equals the empty board version', async () => {
  const { props, restoreHistory, saveEpisode } = setup({ legacyEmptyBoard: true })
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  fireEvent.change(view.getByRole('combobox', { name: en.draftLayer }), { target: { value: 'storyboard' } })
  expect(view.getByText(en.emptyStoryboard)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.episodeHistory }))
  const dialog = within(view.getByRole('dialog', { name: en.episodeHistory }))
  const restore = dialog.getByRole('button', { name: en.restoreDraftVersion })
  expect(restore).toHaveProperty('disabled', true)
  fireEvent.change(dialog.getByRole('combobox', { name: en.chooseDraftVersion }), { target: { value: '21' } })
  expect(dialog.getByText(/Market/u)).toBeTruthy()
  expect(restoreHistory).not.toHaveBeenCalled()
  fireEvent.click(restore)
  await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
  expect(view.getByText(/Market/u)).toBeTruthy()
  expect(restoreHistory).toHaveBeenCalledWith({ draftId: 45, episode: 3, layer: 'storyboard', historyId: 21, baseRevision: 'board-3' })
  expect(saveEpisode).not.toHaveBeenCalled()
})

it.each(['loading', 'empty'] as const)('blocks restore while episode history is %s', (history) => {
  const { props, restoreHistory } = setup({ history })
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  fireEvent.click(view.getByRole('button', { name: en.episodeHistory }))
  const dialog = within(view.getByRole('dialog', { name: en.episodeHistory }))
  expect(dialog.getByText(history === 'loading' ? en.loading : en.emptyDraftHistory)).toBeTruthy()
  expect(dialog.getByRole('button', { name: en.restoreDraftVersion })).toHaveProperty('disabled', true)
  expect(restoreHistory).not.toHaveBeenCalled()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('dialog')).toBeNull()
})

it('keeps the previous preview from enabling restore after the version selection changes', () => {
  const { props, restoreHistory } = setup({ history: 'stale-preview' })
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  fireEvent.click(view.getByRole('button', { name: en.episodeHistory }))
  const dialog = within(view.getByRole('dialog', { name: en.episodeHistory }))
  const versions = dialog.getByRole('combobox', { name: en.chooseDraftVersion })
  const restore = dialog.getByRole('button', { name: en.restoreDraftVersion })

  fireEvent.change(versions, { target: { value: '21' } })
  expect(dialog.getByText('Jin watches the door.')).toBeTruthy()
  expect(restore).toHaveProperty('disabled', false)

  fireEvent.change(versions, { target: { value: '22' } })
  expect(dialog.queryByText('Jin watches the door.')).toBeNull()
  expect(dialog.getByRole('status').textContent).toBe(en.loading)
  expect(restore).toHaveProperty('disabled', true)
  expect(restoreHistory).not.toHaveBeenCalled()
})

it('retries the failed preview and restores the selected empty chapter', async () => {
  const { props, reads, restoreHistory } = setup({ history: 'preview-retry' })
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  fireEvent.click(view.getByRole('button', { name: en.episodeHistory }))
  const dialog = within(view.getByRole('dialog', { name: en.episodeHistory }))
  const restore = dialog.getByRole('button', { name: en.restoreDraftVersion })
  fireEvent.change(dialog.getByRole('combobox', { name: en.chooseDraftVersion }), { target: { value: '22' } })
  expect(dialog.getByRole('alert').textContent).toContain(en.draftHistoryFailed)
  expect(restore).toHaveProperty('disabled', true)

  fireEvent.click(dialog.getByRole('button', { name: en.retry }))
  expect(reads.some(url => url.hostname === 'workshop-draft-history-entry'
    && url.searchParams.get('row') === '22' && url.searchParams.get('retry') === '1')).toBe(true)
  expect(dialog.getByText(en.nothingHere)).toBeTruthy()
  expect(restore).toHaveProperty('disabled', false)
  expect(restoreHistory).not.toHaveBeenCalled()
  fireEvent.click(restore)
  await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
  expect(restoreHistory).toHaveBeenCalledExactlyOnceWith({ draftId: 45, episode: 3, layer: 'chapter', historyId: 22, baseRevision: 'episode-3' })
  expect(view.getByText(en.nothingHere)).toBeTruthy()
})

it.each([
  ['SCRIPT_EDITOR_VERSION_CHANGED', en.draftConflict, true],
  ['WORKSHOP_UNAVAILABLE', en.draftRestoreFailed, false],
] as const)('retries history reads and keeps the selected chapter open after %s', async (code, message, blocked) => {
  const { props, reads, restoreHistory } = setup({ history: 'retry' })
  restoreHistory.mockRejectedValueOnce(Object.assign(new Error('Restore rejected'), { code }))
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  fireEvent.click(view.getByRole('button', { name: en.episodeHistory }))
  const dialog = within(view.getByRole('dialog', { name: en.episodeHistory }))
  expect(dialog.getByRole('alert').textContent).toContain(en.draftHistoryFailed)
  fireEvent.click(dialog.getByRole('button', { name: en.retry }))
  expect(reads.some(url => url.hostname === 'workshop-draft-history' && url.searchParams.get('retry') === '1')).toBe(true)
  fireEvent.change(dialog.getByRole('combobox', { name: en.chooseDraftVersion }), { target: { value: '21' } })
  expect(dialog.getByText('Jin watches the door.')).toBeTruthy()
  const restore = dialog.getByRole('button', { name: en.restoreDraftVersion })
  fireEvent.click(restore)
  await waitFor(() => { expect(dialog.getByRole('alert').textContent).toContain(message) })
  expect(restore).toHaveProperty('disabled', blocked)
  expect(restoreHistory).toHaveBeenCalledWith({ draftId: 45, episode: 3, layer: 'chapter', historyId: 21, baseRevision: 'episode-3' })
})

it('keeps restore blocked after a conflict when the user previews another version', async () => {
  const { props, restoreHistory } = setup({ history: 'multiple' })
  restoreHistory.mockRejectedValueOnce(Object.assign(new Error('The episode changed'), { code: 'SCRIPT_EDITOR_VERSION_CHANGED' }))
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  fireEvent.click(view.getByRole('button', { name: en.episodeHistory }))
  const dialog = within(view.getByRole('dialog', { name: en.episodeHistory }))
  const versions = dialog.getByRole('combobox', { name: en.chooseDraftVersion })
  const restore = dialog.getByRole('button', { name: en.restoreDraftVersion })

  fireEvent.change(versions, { target: { value: '21' } })
  fireEvent.click(restore)
  await dialog.findByRole('alert')
  fireEvent.change(versions, { target: { value: '22' } })
  expect(dialog.getByText(en.nothingHere)).toBeTruthy()
  expect(dialog.getByRole('alert').textContent).toBe(en.draftConflict)
  expect(restore).toHaveProperty('disabled', true)
  expect(restoreHistory).toHaveBeenCalledTimes(1)
})

it('keeps the history dialog open until a pending restore settles', async () => {
  const { props, restoreHistory } = setup()
  const release = Promise.withResolvers<undefined>()
  const restoreVersion = restoreHistory.getMockImplementation()!
  restoreHistory.mockImplementationOnce(async (request) => {
    await release.promise
    return restoreVersion(request)
  })
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  fireEvent.click(view.getByRole('button', { name: en.episodeHistory }))
  const dialog = within(view.getByRole('dialog', { name: en.episodeHistory }))
  fireEvent.change(dialog.getByRole('combobox', { name: en.chooseDraftVersion }), { target: { value: '21' } })
  const restore = dialog.getByRole('button', { name: en.restoreDraftVersion })
  try {
    fireEvent.click(restore)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.getByRole('dialog', { name: en.episodeHistory })).toBeTruthy()
    expect(restore).toHaveProperty('disabled', true)
  } finally {
    await act(async () => { release.resolve(undefined) })
  }
  expect(view.queryByRole('dialog')).toBeNull()
  expect(view.getByText('Jin watches the door.')).toBeTruthy()
  expect(restoreHistory).toHaveBeenCalledTimes(1)
})

it.each(['chapters', 'storyboards', 'mixed', 'outline'] as const)('downloads %s in the selected format and supported scope', async (kind) => {
  const { props, exportDraft } = setup()
  const create = vi.fn(() => 'blob:file')
  const revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  try {
    const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
    const storyboard = kind === 'storyboards'
    if (storyboard) fireEvent.change(view.getByRole('combobox', { name: en.draftLayer }), { target: { value: 'storyboard' } })
    fireEvent.click(view.getByRole('button', { name: en.exportScriptDraft }))
    const dialog = within(view.getByRole('dialog', { name: en.exportScriptDraft }))
    const format = storyboard ? 'txt' : 'md'
    const exportKind = dialog.getByRole('combobox', { name: en.draftExportKind })
    expect(exportKind).toHaveProperty('value', storyboard ? 'storyboards' : 'chapters')
    fireEvent.change(dialog.getByRole('combobox', { name: en.draftExportFormat }), { target: { value: format } })
    const scope = dialog.getByRole('combobox', { name: en.draftExportEpisodes })
    fireEvent.change(scope, { target: { value: 'episode' } })
    if (storyboard) {
      fireEvent.change(scope, { target: { value: 'all' } })
      expect(scope).toHaveProperty('value', 'all')
      fireEvent.change(scope, { target: { value: 'episode' } })
      fireEvent.change(exportKind, { target: { value: 'chapters' } })
    }
    fireEvent.change(exportKind, { target: { value: kind } })
    const episodeExport = kind === 'chapters' || storyboard
    expect(scope).toHaveProperty('disabled', !episodeExport)
    expect(scope).toHaveProperty('value', episodeExport ? 'episode' : 'all')
    fireEvent.click(dialog.getByRole('button', { name: en.exportScriptDraft }))
    await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
    expect(exportDraft).toHaveBeenCalledWith({ draftId: 45, kind, format, ...(episodeExport ? { episode: 3 } : {}) })
    expect(click.mock.instances[0]).toHaveProperty('download', 'source.md')
    expect(create).toHaveBeenCalledWith(expect.any(Blob))
    await waitFor(() => { expect(revoke).toHaveBeenCalledWith('blob:file') })
  } finally {
    click.mockRestore()
    vi.unstubAllGlobals()
  }
})

it('keeps export settings through a failed download and allows dismissal after the request settles', async () => {
  const { props, exportDraft } = setup()
  const response = Promise.withResolvers<undefined>()
  exportDraft.mockImplementationOnce(async () => {
    await response.promise
    throw new Error('Export service unavailable')
  })
  const view = render(<DrawerScripts {...props} script={{ id: 'draft:45', title: draft.title }} />)
  fireEvent.click(view.getByRole('button', { name: en.exportScriptDraft }))
  const dialog = within(view.getByRole('dialog', { name: en.exportScriptDraft }))
  const scope = dialog.getByRole('combobox', { name: en.draftExportEpisodes })
  fireEvent.change(scope, { target: { value: 'episode' } })
  const submit = dialog.getByRole('button', { name: en.exportScriptDraft })
  try {
    fireEvent.click(submit)
    expect(scope).toHaveProperty('disabled', true)
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.getByRole('dialog', { name: en.exportScriptDraft })).toBeTruthy()
  } finally {
    await act(async () => { response.resolve(undefined) })
  }
  expect(dialog.getByRole('alert').textContent).toBe(en.draftExportFailed)
  expect(scope).toHaveProperty('value', 'episode')
  expect(submit).toHaveProperty('disabled', false)
  expect(exportDraft).toHaveBeenCalledExactlyOnceWith({ draftId: 45, kind: 'chapters', format: 'docx', episode: 3 })
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('dialog')).toBeNull()
})
