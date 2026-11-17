// @vitest-environment jsdom
/** The Settings subsection keeps accepted facts while current query permission expires. */
import { useCallback, useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ResourceProtocol, ResourceProtocolMap, ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { EpisodeClient } from '../src/client/episode-directory.ts'
import type { EpisodeDeliveryStatus } from '../src/types.ts'
import { EpisodeExportSection, type EpisodeSectionProps } from '../src/client/EpisodeExportSection.tsx'
import { RecoveryDirectory } from '../src/client/recovery-directory.ts'
import { en } from '../src/client/locales.ts'
import { episodeClientFixture, input, original, ready, attempt } from './fixtures/episode-client.client.ts'

afterEach(cleanup)
const delivered: EpisodeDeliveryStatus = { ...original, state: 'completed', canResume: false,
  output: { path: 'exports/original.mp4', sha256: input.digest, bytes: 26 } }
function fixture(overrides: Parameters<typeof episodeClientFixture>[0] = {}) {
  const f = episodeClientFixture(overrides), recovery = new RecoveryDirectory()
  recovery.state.update((state) => { state.projectDir = '/project'; state.status = { projectDir: '/project', enabled: true,
    configurable: true, decoderAvailable: true, reports: [] } })
  const props: EpisodeSectionProps = { t: makeTranslate(en), useEpisodeState: bindSnapshotSelector(f.directory.state),
    useRecoveryState: bindSnapshotSelector(recovery.state),
    useResource: <P extends ResourceProtocol>(address: string): ResourceSnapshot<ResourceProtocolMap[P]> => {
      const source = f.resources.source(address)
      const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source])
      const snapshot = useCallback(() => source.getSnapshot(), [source])
      return useSyncExternalStore(subscribe, snapshot) as ResourceSnapshot<ResourceProtocolMap[P]>
    },
    setEpisodeText: (value) => { f.directory.retireSelection(value) },
    checkEpisode: (value) => { f.directory.check(value) },
    loadEpisodeHistory: (value) => { f.directory.history(value) },
    selectEpisodeOriginal: (value, address) => { f.directory.selectOriginal(value, address) },
    refreshEpisode: () => { f.directory.refresh() }, admitEpisode: resume => f.directory.admit(resume) }
  render(<EpisodeExportSection {...props} />)
  return { ...f, props, recovery }
}

it('makes no readiness request on mount or episode edits, and checks only an explicit valid number', async () => {
  const f = fixture()
  expect(f.api.episodeReadiness).not.toHaveBeenCalled()
  const field = screen.getByLabelText(en.episodeNumber)
  fireEvent.change(field, { target: { value: '0' } })
  expect(screen.getByRole('button', { name: en.episodeCheck }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(field, { target: { value: '2' } })
  expect(f.api.episodeReadiness).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.episodeCheck }))
  await waitFor(() => { expect(f.api.episodeReadiness).toHaveBeenCalledWith({ projectDir: '/project', episode: 2 }) })
})

it('lists bounded history without selecting latest, and permits explicit offline resume without readiness', async () => {
  const f = fixture({ episodeStatus: vi.fn<EpisodeClient['episodeStatus']>(async () => ({ ok: true, value: { ...original, canResume: true } })) })
  fireEvent.click(screen.getByRole('button', { name: en.episodeHistory }))
  const select = await screen.findByRole('button', { name: en.episodeSelect })
  expect(f.api.episodeStatus).not.toHaveBeenCalled()
  fireEvent.click(select)
  const resume = await screen.findByRole('button', { name: en.episodeResume })
  await waitFor(() => { expect(resume.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(resume)
  await waitFor(() => { expect(f.api.admitEpisode).toHaveBeenCalledWith({ ...input, resume: true }) })
  expect(f.api.episodeReadiness).not.toHaveBeenCalled()
})

it('keeps original task, publication path and history through failed refresh and disconnect, without cached permission', async () => {
  const f = fixture({ episodeStatus: vi.fn<EpisodeClient['episodeStatus']>(async () => ({ ok: true, value: delivered })) })
  fireEvent.click(screen.getByRole('button', { name: en.episodeHistory }))
  fireEvent.click(await screen.findByRole('button', { name: en.episodeSelect }))
  await screen.findByText('exports/original.mp4')
  vi.mocked(f.api.episodeStatus).mockRejectedValueOnce(new Error('transport lost'))
  fireEvent.click(screen.getByRole('button', { name: en.episodeRefresh }))
  await screen.findByText(en.episodeStatusFailed)
  expect(screen.getByText('exports/original.mp4')).toBeDefined()
  expect(screen.getByRole('button', { name: en.episodeSelect })).toBeDefined()
  act(() => { f.disconnect() })
  expect(screen.getByText('exports/original.mp4')).toBeDefined()
  expect(screen.getByText(en.episodeOffline)).toBeDefined()
  for (const button of screen.getAllByRole('button')) expect(button.hasAttribute('disabled')).toBe(true)
  expect(f.api.admitEpisode).not.toHaveBeenCalled()
})

it('retains uncertain identity and requires a new matching check before an explicit original retry', async () => {
  const f = fixture({ admitEpisode: vi.fn<EpisodeClient['admitEpisode']>(async () => ({ ok: false,
    error: new RemoteError('jubian-video-recovery/rejected', 'admission paused', {}) })) })
  fireEvent.click(screen.getByRole('button', { name: en.episodeCheck }))
  const submit = screen.getByRole('button', { name: en.episodeExport })
  await waitFor(() => { expect(submit.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(submit)
  const retry = await screen.findByRole('button', { name: en.episodeRetry })
  await waitFor(() => { expect(f.directory.state.getSnapshot().busy).toBe(false) })
  expect(retry.hasAttribute('disabled')).toBe(true)
  expect(f.directory.state.getSnapshot().target).toEqual(input)
  fireEvent.click(screen.getByRole('button', { name: en.episodeCheck }))
  await waitFor(() => { expect(retry.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(retry)
  await waitFor(() => { expect(f.api.admitEpisode).toHaveBeenCalledTimes(2) })
  expect(vi.mocked(f.api.admitEpisode).mock.calls.map((args: Parameters<EpisodeClient['admitEpisode']>) => args[0])).toEqual([input, input])
})

it('does not enable an uncertain original retry from a newly checked different digest', async () => {
  const f = fixture()
  fireEvent.click(screen.getByRole('button', { name: en.episodeCheck }))
  const submit = screen.getByRole('button', { name: en.episodeExport })
  await waitFor(() => { expect(submit.hasAttribute('disabled')).toBe(false) }); fireEvent.click(submit)
  await waitFor(() => { expect(f.directory.state.getSnapshot().busy).toBe(false) })
  vi.mocked(f.api.episodeReadiness).mockResolvedValueOnce({ ok: true,
    value: { ...ready, digest: brandString<typeof input.digest>('b'.repeat(64)) } })
  fireEvent.click(screen.getByRole('button', { name: en.episodeCheck }))
  await waitFor(() => { expect(f.api.episodeReadiness).toHaveBeenCalledTimes(2) })
  expect(screen.getByRole('button', { name: en.episodeRetry }).hasAttribute('disabled')).toBe(true)
  await act(async () => { await f.directory.admit() })
  expect(f.api.admitEpisode).toHaveBeenCalledTimes(1)
})

it('keeps cached history visible after reconnect but requires explicit fresh discovery before selection', async () => {
  const f = fixture()
  fireEvent.click(screen.getByRole('button', { name: en.episodeHistory }))
  const choose = await screen.findByRole('button', { name: en.episodeSelect })
  expect(choose.hasAttribute('disabled')).toBe(false)
  act(() => { f.disconnect() })
  expect(screen.getByRole('button', { name: en.episodeSelect }).hasAttribute('disabled')).toBe(true)
  act(() => { f.connect() })
  expect(screen.getByRole('button', { name: en.episodeSelect }).hasAttribute('disabled')).toBe(true)
  expect(f.api.episodeHistory).toHaveBeenCalledTimes(1)
  expect(f.api.episodeStatus).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.episodeHistory }))
  await waitFor(() => { expect(screen.getByRole('button', { name: en.episodeSelect }).hasAttribute('disabled')).toBe(false) })
  expect(f.api.episodeHistory).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: en.episodeSelect }))
  await waitFor(() => { expect(f.api.episodeStatus).toHaveBeenCalledWith(input) })
})

it('keeps actions disabled when the edited project differs from the accepted recovery project', () => {
  const f = fixture()
  act(() => { f.recovery.state.update((state) => { state.projectDir = '/another-project' }) })
  for (const label of [en.episodeCheck, en.episodeHistory, en.episodeExport, en.episodeRefresh]) {
    const button = screen.getByRole('button', { name: label })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
  }
  expect(f.api.episodeReadiness).not.toHaveBeenCalled()
  expect(f.api.episodeHistory).not.toHaveBeenCalled()
  expect(f.api.admitEpisode).not.toHaveBeenCalled()
  act(() => { f.recovery.state.update((state) => { state.status = null }) })
  expect(screen.getByRole('button', { name: en.episodeCheck }).hasAttribute('disabled')).toBe(true)
})

it('shows source issues from a blocked readiness check without enabling export', async () => {
  const issue = 'A source video is missing.'
  const f = fixture({ episodeReadiness: vi.fn<EpisodeClient['episodeReadiness']>(async () => ({ ok: true,
    value: { ...ready, ready: false, digest: null, shots: 0, issues: [issue] } })) })
  fireEvent.click(screen.getByRole('button', { name: en.episodeCheck }))
  await screen.findByText(en.episodeBlocked)
  expect(screen.getByText(issue)).toBeTruthy()
  expect(screen.getByRole('button', { name: en.episodeExport }).hasAttribute('disabled')).toBe(true)
  expect(f.api.admitEpisode).not.toHaveBeenCalled()
})

it('shows a loading check and an explicit failure without treating the missing result as permission', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<EpisodeClient['episodeReadiness']>>>()
  const f = fixture({ episodeReadiness: vi.fn<EpisodeClient['episodeReadiness']>(() => pending.promise) })
  fireEvent.click(screen.getByRole('button', { name: en.episodeCheck }))
  await waitFor(() => { expect(screen.getByRole('region', { name: en.episodeTitle }).getAttribute('aria-busy')).toBe('true') })
  await act(async () => { pending.reject(Error('Readiness unavailable')) })
  await screen.findByText(en.episodeCheckFailed)
  expect(screen.getByRole('button', { name: en.episodeExport }).hasAttribute('disabled')).toBe(true)
  expect(f.api.admitEpisode).not.toHaveBeenCalled()
})

it('reports empty, truncated and unreadable history without inventing a selectable original', async () => {
  const f = fixture({ episodeHistory: vi.fn<EpisodeClient['episodeHistory']>(async () => ({ ok: true,
    value: { projectDir: input.projectDir, episode: input.episode, entries: [],
      truncated: true, unreadableRecords: 2, scannedEntries: 2 } })) })
  fireEvent.click(screen.getByRole('button', { name: en.episodeHistory }))
  await screen.findByText(en.episodeHistoryEmpty)
  expect(screen.getByText(en.episodeHistoryTruncated)).toBeTruthy()
  expect(screen.getByText(makeTranslate(en)('episodeHistoryUnreadable', { count: 2 }))).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.episodeSelect })).toBeNull()
  expect(f.api.episodeStatus).not.toHaveBeenCalled()
})

it('shows a discovery failure without selecting an earlier record', async () => {
  const f = fixture({ episodeHistory: vi.fn<EpisodeClient['episodeHistory']>(async () => { throw Error('History unavailable') }) })
  fireEvent.click(screen.getByRole('button', { name: en.episodeHistory }))
  await screen.findByText(en.episodeHistoryFailed)
  expect(screen.queryByRole('button', { name: en.episodeSelect })).toBeNull()
  expect(f.api.episodeStatus).not.toHaveBeenCalled()
})

it('distinguishes an unrecorded historical state and displays the selected original failure', async () => {
  const f = fixture({ episodeHistory: vi.fn<EpisodeClient['episodeHistory']>(async () => ({ ok: true,
    value: { projectDir: input.projectDir, episode: input.episode,
      entries: [{ attempt, digest: input.digest, recordedState: null }], truncated: false, unreadableRecords: 0, scannedEntries: 1 } })),
  episodeStatus: vi.fn<EpisodeClient['episodeStatus']>(async () => ({ ok: true,
    value: { ...original, state: 'failed', problem: 'The original encoder exited.' } })) })
  fireEvent.click(screen.getByRole('button', { name: en.episodeHistory }))
  await screen.findByText(en.episodeRecordedUnknown)
  fireEvent.click(screen.getByRole('button', { name: en.episodeSelect }))
  await screen.findByText('The original encoder exited.')
  expect(screen.getByRole('status').textContent).toBe(en.episodeFailed)
  expect(f.api.admitEpisode).not.toHaveBeenCalled()
})
