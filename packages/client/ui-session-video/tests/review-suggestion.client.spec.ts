// @vitest-environment jsdom
/** Published advice adds a guarded ordinary-text request without executing a modification. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionVideoAnalysis } from '@deepseek-ai/dsh-session-video/types'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { SessionInputShell } from '../../ui-conversation/src/client/input/facade.ts'
import { bringVideoSuggestion, type VideoSuggestionEditor } from '../src/client/review-suggestion.ts'
import { parseVideoWorkspaceAddress, serializeVideoTargets, videoWorkspaceAddress, VIDEO_SUGGESTION_MAX_LENGTH } from '../src/client/target-selection.ts'
import type { VideoWorkspaceNavigation } from '../src/client/target-selection.ts'
import { VIDEO_REFERENCE_SOURCE, VIDEO_REVIEW_REFERENCE, VIDEO_REVIEW_REFERENCE_SOURCE } from '../src/client/references.ts'
import { authoredShots } from '../src/client/timeline.ts'
import { inventory, sessionId, shot, source, whole } from './selection-fixture.client.ts'

afterEach(() => { vi.restoreAllMocks() })

const suggestion = 'Increase the brightness of this shot and preserve the original.'
const item = source()
const target = shot(item)
const observed: SessionVideoAnalysis = { sourceId: item.id, sourceVersion: 'v1', state: 'ready', durationSeconds: 8,
  width: 180, height: 320, method: 'ffmpeg-scene', threshold: 0.3, issue: null,
  shots: [{ id: target.shotId, index: 2, startSeconds: 4, endSeconds: 8, thumbnail: null }] }
const navigation: VideoWorkspaceNavigation = { sessionId, target, editSuggestion: suggestion }
const request = { sessionId, navigation, inventory: inventory([item]), analyses: [observed] }

function fixture() {
  const ctx = new Context(), submit = vi.fn(async () => ({ kind: 'success' as const }))
  const shell = new SessionInputShell({ actx: ctx, defaultSink: submit,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: token => token } })
  onTestFinished(async () => { shell.dispose(); await ctx.fiber.dispose() })
  const editor: VideoSuggestionEditor = {
    get input() { return shell.snapshot },
    actions: { captureInsertion: () => shell.actions.captureInsertion(),
      insertText: vi.fn<VideoSuggestionEditor['actions']['insertText']>((text, span) => shell.actions.insertText(text, span)), persistDraft: vi.fn() },
    addTargetReference: vi.fn<VideoSuggestionEditor['addTargetReference']>((selected, label, span) => {
      const ref = videoWorkspaceAddress(sessionId, selected)
      if (shell.snapshot.occurrences.some(value => value.source === VIDEO_REFERENCE_SOURCE && value.ref === ref)) return true
      return shell.insertReference({ source: VIDEO_REFERENCE_SOURCE, ref, label, clipboardText: `@${label}` }, { ...span, start: span.end })
    }),
    setReviewMode: vi.fn(() => shell.snapshot.occurrences.filter(value => value.source === VIDEO_REVIEW_REFERENCE_SOURCE)
      .every(value => shell.removeReference(value))),
  }
  return { shell, editor, submit }
}

it('decodes one bounded suggested change without altering its source, version or interval', () => {
  const address = videoWorkspaceAddress(sessionId, target)
  expect(parseVideoWorkspaceAddress(`${address}&suggestion=${encodeURIComponent(suggestion)}`)).toEqual(navigation)
  expect(parseVideoWorkspaceAddress(`${videoWorkspaceAddress(sessionId, whole(item))}&suggestion=Keep%20A%2FB%20%26%20C`))
    .toEqual({ sessionId, target: whole(item), editSuggestion: 'Keep A/B & C' })
  expect(parseVideoWorkspaceAddress(`${address}&suggestion=${'a'.repeat(VIDEO_SUGGESTION_MAX_LENGTH)}`)?.editSuggestion)
    .toHaveLength(VIDEO_SUGGESTION_MAX_LENGTH)
  for (const text of ['', ' ', ' leading', 'trailing ', 'line\nbreak', 'tab\ttext', '<!-- mode -->', '\u007f', 'a\u0085b', 'a\u2028b', 'a'.repeat(VIDEO_SUGGESTION_MAX_LENGTH + 1)]) {
    expect(parseVideoWorkspaceAddress(`${address}&suggestion=${encodeURIComponent(text)}`), text).toBeNull()
  }
  for (const suffix of ['&suggestion=One&suggestion=Two', '#fragment']) {
    expect(parseVideoWorkspaceAddress(`${address}${suffix}`)).toBeNull()
  }
  expect(parseVideoWorkspaceAddress(`${videoWorkspaceAddress(sessionId)}?suggestion=Change`)).toBeNull()
  expect(parseVideoWorkspaceAddress(address.replace('session-video/', 'session-video:99/'))).toBeNull()
})

it('keeps unfinished text and other references, clears read-only mode and adds an unsent suggestion at the captured caret', () => {
  const { shell, editor, submit } = fixture()
  shell.setDraft('Keep my unfinished draft. ')
  expect(shell.insertReference({ source: 'file', ref: 'notes.txt', label: 'notes.txt', clipboardText: '@notes.txt' }, shell.actions.captureInsertion())).toBe(true)
  expect(shell.insertReference({ source: VIDEO_REVIEW_REFERENCE_SOURCE, ref: VIDEO_REVIEW_REFERENCE,
    label: 'Read-only review', clipboardText: 'Read-only review' }, shell.actions.captureInsertion())).toBe(true)
  const label = vi.fn(() => 'Video first · v1 · 4–8s')
  expect(bringVideoSuggestion(request, editor, label)).toBe('applied')
  expect(label).toHaveBeenCalledExactlyOnceWith(item, target)
  expect(shell.snapshot.draft).toContain('Keep my unfinished draft.')
  expect(shell.snapshot.draft).toContain(suggestion)
  expect(shell.snapshot.draft).not.toContain('muse-video-review')
  expect(shell.snapshot.occurrences.map(value => value.source)).toEqual(['file', VIDEO_REFERENCE_SOURCE])
  expect(shell.snapshot.occurrences[1]).toMatchObject({ ref: videoWorkspaceAddress(sessionId, target), label: 'Video first · v1 · 4–8s' })
  expect(editor.actions.persistDraft).toHaveBeenCalledOnce()
  expect(submit).not.toHaveBeenCalled()
})

it('reuses an existing source chip and accepts a verified authored interval without detected cuts', () => {
  const { shell, editor } = fixture()
  const authoredSource = { ...item, production: { scriptId: 7, episodeNumber: 3,
    shotRanges: [{ shotNumber: 12, startSeconds: 1, endSeconds: 2 }] } }
  const authored = authoredShots(authoredSource)[0]
  if (authored === undefined) throw Error('Missing observed authored interval')
  const authoredTarget = { ...target, shotId: authored.id, startSeconds: 1, endSeconds: 2 }
  const next = { ...request, inventory: inventory([authoredSource]), analyses: [], navigation: { ...navigation, target: authoredTarget } }
  expect(editor.addTargetReference(authoredTarget, 'Existing selection', shell.actions.captureInsertion())).toBe(true)
  expect(bringVideoSuggestion(next, editor, () => 'Updated label')).toBe('applied')
  expect(shell.snapshot.occurrences).toHaveLength(1)
  expect(shell.snapshot.occurrences[0]?.label).toBe('Existing selection')
  expect(shell.snapshot.draft).toContain(suggestion)
})

it('refuses cross-conversation and malformed suggestions before changing the draft', () => {
  const { shell, editor } = fixture(), other = brandString<SessionId>('another-session')
  shell.setDraft('Do not lose this draft')
  for (const next of [
    { ...request, sessionId: other }, { ...request, inventory: { ...request.inventory, sessionId: other } },
    { ...request, navigation: { sessionId } }, { ...request, navigation: { sessionId, target } },
    { ...request, navigation: { ...navigation, editSuggestion: '<muse-video-selection>' } },
  ]) expect(bringVideoSuggestion(next, editor, () => 'Source')).toBe('invalid')
  expect(shell.snapshot.draft).toBe('Do not lose this draft')
  expect(editor.addTargetReference).not.toHaveBeenCalled()
})

it('rejects replaced, missing, unavailable and unobserved coordinates without broadening the selection', () => {
  const { shell, editor } = fixture()
  shell.setDraft('Keep this')
  for (const next of [
    { ...request, inventory: inventory([]) }, { ...request, inventory: inventory([{ ...item, version: 'v2' }]) },
    { ...request, inventory: inventory([{ ...item, playbackUrl: null }]) }, { ...request, analyses: [] },
    { ...request, analyses: [{ ...observed, sourceVersion: 'old' }] },
    { ...request, navigation: { ...navigation, target: { ...target, endSeconds: 7 } } },
    { ...request, navigation: { ...navigation, target: { ...target, startSeconds: 3 } } },
    { ...request, navigation: { ...navigation, target: { ...target, shotId: shot(item, 1).shotId } } },
  ]) expect(bringVideoSuggestion(next, editor, () => 'Source')).toBe('stale')
  expect(shell.snapshot.draft).toBe('Keep this')
  expect(editor.addTargetReference).not.toHaveBeenCalled()
})

it('keeps later user edits and a locked or claimed draft untouched', () => {
  const { shell, editor } = fixture()
  shell.setDraft('Earlier draft')
  const earlier = shell.snapshot
  shell.setDraft('Later user edits')
  expect(bringVideoSuggestion(request, { ...editor, input: earlier }, () => 'Source')).toBe('draft-refused')
  for (const phase of ['claimed', 'adjudicating', 'sending', 'submitting'] as const) {
    expect(bringVideoSuggestion(request, { ...editor, input: { draftRev: shell.snapshot.draftRev, phase } }, () => 'Source')).toBe('draft-refused')
  }
  expect(shell.snapshot.draft).toBe('Later user edits')
  expect(editor.addTargetReference).not.toHaveBeenCalled()
  expect(editor.actions.persistDraft).not.toHaveBeenCalled()
})

it('reports insertion refusals while preserving the draft and any already inserted exact video chip', () => {
  const { shell, editor, submit } = fixture()
  shell.setDraft('Preserve this request')
  const label = () => 'Source'
  vi.mocked(editor.addTargetReference).mockReturnValueOnce(false)
  expect(bringVideoSuggestion(request, editor, label)).toBe('draft-refused')
  expect(editor.actions.persistDraft).not.toHaveBeenCalled()
  vi.mocked(editor.setReviewMode).mockReturnValueOnce(false)
  expect(bringVideoSuggestion(request, editor, label)).toBe('draft-refused')
  expect(shell.snapshot.occurrences).toHaveLength(1)
  vi.mocked(editor.actions.insertText).mockReturnValueOnce(false)
  expect(bringVideoSuggestion(request, editor, label)).toBe('draft-refused')
  expect(shell.snapshot.draft).toContain('Preserve this request')
  expect(shell.snapshot.draft).not.toContain(suggestion)
  expect(shell.snapshot.occurrences).toHaveLength(1)
  expect(editor.actions.persistDraft).toHaveBeenCalledTimes(2)
  expect(submit).not.toHaveBeenCalled()
})

it('adds a whole-video suggestion without detection or automatic submission', () => {
  const { shell, editor, submit } = fixture()
  expect(bringVideoSuggestion({ ...request, analyses: [], navigation: { ...navigation, target: whole(item) } }, editor, () => 'Whole video')).toBe('applied')
  expect(shell.snapshot.draft).toContain(suggestion)
  const serialized = serializeVideoTargets([whole(item)], [item], sessionId)
  if (!serialized.ok) throw Error('Current whole-video selection was refused')
  expect(serialized.text).toContain('"source_version": "v1"')
  expect(submit).not.toHaveBeenCalled()
})
