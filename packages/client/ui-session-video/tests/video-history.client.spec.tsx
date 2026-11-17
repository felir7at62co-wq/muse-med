// @vitest-environment jsdom
/** The Session header menu lists recorded videos and the chat flow shows the selected one. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore, type ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionVideoSource, SessionVideoSourceId } from '@deepseek-ai/dsh-session-video'
import { VideoHeader, VideoHistory } from '../src/client/VideoHistory.tsx'
import { createVideoStore, type VideoState } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

const { controller } = vi.hoisted(() => ({ controller: { onLoadError: undefined as undefined | ((value: boolean | null) => void) } }))
vi.mock('../src/client/VideoController.tsx', () => ({
  VideoController: (props: { onLoadError: (value: boolean | null) => void }) => { controller.onLoadError = props.onLoadError; return null },
}))
vi.mock('../src/client/InlineVideoCard.tsx', () => ({
  InlineVideoCard: (props: { label: string; sourceUrl: string }) => <div data-testid="card">{props.label}|{props.sourceUrl}</div>,
}))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function source(name: string, eventSeq: number, presentedIndex: number | null = null,
  playbackUrl: string | null = `/${name}`): SessionVideoSource {
  return { id: brandString<SessionVideoSourceId>(name), label: name, origin: 'generated', path: null, eventSeq,
    presentedIndex, callId: null, status: 'local', version: `${name}:v1`, playbackUrl, remoteUrl: null, issue: null }
}

function setup(sources: SessionVideoSource[], issues: string[] = []) {
  const handle = createVideoStore().create('session')
  handle.actions.inventory({ sessionId: SessionId('session'), sources, complete: true, issues })
  const useStore = <T,>(selector: (value: VideoState) => T): T =>
    useSyncExternalStore(listener => handle.store.subscribe(listener), () => selector(handle.store.getSnapshot()))
  const actions = { ...handle.actions, openSource: vi.fn((id: SessionVideoSourceId) => { handle.actions.openSource(id) }),
    refreshInventory: vi.fn(() => { handle.actions.refreshInventory() }) }
  const selectView = vi.fn()
  const props = { useStore, actions, selectView, t: makeTranslate(en) } as
    ComponentProps<typeof VideoHeader> & ComponentProps<typeof VideoHistory>
  return { handle, actions, selectView, props }
}

const openMenu = () => { fireEvent.click(screen.getByRole('button', { name: en.library })) }

it('lists videos newest first, with presentation order breaking ties, and disables sources without playback', () => {
  const h = setup([source('old', 1), source('tieLow', 2, 0), source('tieNone', 2), source('tieHigh', 2, 3), source('pending', 0, null, null)])
  render(<VideoHeader {...h.props} />)
  openMenu()
  const items = screen.getAllByRole('menuitem')
  expect(items.map(item => item.textContent)).toEqual(['tieHigh', 'tieLow', 'tieNone', 'old', 'pending'])
  expect(items.map(item => item.hasAttribute('disabled'))).toEqual([false, false, false, false, true])
})

it('selecting a video opens it, returns to the chat view and closes the menu', () => {
  const h = setup([source('a', 1)])
  render(<VideoHeader {...h.props} />)
  openMenu()
  expect(screen.getByRole('button', { name: en.library }).getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(screen.getByRole('menuitem', { name: 'a' }))
  expect(h.actions.openSource).toHaveBeenCalledWith('a')
  expect(h.selectView).toHaveBeenCalledWith('chat')
  expect(screen.queryByRole('menuitem')).toBeNull()
  expect(h.handle.store.getSnapshot()).toMatchObject({ selected: 'a', open: true })
})

it('shows loading until the controller reports a load result, then empty', () => {
  const h = setup([])
  render(<VideoHeader {...h.props} />)
  openMenu()
  expect(screen.getByRole('menuitem', { name: en.loading })).toBeTruthy()
  act(() => { controller.onLoadError?.(false) })
  expect(screen.getByRole('menuitem', { name: en.empty })).toBeTruthy()
})

it('offers a retry labelled unavailable after a load failure and refreshes the inventory', () => {
  const h = setup([])
  render(<VideoHeader {...h.props} />)
  act(() => { controller.onLoadError?.(true) })
  openMenu()
  expect(screen.queryByRole('menuitem', { name: en.empty })).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: `${en.unavailable} · ${en.retry}` }))
  expect(h.actions.refreshInventory).toHaveBeenCalledOnce()
})

it('offers an incomplete-inventory retry when the inventory reported issues', () => {
  const h = setup([source('a', 1)], ['broken'])
  render(<VideoHeader {...h.props} />)
  openMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: `${en.incomplete} · ${en.retry}` }))
  expect(h.actions.refreshInventory).toHaveBeenCalledOnce()
})

it('toggles the menu closed on a second trigger click', () => {
  const h = setup([source('a', 1)])
  render(<VideoHeader {...h.props} />)
  openMenu()
  openMenu()
  expect(screen.getByRole('button', { name: en.library }).getAttribute('aria-expanded')).toBe('false')
})

it('renders nothing in the chat flow while closed, unselected or without a playback URL', () => {
  const h = setup([source('a', 1), source('pending', 2, null, null)])
  const { container } = render(<VideoHistory {...h.props} />)
  expect(container.innerHTML).toBe('')
  act(() => { h.handle.actions.toggle() })
  expect(h.handle.store.getSnapshot()).toMatchObject({ selected: null, open: true })
  expect(container.innerHTML).toBe('')
  act(() => { h.handle.actions.openSource(brandString<SessionVideoSourceId>('pending')) })
  expect(container.innerHTML).toBe('')
  act(() => { h.handle.actions.openSource(brandString<SessionVideoSourceId>('a')); h.handle.actions.toggle() })
  expect(container.innerHTML).toBe('')
})

it('shows the selected video card with a close action that hides it', () => {
  const h = setup([source('a', 1)])
  act(() => { h.handle.actions.openSource(brandString<SessionVideoSourceId>('a')) })
  const { container } = render(<VideoHistory {...h.props} />)
  expect(screen.getByTestId('card').textContent).toBe('a|/a')
  fireEvent.click(screen.getByRole('button', { name: en.closeVideo }))
  expect(container.innerHTML).toBe('')
})

it('closes the menu on Escape', () => {
  const h = setup([source('a', 1)])
  render(<VideoHeader {...h.props} />)
  openMenu()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('menuitem')).toBeNull()
  expect(screen.getByRole('button', { name: en.library }).getAttribute('aria-expanded')).toBe('false')
})

it('keeps the menu showing the placeholder when the disabled loading row is activated', () => {
  const h = setup([])
  render(<VideoHeader {...h.props} />)
  openMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: en.loading }))
  expect(screen.getByRole('menuitem', { name: en.loading })).toBeTruthy()
  expect(h.actions.refreshInventory).not.toHaveBeenCalled()
})
