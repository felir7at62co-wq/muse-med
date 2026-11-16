/** Video chips resolve current Host evidence when an ordinary draft is submitted. */
import { expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createVideoReferenceSource, parseVideoReference } from '../src/client/references.ts'
import { videoWorkspaceAddress } from '../src/client/target-selection.ts'
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
