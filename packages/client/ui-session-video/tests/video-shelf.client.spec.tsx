// @vitest-environment jsdom
/** Shared Session selection, bounded detection and source-local regeneration through native slots. */
import { act,fireEvent,screen,waitFor } from '@testing-library/react'
import { expect,it,vi } from 'vitest'
import type { SessionVideoAnalysis,SessionVideoSource } from '@deepseek-ai/dsh-session-video'
import type { VideoInjected } from '../src/client/face.ts'
import { en } from '../src/client/locales.ts'
import { source,analysis,inventory,fixture } from './video-fixture.tsx'

it('opens one selected source, detects real shot ranges and appends a guarded regeneration draft without submitting', async () => {
  const { instance, detectShots, inputActions } = await fixture()
  const toggle = screen.getByRole('button', { name: en.library })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(detectShots).not.toHaveBeenCalled()
  fireEvent.click(toggle)
  const shot = await screen.findByRole('button', { name: /^Shot 1/u })
  expect(instance.getSnapshot().open).toBe(true)
  expect(screen.getByRole('button', { name: en.redo }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(shot)
  fireEvent.click(screen.getByRole('button', { name: en.redo }))
  expect(inputActions.insertText).toHaveBeenCalledWith(expect.stringContaining('original range: 0.000–4.000'),
    { start: 'Existing draft'.length, end: 'Existing draft'.length, draftRev: 7 })
  expect(inputActions.persistDraft).toHaveBeenCalledOnce()
  expect(detectShots).toHaveBeenCalledOnce()
})

it('switches source-local playback while preserving concatenated timeline ranges', async () => {
  const first = source(), second = source('second')
  const { instance } = await fixture([first, second])
  fireEvent.click(screen.getByRole('button', { name: en.library }))
  await screen.findByRole('button', { name: /^Shot 2/u })
  fireEvent.change(screen.getByRole('combobox', { name: en.library }), { target: { value: second.id } })
  expect(instance.getSnapshot().selected).toBe(second.id)
  expect(screen.getByLabelText(second.label)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /^Shot 1/u }))
  expect(instance.getSnapshot().selected).toBe(first.id)
  expect(screen.getByLabelText(first.label)).toBeTruthy()
})

it('cancels its inventory request while another conversation view is active and remounts on return', async () => {
  const { panel, reference, listVideos } = await fixture()
  const signal = listVideos.mock.calls[0]?.[1]
  panel.update({ activeView: 'trajectory' }, { session: reference })
  expect(panel.container.querySelector('[data-muse-video-shelf]')).toBeNull()
  expect(signal?.aborted).toBe(true)
  panel.update({ activeView: 'chat' }, { session: reference })
  await waitFor(() => { expect(listVideos).toHaveBeenCalledTimes(2) })
  expect(screen.getByRole('button', { name: en.library })).toBeTruthy()
})

it('shows an empty shelf and retains a retry after inventory failure', async () => {
  const { listVideos, panel, reference } = await fixture([])
  fireEvent.click(screen.getByRole('button', { name: en.library }))
  expect(await screen.findByText(en.empty)).toBeTruthy()
  panel.update({ activeView: null }, { session: reference })
  listVideos.mockRejectedValueOnce(Error('Inventory unavailable'))
  panel.update({ activeView: 'chat' }, { session: reference })
  await screen.findAllByText(en.unavailable)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await waitFor(() => { expect(screen.queryByText(en.unavailable)).toBeNull() })
  expect(screen.getByText(en.empty)).toBeTruthy()
})

it('aborts a superseded detection and keeps a refused draft edit from triggering persistence', async () => {
  const { detectShots, inputActions, panel, reference } = await fixture()
  const pending = Promise.withResolvers<SessionVideoAnalysis>()
  detectShots.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole('button', { name: en.library }))
  await waitFor(() => { expect(detectShots).toHaveBeenCalledOnce() })
  const signal = detectShots.mock.calls[0]?.[3]
  panel.update({ activeView: 'trajectory' }, { session: reference })
  expect(signal?.aborted).toBe(true)
  await act(async () => { pending.resolve(analysis(source())) })
  panel.update({ activeView: 'chat' }, { session: reference })
  await screen.findByRole('button', { name: /^Shot 1/u })
  vi.mocked(inputActions.insertText).mockReturnValue(false)
  fireEvent.click(screen.getByRole('button', { name: /^Shot 1/u }))
  fireEvent.click(screen.getByRole('button', { name: en.redo }))
  expect(inputActions.persistDraft).not.toHaveBeenCalled()
})

it.each(['rejected', 'failed-result'] as const)('retries an unverified detection after %s without resubmitting automatically', async (failure) => {
  const { detectShots, instance } = await fixture()
  if (failure === 'rejected') detectShots.mockRejectedValueOnce(Error('Detector unavailable'))
  else detectShots.mockResolvedValueOnce({ ...analysis(source()), state: 'failed', issue: 'detector-unavailable' })
  fireEvent.click(screen.getByRole('button', { name: en.library }))
  await screen.findByText(en.detectionFailed)
  expect(detectShots).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await screen.findByRole('button', { name: /^Shot 1/u })
  expect(detectShots).toHaveBeenCalledTimes(2)
  expect(instance.getSnapshot().analyses[source().id]?.state).toBe('ready')
})

it.each([true, false])('keeps a remote provider source playable when the optional local inventory refresh succeeds=%s', async (refresh) => {
  const remote: SessionVideoSource = { ...source(), status: 'remote-only', path: null,
    playbackUrl: 'https://media.example/video.mp4', remoteUrl: 'https://media.example/video.mp4' }
  const { listVideos, instance } = await fixture([remote])
  if (refresh) listVideos.mockResolvedValueOnce(inventory([source()]))
  else listVideos.mockRejectedValueOnce(Error('Local inventory unavailable'))
  fireEvent.click(screen.getByRole('button', { name: en.library }))
  await screen.findByRole('button', { name: /^Shot 1/u })
  expect(listVideos).toHaveBeenCalledTimes(2)
  expect(instance.getSnapshot().sources[0]?.status).toBe(refresh ? 'local' : 'remote-only')
  expect(screen.getByLabelText(remote.label).getAttribute('src')).toBe(refresh ? source().playbackUrl : remote.playbackUrl)
})

it('shows the unavailable source in place without starting a detector for missing media coordinates', async () => {
  const unavailable: SessionVideoSource = { ...source(), version: null, playbackUrl: null, status: 'missing' }
  const { detectShots } = await fixture([unavailable])
  fireEvent.click(screen.getByRole('button', { name: en.library }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en.unavailable)
  expect(detectShots).not.toHaveBeenCalled()
})

it.each([true, false])('keeps the new view inventory after an old request settles successfully=%s', async (success) => {
  const first = source(), second = source('second')
  const { instance, panel, reference, listVideos } = await fixture([first])
  await act(async () => { instance.actions.inventory(inventory([first], ['partial-read'])); instance.actions.toggle() })
  const old = Promise.withResolvers<Awaited<ReturnType<VideoInjected['listVideos']>>>()
  listVideos.mockReturnValueOnce(old.promise).mockResolvedValueOnce(inventory([second]))
  const calls = listVideos.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await waitFor(() => { expect(listVideos).toHaveBeenCalledTimes(calls + 1) })
  panel.update({ activeView: 'trajectory' }, { session: reference })
  panel.update({ activeView: 'chat' }, { session: reference })
  await waitFor(() => { expect(instance.getSnapshot().sources).toEqual([second]) })
  await act(async () => {
    if (success) old.resolve(inventory([first]))
    else old.reject(Error('Obsolete inventory failed'))
  })
  expect(instance.getSnapshot().sources).toEqual([second])
  expect(screen.queryByText(en.unavailable)).toBeNull()
})
