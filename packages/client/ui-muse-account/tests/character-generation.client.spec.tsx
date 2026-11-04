// @vitest-environment jsdom
/** Candidate confirmation, operation ownership and media playback through the real components. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketCharacterGenerator } from '../src/client/MarketCharacterGenerator.tsx'
import { MarketAnimation } from '../src/client/MarketAnimation.tsx'
import { settleCharacterJob, type CharacterBrief, type CharacterCandidate, type CharacterJob, type CharacterGenerationActions,
  type CharacterJobId, type CharacterCandidateId, type CharacterVersionId } from '../src/client/market-character-generation.ts'
import { directorAnimation } from './character-generation-fixture.client.ts'
import { marketZh, marketEn, type MarketLocaleKey } from '../src/client/market-locales.ts'
import { resolve } from 'node:path'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const brief = { title: 'Director', description: 'Plan shots', role: 'Storyboard director', introduction: 'I plan shots' }
const candidate: CharacterCandidate = { ...brief, id: 'portrait-one' as CharacterCandidateId, posterUrl: '/portrait.png' }
const portraits: CharacterJob = { id: 'job-one' as CharacterJobId, kind: 'portraits', status: 'succeeded', candidates: [candidate] }
const animated: CharacterJob = { id: 'job-two' as CharacterJobId, kind: 'animation', status: 'succeeded',
  version: { id: 'revision-one' as CharacterVersionId, candidate, animation: directorAnimation } }
function harness() {
  const actions = { mode: 'preview', pollIntervalMs: 50, timeoutMs: 5000,
    startPortraits: vi.fn(async (_brief: CharacterBrief, _signal: AbortSignal): Promise<CharacterJob> => portraits),
    startAnimation: vi.fn(async (_candidate: CharacterCandidate, _signal: AbortSignal): Promise<CharacterJob> => animated),
    readJob: vi.fn(async (_id: CharacterJobId, _signal: AbortSignal): Promise<CharacterJob> => portraits),
  } satisfies CharacterGenerationActions
  const props = { brief, actions, onApply: vi.fn(),
    reportOutcome: vi.fn<(key: MarketLocaleKey, failed: boolean) => void>(), t: (key: string) => key }
  return { actions, props }
}
async function selectPortrait() {
  fireEvent.click(screen.getByRole('button', { name: 'characterGenerate' }))
  fireEvent.click(await screen.findByRole('radio'))
}

it('leaves generation unavailable without an adapter', () => {
  const h = harness(); render(<MarketCharacterGenerator {...h.props} actions={undefined} />)
  expect(screen.getByText('characterUnavailable')).toBeDefined()
  expect(screen.getByRole('button', { name: 'characterGenerate' }).hasAttribute('disabled')).toBe(true)
  expect(h.actions.startPortraits).not.toHaveBeenCalled()
})

it('requires explicit portrait confirmation, animation and local application', async () => {
  const h = harness(); const view = render(<MarketCharacterGenerator {...h.props} />)
  expect(h.actions.startPortraits).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'characterGenerate' }))
  const radio = await screen.findByRole('radio')
  expect(h.actions.startAnimation).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'characterAnimate' })).toBeNull()
  fireEvent.click(radio)
  view.rerender(<MarketCharacterGenerator {...h.props} brief={{ ...brief, role: 'New role' }} />)
  fireEvent.click(screen.getByRole('button', { name: 'characterAnimate' }))
  const apply = await screen.findByRole('button', { name: 'characterApply' })
  expect(h.actions.startAnimation).toHaveBeenCalledWith(candidate, expect.any(AbortSignal))
  expect(h.props.onApply).not.toHaveBeenCalled()
  fireEvent.click(apply)
  expect(h.props.onApply).toHaveBeenCalledWith(animated.status === 'succeeded' && animated.kind === 'animation' ? animated.version : undefined)
  expect(h.props.reportOutcome).toHaveBeenLastCalledWith('characterApplied', false)
})

it('retains selected and completed media after a failed regeneration and retries explicitly', async () => {
  const h = harness(); render(<MarketCharacterGenerator {...h.props} />)
  await selectPortrait(); fireEvent.click(screen.getByRole('button', { name: 'characterAnimate' }))
  fireEvent.click(await screen.findByRole('button', { name: 'characterApply' }))
  h.actions.startPortraits.mockRejectedValueOnce(Error('private upstream request and key'))
  fireEvent.click(screen.getByRole('button', { name: 'characterRegenerate' }))
  await screen.findByText('characterFailureRetained')
  expect(screen.getByRole('radio')).toHaveProperty('checked', true)
  expect(screen.getByRole('button', { name: 'characterApply' })).toBeDefined()
  expect(h.props.onApply).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('private upstream request and key')).toBeNull()
  expect(h.props.reportOutcome).toHaveBeenLastCalledWith('characterFailed', true)
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  await waitFor(() => { expect(screen.queryByText('characterFailureRetained')).toBeNull() })
  expect(h.actions.startPortraits).toHaveBeenCalledTimes(3)
  expect(screen.getByRole('radio')).toHaveProperty('checked', false)
})

it('stops waiting without adopting a late response or claiming remote cancellation', async () => {
  const h = harness(), deferred = Promise.withResolvers<CharacterJob>()
  h.actions.startPortraits.mockReturnValue(deferred.promise)
  render(<MarketCharacterGenerator {...h.props} />)
  fireEvent.click(screen.getByRole('button', { name: 'characterGenerate' }))
  const signal = h.actions.startPortraits.mock.calls[0]![1]
  fireEvent.click(screen.getByRole('button', { name: 'characterStop' }))
  expect(signal.aborted).toBe(true)
  expect(screen.getByText('characterStopped')).toBeDefined()
  await act(async () => { deferred.resolve(portraits) })
  expect(screen.queryByRole('radio')).toBeNull()
  expect(h.props.reportOutcome).not.toHaveBeenCalled()
})

it('aborts an old adapter and ignores its completion after switching providers', async () => {
  const h = harness(), other = harness(), deferred = Promise.withResolvers<CharacterJob>()
  h.actions.startPortraits.mockReturnValue(deferred.promise)
  const view = render(<MarketCharacterGenerator {...h.props} />)
  fireEvent.click(screen.getByRole('button', { name: 'characterGenerate' }))
  view.rerender(<MarketCharacterGenerator {...other.props} />)
  await act(async () => { deferred.resolve(portraits) })
  expect(screen.queryByRole('radio')).toBeNull()
  expect(h.props.reportOutcome).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'characterGenerate' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'characterGenerate' }))
  await screen.findByRole('radio')
  expect(other.actions.startPortraits).toHaveBeenCalledTimes(1)
})

it('bounds waiting even if a provider does not settle on abort', async () => {
  vi.useFakeTimers()
  const h = harness(), deferred = Promise.withResolvers<CharacterJob>()
  h.actions.startPortraits.mockReturnValue(deferred.promise)
  render(<MarketCharacterGenerator {...h.props} />)
  fireEvent.click(screen.getByRole('button', { name: 'characterGenerate' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(h.actions.timeoutMs) })
  expect(screen.getByText('characterFailureRetained')).toBeDefined()
  expect(h.props.reportOutcome).toHaveBeenLastCalledWith('characterFailed', true)
  await act(async () => { deferred.resolve(portraits) })
  expect(screen.queryByRole('radio')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('polls queued and running tasks, then releases the polling timer on abort', async () => {
  vi.useFakeTimers()
  const h = harness(), controller = new AbortController(), progress = vi.fn<(job: CharacterJob) => void>()
  h.actions.readJob.mockResolvedValueOnce({ id: portraits.id, kind: 'portraits', status: 'running' })
  const task = settleCharacterJob(h.actions, { id: portraits.id, kind: 'portraits', status: 'queued' }, controller.signal, progress)
  await vi.advanceTimersByTimeAsync(100)
  expect(await task).toEqual(portraits)
  expect(progress.mock.calls.map(([job]) => job.status)).toEqual(['queued', 'running', 'succeeded'])
  const cancelled = settleCharacterJob(h.actions, { id: portraits.id, kind: 'portraits', status: 'queued' }, controller.signal, progress)
  const rejection = expect(cancelled).rejects.toBeDefined()
  controller.abort(); await rejection
  expect(vi.getTimerCount()).toBe(0)
})

it('plays only visible media, switches to introduction frames, and respects reduced motion and errors', async () => {
  vi.useFakeTimers()
  const motion = Object.assign(new EventTarget(), { matches: false })
  vi.stubGlobal('matchMedia', vi.fn(() => motion))
  let hidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  let visible: (value: boolean) => void = () => {}
  const disconnect = vi.fn(), observe = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      visible = (value) => { callback([{ isIntersecting: value }]) }
    }
    observe = observe
    disconnect = disconnect
  })
  const props = { animation: directorAnimation, introducing: false, label: 'Director', fallback: <img src="/poster.png" alt="Static director" />, framing: undefined }
  const view = render(<MarketAnimation {...props} />)
  const sprite = view.container.querySelector('image')!
  fireEvent.load(sprite)
  expect(screen.getByRole('img', { name: 'Static director' })).toBeDefined()
  act(() => { visible(true) })
  expect(sprite.closest('span')?.hidden).toBe(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(3500) })
  expect(sprite.getAttribute('x')).toBe('-627')
  view.rerender(<MarketAnimation {...props} introducing />)
  expect(sprite.closest('span')?.hidden).toBe(false)
  expect(screen.queryByRole('img', { name: 'Static director' })).toBeNull()
  expect(view.container.querySelector('image')).toBe(sprite)
  expect(observe).toHaveBeenCalledTimes(1)
  expect(disconnect).not.toHaveBeenCalled()
  expect(sprite.getAttribute('y')).toBe('-627')
  for (const introducing of [false, true, false, true]) {
    view.rerender(<MarketAnimation {...props} introducing={introducing} />)
    expect(sprite.closest('span')?.hidden).toBe(false)
    expect(sprite.getAttribute('x')).toBe('0')
    expect(sprite.getAttribute('y')).toBe(introducing ? '-627' : '0')
    expect(screen.queryByRole('img', { name: 'Static director' })).toBeNull()
    expect(view.container.querySelector('image')).toBe(sprite)
  }
  expect(observe).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(1)
  act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')) })
  expect(vi.getTimerCount()).toBe(0)
  expect(screen.getByRole('img', { name: 'Static director' })).toBeDefined()
  act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')) })
  expect(sprite.closest('span')?.hidden).toBe(false)
  act(() => { visible(false) })
  expect(vi.getTimerCount()).toBe(0)
  act(() => { visible(true); motion.matches = true; motion.dispatchEvent(new Event('change')) })
  expect(screen.getByRole('img', { name: 'Static director' })).toBeDefined()
  expect(vi.getTimerCount()).toBe(0)
  act(() => { motion.matches = false; motion.dispatchEvent(new Event('change')) })
  fireEvent.error(sprite)
  expect(screen.getByRole('img', { name: 'Static director' })).toBeDefined()
  expect(vi.getTimerCount()).toBe(0)
  view.unmount(); expect(disconnect).toHaveBeenCalled()
})

it('records localized failure and recovery output without upstream details', async () => {
  const output = []
  for (const copy of [marketZh, marketEn]) {
    const h = harness()
    h.actions.startPortraits.mockResolvedValue({ id: portraits.id, kind: 'portraits', status: 'failed' })
    render(<MarketCharacterGenerator {...h.props} t={key => Object.hasOwn(copy, key) ? copy[key as MarketLocaleKey] : key} />)
    fireEvent.click(screen.getByRole('button', { name: copy.characterGenerate }))
    await screen.findByText(copy.characterFailureRetained)
    output.push({ title: screen.getByRole('heading').textContent, mode: screen.getByText(copy.characterDemo).textContent,
      failure: screen.getByText(copy.characterFailureRetained).textContent,
      actions: screen.getAllByRole('button').map(button => button.textContent),
      outcome: h.props.reportOutcome.mock.calls.map(([key, failed]) => ({ text: copy[key], failed })) })
    cleanup()
  }
  await expect(`${JSON.stringify(output, null, 2)}\n`).toMatchFileSnapshot(resolve('packages/client/ui-muse-account/tests/expected/character-generation.txt'))
})

it('clips each sprite to its own source cell with independent IDs across portrait instances', () => {
  const wide = { ...directorAnimation, sheetUrl: '/wide-sheet.png', cellWidth: 400, cellHeight: 300 }
  const view = render(<>
    <MarketAnimation animation={directorAnimation} introducing label="Director" fallback={<span />} framing={undefined} />
    <MarketAnimation animation={wide} introducing={false} label="Wide character" fallback={<span />} framing={undefined} />
  </>)
  const clips = [...view.container.querySelectorAll('clipPath')]
  expect(clips).toHaveLength(2)
  expect(clips[0]!.id).not.toBe(clips[1]!.id)
  for (const [index, animation] of [directorAnimation, wide].entries()) {
    const clip = clips[index]!, rectangle = clip.querySelector('rect')!
    expect(clip.getAttribute('clipPathUnits')).toBe('userSpaceOnUse')
    expect(rectangle.getAttribute('x')).toBe('0'); expect(rectangle.getAttribute('y')).toBe('0')
    expect(rectangle.getAttribute('width')).toBe(String(animation.cellWidth))
    expect(rectangle.getAttribute('height')).toBe(String(animation.cellHeight))
    const image = view.container.querySelectorAll('image')[index]!
    expect(image.parentElement?.getAttribute('clip-path')).toBe(`url(#${clip.id})`)
  }
})
