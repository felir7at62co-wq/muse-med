/** Video chips resolve current Host evidence when an ordinary draft is submitted. */
import { expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  createVideoReferenceSource, createVideoReviewReferenceSource, parseVideoReference,
  VIDEO_REVIEW_REFERENCE, VIDEO_REVIEW_REFERENCE_SOURCE,
} from '../src/client/references.ts'
import { VIDEO_REVIEW_REQUEST, videoWorkspaceAddress } from '../src/client/target-selection.ts'
import { inventory, sessionId, shot, source } from './selection-fixture.client.ts'

it('serializes selected media through its own codec and preserves exact advice links', async () => {
  const list = vi.fn().mockResolvedValue({ ok: true, value: inventory() }), open = vi.fn().mockReturnValue(true)
  const selected = shot(), ref = videoWorkspaceAddress(sessionId, selected)
  const provider = createVideoReferenceSource(list, open, { invalid: () => 'Invalid selection', stale: () => 'Choose again' })
  const signal = new AbortController().signal
  const text = await provider.codec?.serialize(ref, signal)
  expect(text).toContain('"start_seconds": 4')
  expect(text).toContain('"review_link":')
  expect(text).not.toContain('regenerate')
  expect(list).toHaveBeenCalledExactlyOnceWith(sessionId, signal)
  expect(parseVideoReference(ref)).toEqual({ sessionId, target: selected })
  expect(parseVideoReference(videoWorkspaceAddress(sessionId))).toBeNull()
  expect(await provider.candidates({ sessionId }, { query: '', position: 'inline', drilled: false, signal })).toEqual([])
  expect(provider.onPick({ candidate: { name: 'video' }, session: { sessionId }, position: 'inline', via: 'menu',
    action: 'pick', span: { start: 0, end: 0, draftRev: 0 } })).toBeUndefined()
  expect(provider.codec?.clipboardText(ref)).toBe(ref)
  expect(provider.openReference?.({ sessionId }, { ref: videoWorkspaceAddress(sessionId) })).toBe(false)
  expect(provider.openReference?.({ sessionId }, { ref })).toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(ref)
  open.mockReturnValueOnce(false)
  expect(provider.openReference?.({ sessionId }, { ref })).toBe(false)
})

it('blocks submission of an expired source instead of substituting its current version', async () => {
  const list = vi.fn().mockResolvedValue({ ok: true, value: inventory([{ ...source(), version: 'v2' }]) })
  const provider = createVideoReferenceSource(list, () => false, { invalid: () => 'Invalid selection', stale: () => 'Choose again' })
  const signal = new AbortController().signal
  await expect(provider.codec?.serialize(videoWorkspaceAddress(sessionId, shot()), signal)).rejects.toThrow('Choose again')
  await expect(provider.codec?.serialize('invalid', signal)).rejects.toThrow('Invalid selection')
  const failure = new RemoteError('gateway/internal', 'Unavailable inventory', {})
  list.mockResolvedValueOnce({ ok: false, error: failure })
  await expect(provider.codec?.serialize(videoWorkspaceAddress(sessionId, shot()), signal)).rejects.toBe(failure)
})

it('copies the readable review mode and serializes its instruction only on submission', async () => {
  const provider = createVideoReviewReferenceSource({ label: () => 'Read-only review', invalid: () => 'Invalid review mode' })
  expect(provider.name).toBe(VIDEO_REVIEW_REFERENCE_SOURCE)
  const clipboard = provider.codec?.clipboardText(VIDEO_REVIEW_REFERENCE)
  expect(clipboard).toBe('Read-only review')
  expect(clipboard).not.toContain(VIDEO_REVIEW_REQUEST)
  expect(await provider.codec?.serialize(VIDEO_REVIEW_REFERENCE, new AbortController().signal)).toBe(VIDEO_REVIEW_REQUEST)
})

it('uses the current language for copied review labels and invalid-reference reports', async () => {
  const copy = {
    zh: { label: '仅审阅', invalid: '审阅引用无效' },
    en: { label: 'Read-only review', invalid: 'Invalid review mode' },
  }
  let language: keyof typeof copy = 'zh'
  const provider = createVideoReviewReferenceSource({ label: () => copy[language].label, invalid: () => copy[language].invalid })
  const signal = new AbortController().signal
  expect(provider.codec?.clipboardText(VIDEO_REVIEW_REFERENCE)).toBe('仅审阅')
  await expect(provider.codec?.serialize('invalid', signal)).rejects.toThrow('审阅引用无效')
  language = 'en'
  expect(provider.codec?.clipboardText(VIDEO_REVIEW_REFERENCE)).toBe('Read-only review')
  await expect(provider.codec?.serialize('invalid', signal)).rejects.toThrow('Invalid review mode')
})

it('refuses an aborted review submission without producing an instruction', async () => {
  const provider = createVideoReviewReferenceSource({ label: () => 'Read-only review', invalid: () => 'Invalid review mode' })
  const controller = new AbortController(), reason = new Error('Draft submission cancelled')
  controller.abort(reason)
  await expect(provider.codec?.serialize(VIDEO_REVIEW_REFERENCE, controller.signal)).rejects.toBe(reason)
})

it('keeps the review mode out of ordinary reference discovery and picking', async () => {
  const provider = createVideoReviewReferenceSource({ label: () => 'Read-only review', invalid: () => 'Invalid review mode' })
  const signal = new AbortController().signal
  expect(await provider.candidates({ sessionId }, { query: '', position: 'inline', drilled: false, signal })).toEqual([])
  expect(provider.onPick({ candidate: { name: 'Read-only review' }, session: { sessionId }, position: 'inline', via: 'menu',
    action: 'pick', span: { start: 0, end: 0, draftRev: 0 } })).toBeUndefined()
})
