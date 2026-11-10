// @vitest-environment jsdom
/** Provider cache eviction must trigger a new download before exposing cuts. */
import { cleanup, render, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionVideoAnalysis, SessionVideoSource, SessionVideoSourceId } from '@deepseek-ai/dsh-session-video'
import { VideoShelf } from '../src/client/VideoShelf.tsx'
import type { VideoState } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

type Props = ComponentProps<typeof VideoShelf>
const id = brandString<SessionVideoSourceId>('provider')
const remote: SessionVideoSource = { id, label: 'provider', origin: 'generated', path: null, eventSeq: 1,
  presentedIndex: null, callId: null, status: 'remote-only', version: 'url:v1',
  playbackUrl: 'https://101.aigc.jubianai.net/test.mp4', remoteUrl: 'https://101.aigc.jubianai.net/test.mp4', issue: null }
const local: SessionVideoSource = { ...remote, status: 'local', version: 'file:v2', playbackUrl: '/local' }
const analysis = (version: string): SessionVideoAnalysis => ({ sourceId: id, sourceVersion: version, state: 'ready',
  durationSeconds: 1, width: 64, height: 64, shots: [], method: 'ffmpeg-scene', threshold: 0.3, issue: null })
Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('re-detects a visible evicted source even when an old URL-version analysis is ready', async () => {
  const state: VideoState = { sources: [remote], analyses: { [id]: analysis('url:v1') }, detectErrors: {}, open: false,
    selected: id, collected: {}, observed: { [id]: 1 }, issue: null, inventoryRevision: 0 }
  const listVideos = vi.fn().mockResolvedValueOnce({ sources: [remote], complete: true, issues: [] })
    .mockResolvedValueOnce({ sources: [local], complete: true, issues: [] })
  const detectShots = vi.fn().mockResolvedValue(analysis('file:v2'))
  const actions = { inventory: vi.fn(), analysis: vi.fn(), detectionFailed: vi.fn(), retryFailed: vi.fn(), toggle: vi.fn(),
    select: vi.fn(), openSource: vi.fn(), collect: vi.fn(), observe: vi.fn(), refreshInventory: vi.fn() }
  const props = { activeView: 'chat', sessionId: 'session', useStore: (selector: (value: VideoState) => unknown) => selector(state),
    useSession: (selector: (value: { running: boolean }) => unknown) => selector({ running: false }),
    useChat: (selector: (value: { order: string[] }) => unknown) => selector({ order: [] }),
    useInput: (selector: (value: { draft: string; draftRev: number }) => unknown) => selector({ draft: '', draftRev: 1 }),
    inputActions: {}, actions, listVideos, detectShots, pixelsPerSecond: 48, t: makeTranslate(en) } as Props
  render(<VideoShelf {...props} />)
  await waitFor(() => { expect(actions.analysis).toHaveBeenCalledWith(analysis('file:v2')) })
  expect(detectShots).toHaveBeenCalledOnce()
  expect(detectShots.mock.calls[0]?.slice(0, 3)).toEqual(['session', id, 'url:v1'])
  expect(actions.inventory).toHaveBeenLastCalledWith({ sources: [local], complete: true, issues: [] })
  expect(actions.detectionFailed).not.toHaveBeenCalled()
})

it('marks a refresh failure for retry instead of repeatedly downloading', async () => {
  const state: VideoState = { sources: [remote], analyses: {}, detectErrors: {}, open: false, selected: id,
    collected: {}, observed: { [id]: 1 }, issue: null, inventoryRevision: 0 }
  const listVideos = vi.fn().mockResolvedValueOnce({ sources: [remote], complete: true, issues: [] })
    .mockRejectedValueOnce(new Error('inventory unavailable'))
  const actions = { inventory: vi.fn(), analysis: vi.fn(), detectionFailed: vi.fn(), retryFailed: vi.fn(), toggle: vi.fn(),
    select: vi.fn(), openSource: vi.fn(), collect: vi.fn(), observe: vi.fn(), refreshInventory: vi.fn() }
  const props = { activeView: 'chat', sessionId: 'session', useStore: (selector: (value: VideoState) => unknown) => selector(state),
    useSession: (selector: (value: { running: boolean }) => unknown) => selector({ running: false }),
    useChat: (selector: (value: { order: string[] }) => unknown) => selector({ order: [] }),
    useInput: (selector: (value: { draft: string; draftRev: number }) => unknown) => selector({ draft: '', draftRev: 1 }),
    inputActions: {}, actions, listVideos, detectShots: vi.fn().mockResolvedValue(analysis('file:v2')),
    pixelsPerSecond: 48, t: makeTranslate(en) } as Props
  render(<VideoShelf {...props} />)
  await waitFor(() => { expect(actions.detectionFailed).toHaveBeenCalledWith(id, 'url:v1') })
  expect(props.detectShots).toHaveBeenCalledOnce()
})
