// @vitest-environment jsdom
/** Storyboard edits preserve stored scene fields and commit against the version the user reviewed. */
import { act, cleanup, fireEvent, render, within, type RenderResult } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScriptDraft, ScriptDraftEpisode, ScriptDraftStoryboard } from '@deepseek-ai/dsh-workbench-connection/types'
import { afterEach, expect, it, vi } from 'vitest'
import { DraftView } from '../src/client/DrawerScriptDraft.tsx'
import { StoryboardEditor, StoryboardPreview } from '../src/client/DrawerScriptStoryboard.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
type EditorProps = Parameters<typeof StoryboardEditor>[0]

afterEach(cleanup)

function scene(view: RenderResult, title: string) {
  const row = view.getByRole('heading', { name: title }).closest('li')
  if (row === null) throw new Error(`No scene row for ${title}`)
  return within(row)
}

it('reads and edits historical scene, dialogue and cast fields in their original storage format', () => {
  const flat = {
    scene: 7, time_loc: 'Night', location: 'Old cinema', shot_type: 'wide', characters: 'Ari',
    action: 'The projector sparks.', dialogue: 'Who locked the door?', notes: 'Keep the projection off-screen.', metadata: { key: 0.25 },
  }
  const line = { character: 'Mo', parenthetical: 'whispering', action: 'glances back', line: 'Is anyone there?', timing: 2 }
  const cue = { character: 'Ari', parenthetical: 'in silence' }
  const actionLine = { type: 'action', text: 'A window shatters.' }
  const history = {
    shot_no: 12, action: 'The street is quiet.', characters: ['Mo', 42, 'Ari'],
    lines: ['I saw a light.', null, line, cue, actionLine, { type: 'flashback_start' }, { type: 'flashback_end' }],
  }
  const unnumbered = { action: 'Ari closes the window.' }
  const json = JSON.stringify([flat, history, unnumbered])
  const firstTitle = t('draftSceneNumber', { number: '7' })
  const secondTitle = t('shotNumber', { index: '12' })
  const preview = render(<StoryboardPreview json={json} t={t} />)
  const oldScene = scene(preview, firstTitle)
  expect(oldScene.getByText('Night · Old cinema · wide')).toBeTruthy()
  expect(oldScene.getByText('The projector sparks.')).toBeTruthy()
  expect(oldScene.getByText('Who locked the door?')).toBeTruthy()
  expect(oldScene.getByText('Keep the projection off-screen.')).toBeTruthy()
  const dialogue = scene(preview, secondTitle)
  expect(dialogue.getByText('Mo、Ari')).toBeTruthy()
  expect(dialogue.getByText('The street is quiet.')).toBeTruthy()
  expect(dialogue.getByText('I saw a light.')).toBeTruthy()
  expect(dialogue.getByText('Mo (whispering) 【glances back】 · Is anyone there?')).toBeTruthy()
  expect(dialogue.getByText('Ari (in silence)')).toBeTruthy()
  expect(dialogue.getByText(actionLine.text)).toBeTruthy()
  expect(dialogue.getByText(en.draftFlashbackStart)).toBeTruthy()
  expect(dialogue.getByText(en.draftFlashbackEnd)).toBeTruthy()
  expect(scene(preview, t('shotNumber', { index: '3' })).getByText(unnumbered.action)).toBeTruthy()
  preview.unmount()

  const save = vi.fn<EditorProps['save']>()
  const view = render(<StoryboardEditor json={json} t={t} busy={false} blocked={false} cancel={vi.fn()} save={save} />)
  expect(view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  const first = scene(view, firstTitle)
  fireEvent.change(first.getByRole('textbox', { name: en.draftSceneId }), { target: { value: '7B' } })
  fireEvent.change(first.getByRole('textbox', { name: en.draftSceneAction }), { target: { value: 'The screen goes dark.' } })
  fireEvent.change(first.getByRole('textbox', { name: en.draftSceneDialogue }), { target: { value: 'Stay here.' } })
  fireEvent.change(first.getByRole('textbox', { name: en.character }), { target: { value: ' Ari, Mo、 Mei， ' } })
  fireEvent.change(first.getByRole('textbox', { name: en.draftSceneNotes }), { target: { value: 'Repeat from the doorway.' } })

  const second = scene(view, secondTitle)
  expect(second.queryByRole('button', { name: en.addSceneAction })).toBeNull()
  fireEvent.change(second.getByDisplayValue('I saw a light.'), { target: { value: 'Someone left the light on.' } })
  fireEvent.change(second.getByDisplayValue(line.character), { target: { value: 'Mei' } })
  fireEvent.change(second.getByDisplayValue(line.line), { target: { value: 'Is the door open?' } })
  fireEvent.click(second.getByRole('button', { name: en.addSceneDialogue }))
  const added = second.getAllByRole('textbox', { name: en.draftSceneDialogue }).at(-1)!
  fireEvent.change(added, { target: { value: 'Get inside.' } })
  fireEvent.click(view.getByRole('button', { name: en.addDraftScene }))
  const following = scene(view, t('shotNumber', { index: '13' }))
  fireEvent.change(following.getByRole('textbox', { name: en.draftSceneAction }), { target: { value: 'The light fails.' } })
  fireEvent.click(view.getByRole('button', { name: en.save }))

  expect(save).toHaveBeenCalledTimes(1)
  expect(JSON.parse(save.mock.calls[0]![0])).toEqual([
    { ...flat, scene: '7B', action: 'The screen goes dark.', dialogue: 'Stay here.', characters: ['Ari', 'Mo', 'Mei'], notes: 'Repeat from the doorway.' },
    { ...history, lines: ['Someone left the light on.', null,
      { ...line, character: 'Mei', line: 'Is the door open?' }, cue, actionLine,
      { type: 'flashback_start' }, { type: 'flashback_end' }, { type: 'dialogue', character: '', content: 'Get inside.' }] },
    unnumbered,
    { shot_no: 13, action: 'The light fails.', dialogue: '' },
  ])
})

it('adds structured action and dialogue without reusing an occupied shot number in an imported board', () => {
  const legacyId = Number.MAX_SAFE_INTEGER
  const opening = { shot_no: legacyId, elements: [{ type: 'flashback_start', clipId: 'preserve-me' }] }
  const other = { shot_no: 3, action: 'A cutaway.' }
  const save = vi.fn<EditorProps['save']>()
  const view = render(<StoryboardEditor json={JSON.stringify([opening, other])} t={t} busy={false} blocked={false}
    cancel={vi.fn()} save={save} />)
  const front = scene(view, t('shotNumber', { index: String(legacyId) }))
  fireEvent.click(front.getByRole('button', { name: en.addSceneAction }))
  fireEvent.change(front.getByRole('textbox', { name: en.draftSceneAction }), { target: { value: 'The frame dissolves.' } })
  fireEvent.click(front.getByRole('button', { name: en.addSceneDialogue }))
  fireEvent.change(front.getByRole('textbox', { name: en.draftSpeaker }), { target: { value: 'Mo' } })
  fireEvent.change(front.getByRole('textbox', { name: en.draftSceneDialogue }), { target: { value: 'I remember this.' } })
  fireEvent.click(view.getByRole('button', { name: en.addDraftScene }))
  const added = scene(view, t('shotNumber', { index: '4' }))
  fireEvent.change(added.getByRole('textbox', { name: en.draftSceneAction }), { target: { value: 'Mo folds the letter.' } })
  fireEvent.click(scene(view, t('shotNumber', { index: '3' })).getByRole('button', { name: en.removeDraftScene }))
  fireEvent.click(view.getByRole('button', { name: en.save }))

  expect(save).toHaveBeenCalledTimes(1)
  expect(JSON.parse(save.mock.calls[0]![0])).toEqual([
    { ...opening, elements: [...opening.elements, { type: 'action', content: 'The frame dissolves.' },
      { type: 'dialogue', character: 'Mo', content: 'I remember this.' }] },
    { shot_no: 4, action: 'Mo folds the letter.', dialogue: '' },
  ])
})

it.each([
  { json: '[{"scene": 1', warning: en.draftStoryboardInvalid },
  { json: '[{"scene": 1}, null]', warning: en.draftStoryboardInvalid },
  { json: '[{"scene": 1, "notes": "The memory fades.", "camera": {"calibration": [1e400]}}]', warning: en.draftStoryboardUnsafeNumbers },
])('keeps non-editable imported boards from being rewritten ($warning)', ({ json, warning }) => {
  const preview = render(<StoryboardPreview json={json} t={t} />)
  if (warning === en.draftStoryboardUnsafeNumbers) expect(preview.getByText('The memory fades.')).toBeTruthy()
  else expect(preview.getByRole('alert').textContent).toBe(warning)
  preview.unmount()

  const cancel = vi.fn()
  const save = vi.fn()
  const view = render(<StoryboardEditor json={json} t={t} busy={false} blocked={false} cancel={cancel} save={save} />)
  expect(view.getByRole('alert').textContent).toBe(warning)
  expect(view.queryByRole('button', { name: en.save })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: en.cancel }))
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(save).not.toHaveBeenCalled()
})

it('keeps one storyboard save in flight and requires the new revision after a conflict', async () => {
  type Props = Parameters<typeof DraftView>[0]
  const draft: ScriptDraft = { id: 45, title: 'Cinema at night', status: 'created', episodeCount: 1, updatedAt: null,
    revision: 'draft-1', canFinalize: true, context: { outline: null, storyBible: null }, episodes: [{ episode: 2, title: 'The cinema' }] }
  const chapter: ScriptDraftEpisode = { draftId: draft.id, episode: 2, title: 'The cinema', revision: 'chapter-1', version: 1,
    content: 'The lights dim.', candidate: null }
  const row = { scene: 7, action: 'The projector sparks.' }
  const newer = { ...row, action: 'The projector goes dark.' }
  let board: ScriptDraftStoryboard = { draftId: draft.id, episode: 2, title: chapter.title, revision: 'board-1', version: 1,
    shotsJson: JSON.stringify([row]), exists: true, stale: false }
  const release = Promise.withResolvers<undefined>()
  const saveStoryboard = vi.fn<Props['draftActions']['saveStoryboard']>().mockImplementationOnce(async () => {
    await release.promise
    throw new Error('Connection lost')
  }).mockImplementationOnce(async () => {
    board = { ...board, revision: 'board-2', version: 2, shotsJson: JSON.stringify([newer]), stale: true }
    throw Object.assign(new Error('Scene changed on the server'), { code: 'SCRIPT_EDITOR_VERSION_CHANGED' })
  }).mockImplementationOnce(async ({ shotsJson }) => ({ ...board, revision: 'board-3', version: 3, shotsJson, stale: false }))
  const useResource = ((address: string) => {
    const url = new URL(address)
    const value = url.hostname === 'workshop-draft' ? draft : url.hostname === 'workshop-draft-episode' ? chapter
      : url.hostname === 'workshop-draft-storyboard' ? board : undefined
    return { status: value === undefined ? 'none' : 'live', value, failure: undefined }
  }) as Props['useResource']
  const view = render(<DraftView draftId={draft.id} epoch={3} t={t} useResource={useResource} quote={vi.fn()} openScript={vi.fn()}
    draftActions={{ saveStoryboard, createDraft: vi.fn(), applyCandidate: vi.fn(), discardCandidate: vi.fn(), saveEpisode: vi.fn(),
      restoreHistory: vi.fn(), exportDraft: vi.fn(), finalizeDraft: vi.fn() }} />)
  const layer = view.getByRole('combobox', { name: en.draftLayer })
  fireEvent.change(layer, { target: { value: 'storyboard' } })
  fireEvent.click(view.getByRole('button', { name: en.editStoryboard }))
  const save = () => view.getByRole('button', { name: en.save })
  const action = () => view.getByRole('textbox', { name: en.draftSceneAction })
  fireEvent.change(action(), { target: { value: 'The reel snaps.' } })
  try {
    fireEvent.click(save())
    expect(save()).toHaveProperty('disabled', true)
    expect(action()).toHaveProperty('disabled', true)
    expect(layer).toHaveProperty('disabled', true)
    fireEvent.click(save())
    expect(saveStoryboard).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => { release.resolve(undefined) })
  }
  expect(view.getByRole('alert').textContent).toBe(en.draftSaveFailed)
  expect(action()).toHaveProperty('value', 'The reel snaps.')
  fireEvent.click(save())
  expect((await view.findByText(en.draftConflict)).textContent).toBe(en.draftConflict)
  expect(save()).toHaveProperty('disabled', true)
  expect(saveStoryboard.mock.calls).toEqual(Array.from({ length: 2 }, () => [{ draftId: draft.id, episode: 2,
    baseRevision: 'board-1', shotsJson: JSON.stringify([{ ...row, action: 'The reel snaps.' }]) }]))

  fireEvent.click(view.getByRole('button', { name: en.cancel }))
  fireEvent.click(view.getByRole('button', { name: en.refresh }))
  expect(view.getByText(en.draftStoryboardStale)).toBeTruthy()
  expect(view.getByText(newer.action)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.editStoryboard }))
  expect(action()).toHaveProperty('value', newer.action)
  fireEvent.change(action(), { target: { value: 'The room goes dark.' } })
  fireEvent.click(save())

  expect(await view.findByText('The room goes dark.')).toBeTruthy()
  expect(view.getByText(en.draftSaved)).toBeTruthy()
  expect(view.queryByText(en.draftStoryboardStale)).toBeNull()
  expect(saveStoryboard).toHaveBeenLastCalledWith({ draftId: draft.id, episode: 2, baseRevision: 'board-2',
    shotsJson: JSON.stringify([{ ...newer, action: 'The room goes dark.' }]) })
})
