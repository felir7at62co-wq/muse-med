// @vitest-environment jsdom
/** Session video menu uses supported pairs and leaves the dialogue model alone. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { VideoModelSelect, type VideoModelSelectProps } from '../src/client/VideoModelSelect.tsx'
import type { VideoDirectoryState } from '../src/client/video-directory.ts'
import { en } from '../src/client/locales.ts'

const options = ['480p', '720p'].map(resolution => ({ key: `1:${resolution}`, standardId: 1, modelId: 'seedance-25',
  modelName: 'Seedance 2.5', platformId: 'CHANNEL', resolution, genTypes: [3], ratios: ['9:16'], maxDurationSeconds: 30 }))
afterEach(cleanup)
function fixture(empty = false) {
  const store = createSnapshotStore<VideoDirectoryState>({ current: empty ? null : { ...options[0]!, revision: 1 }, defaultModel: null,
    options: empty ? [] : options,
    loading: false, selecting: false, error: null })
  const load = vi.fn(async () => {})
  const select = vi.fn(async () => {})
  const props = { t: (key: keyof typeof en) => en[key], load, select,
    useVideoState: (selector: (state: VideoDirectoryState) => unknown) => useSyncExternalStore(
      listener => store.subscribe(listener), () => selector(store.getSnapshot())),
  } as VideoModelSelectProps
  render(<VideoModelSelect {...props} />)
  return { store, load, select }
}
it('opens separate model and resolution rows and changes an exact supported option', async () => {
  const f = fixture()
  fireEvent.click(screen.getByRole('button', { name: 'Video model' }))
  expect(f.load).toHaveBeenCalledOnce()
  fireEvent.click(await screen.findByRole('menuitem', { name: /Resolution.*480p/ }))
  fireEvent.click(await screen.findByText('720p'))
  expect(f.select).toHaveBeenCalledWith('1:720p')
  await waitFor(() =>{  expect(screen.queryByRole('menu')).toBeNull() })
})
it('dismisses the portalled menu with Escape and outside clicks', async () => {
  fixture()
  const button = screen.getByRole('button', { name: 'Video model' })
  fireEvent.click(button)
  expect(await screen.findByRole('menu')).toBeDefined()
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() =>{  expect(screen.queryByRole('menu')).toBeNull() })
  fireEvent.click(button)
  expect(await screen.findByRole('menu')).toBeDefined()
  fireEvent.pointerDown(document.body)
  await waitFor(() =>{  expect(screen.queryByRole('menu')).toBeNull() })
})
it('does not submit the model group while the first catalogue is loading', async () => {
  const f = fixture(true)
  fireEvent.click(screen.getByRole('button', { name: 'Video model' }))
  const group = await screen.findByRole('menuitem', { name: new RegExp(`Model.*${en.videoUnset}`) })
  fireEvent.click(group)
  expect(f.select).not.toHaveBeenCalled()
  act(() => { f.store.update((state) => { state.options = options }) })
  fireEvent.click(group)
  fireEvent.click(await screen.findByText('Seedance 2.5'))
  expect(f.select).toHaveBeenCalledWith('1:480p')
})
it('keeps a supported resolution when choosing another model family', async () => {
  const f = fixture()
  act(() => { f.store.update((state) => {
    state.current = { ...options[1]!, revision: 2 }
    state.options = [...options, ...options.map(option => ({ ...option, key: `2:${option.resolution}`,
      standardId: 2, modelName: 'Another model' }))]
  }) })
  fireEvent.click(screen.getByRole('button', { name: 'Video model' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: /Model.*Seedance 2.5/ }))
  fireEvent.click(await screen.findByText('Another model'))
  expect(f.select).toHaveBeenCalledWith('2:720p')
})

it('uses one opaque scrolling panel, returns with ArrowLeft and closes with Escape', async () => {
  fixture()
  fireEvent.click(screen.getByRole('button', { name: 'Video model' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: /Model.*Seedance 2.5/ }))
  expect(screen.getAllByRole('menu')).toHaveLength(1)
  expect(screen.getByRole('menu').getAttribute('data-menu-material')).toBe('opaque')
  expect(await screen.findByText('CHANNEL')).toBeDefined()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Video model' }), { key: 'ArrowLeft' })
  expect(await screen.findByRole('menuitem', { name: /Resolution.*480p/ })).toBeDefined()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Video model' }), { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
})

it('keeps cached menu content and the composer free of loading indicators during refresh', async () => {
  const f = fixture()
  fireEvent.click(screen.getByRole('button', { name: 'Video model' }))
  const visible = () => ({
    trigger: screen.getByRole('button', { name: 'Video model' }).textContent,
    rows: screen.getAllByRole('menuitem').map(row => row.textContent),
    loadingIndicators: screen.queryAllByRole('status').length,
  })
  const before = visible()
  act(() => { f.store.update((state) => { state.loading = true }) })
  expect(visible()).toEqual(before)
  expect(visible()).toMatchSnapshot('cached video menu while refreshing')
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: 'Video model' }))
  expect(visible()).toEqual(before)
})

it('keeps the first catalogue loading indicator inside the open menu', async () => {
  const f = fixture(true)
  act(() => { f.store.update((state) => { state.loading = true }) })
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Video model' }))
  expect(screen.getByRole('status').closest('[role="menu"]')).toBe(screen.getByRole('menu'))
  act(() => { f.store.update((state) => { state.options = options; state.loading = false }) })
  expect(screen.queryByRole('status')).toBeNull()
})

it('shows the configured default for an unset session without replacing an existing explicit choice', () => {
  const f = fixture(true)
  act(() => { f.store.update((state) => { state.defaultModel = {
    modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', resolution: '480p',
  } }) })
  const trigger = screen.getByRole('button', { name: 'Video model' })
  expect(trigger.textContent).toContain('Seedance 2.5')
  expect(trigger.textContent).toContain('480p')
  act(() => { f.store.update((state) => { state.current = { ...options[1]!, modelName: 'Saved model', revision: 3 } }) })
  expect(trigger.textContent).toContain('Saved model')
  expect(trigger.textContent).toContain('720p')
  expect(f.select).not.toHaveBeenCalled()
})

it('keeps resume diagnostics inside the menu with a retry and optional details, and removes them after recovery', async () => {
  const f = fixture()
  const diagnostic = 'resume failed: audio-transcribe waiting for museAccount '.repeat(20)
  act(() => { f.store.update((state) => { state.error = diagnostic }) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText(diagnostic)).toBeNull()
  expect(screen.getByRole('img', { name: en.videoUnavailable })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Video model' }))
  expect(screen.getByRole('alert').textContent).toBe(en.videoUnavailable)
  expect(screen.getByRole('alert').closest('[role="menu"]')).toBe(screen.getByRole('menu'))
  expect(screen.queryByText(diagnostic)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(f.load).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Error details' }))
  expect(screen.getByText(diagnostic.trim()).tagName).toBe('PRE')
  expect({ trigger: screen.getByRole('button', { name: 'Video model' }).textContent,
    summary: screen.getByRole('alert').textContent, retry: screen.getByRole('button', { name: 'Retry' }).textContent,
    detailsExpanded: screen.getByRole('button', { name: 'Error details' }).getAttribute('aria-expanded'),
  }).toMatchSnapshot('recoverable video settings error')
  act(() => { f.store.update((state) => { state.error = null }) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('img', { name: en.videoUnavailable })).toBeNull()
  expect(screen.queryByText(diagnostic.trim())).toBeNull()
})
