// @vitest-environment jsdom
/** Explicit file actions preserve their destination, availability, and independent failure state. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { StrictMode } from 'react'
import type { MockInstance } from 'vitest'
import { PresentedFileCard } from '../src/client/PresentedFileCard.tsx'
import { en, zh } from '../src/client/locales.ts'

let pause: MockInstance<HTMLMediaElement['pause']>
let load: MockInstance<HTMLMediaElement['load']>
beforeEach(() => {
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const props = () => ({
  cwd: undefined,
  file: { path: 'out/report.pdf', description: 'Final report', seq: 4, index: 1 },
  host: { name: 'remote-desktop', available: true, fileManager: 'finder' as const },
  phase: undefined,
  onPreview: vi.fn(),
  actions: <button type="button">Native file action</button>,
  t: makeTranslate(en),
})
it('localizes reveal failures and accurately reports a directory-only action', () => {
  const p = props()
  const view = render(<PresentedFileCard {...p} phase="revealError" t={makeTranslate(zh)} />)
  expect(view.getByText(zh['presented.revealError'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealed" host={{ ...p.host, fileManager: 'directory' }} />)
  expect(view.getByText(en['presented.directoryOpened'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealed" />)
  expect(view.getByText(en['presented.revealed'])).toBeTruthy()
})


it('shows the basename while retaining the full location for hover and actions', () => {
  const p = props()
  const path = '/work/reports/result.pdf'
  const view = render(<PresentedFileCard {...p} cwd="/work" file={{ ...p.file, path }} />)
  expect(view.getByTitle(path)).toBeTruthy()
  expect(view.getByText('result.pdf')).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} cwd="/work" />)
  expect(view.getByTitle('/work/out/report.pdf')).toBeTruthy()
  expect(view.getByText('report.pdf')).toBeTruthy()
})

it.each([
  ['Quarterly summary (.pdf)', 'Quarterly summary'],
  ['季度总结（PDF）', '季度总结'],
] as const)('omits a trailing parenthesized file suffix from %s', (description, expected) => {
  const p = props()
  const view = render(<PresentedFileCard {...p} file={{ ...p.file, description }} />)
  expect(view.getByText(expected)).toBeTruthy()
  expect(view.queryByText(description)).toBeNull()
})


it.each([en, zh])('distinguishes directory-only progress and errors in each locale', (dictionary) => {
  const p = { ...props(), t: makeTranslate(dictionary) }
  const view = render(<PresentedFileCard {...p} phase="revealing" />)
  expect(view.getByText(dictionary['presented.revealing'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealing" host={{ ...p.host, fileManager: 'directory' }} />)
  expect(view.getByText(dictionary['presented.directoryOpening'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealError" host={{ ...p.host, fileManager: 'directory' }} />)
  expect(view.getByText(dictionary['presented.directoryError'])).toBeTruthy()
})


it('renders the supplied action independently from the card preview', () => {
  const p = props()
  const native = vi.fn()
  const view = render(<PresentedFileCard {...p} actions={<button type="button" onClick={native}>Native file action</button>} />)
  fireEvent.click(view.getByRole('button', { name: 'Native file action' }))
  expect(native).toHaveBeenCalledOnce()
  expect(p.onPreview).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Preview out/report.pdf in sidebar' }))
  expect(p.onPreview).toHaveBeenCalledOnce()
})

it('plays a delivered video inline with independent native controls and file actions', () => {
  const p = props()
  const source = 'http://localhost/api/video?sessionId=child&path=out%2Fepisode.mp4'
  const view = render(<PresentedFileCard {...p} file={{ ...p.file, path: 'out/episode.mp4', description: 'Final episode' }}
    videoSource={source} />)
  const player = view.getByLabelText('Play episode.mp4') as HTMLVideoElement
  expect(player.tagName).toBe('VIDEO')
  expect(player.src).toBe(source)
  expect(player.controls).toBe(true)
  expect(player.playsInline).toBe(true)
  expect(player.preload).toBe('metadata')
  expect(player.autoplay).toBe(false)
  expect(player.tabIndex).toBe(0)
  expect(player.closest('button')).toBeNull()
  fireEvent.click(player)
  fireEvent.keyDown(player, { key: 'ArrowRight' })
  expect(p.onPreview).not.toHaveBeenCalled()
  expect(view.container).toMatchSnapshot()
  fireEvent.click(view.getByRole('button', { name: 'Preview out/episode.mp4 in sidebar' }))
  expect(p.onPreview).toHaveBeenCalledOnce()
  view.unmount()
  expect(pause).toHaveBeenCalledOnce()
  expect(load).toHaveBeenCalledOnce()
  expect(player.hasAttribute('src')).toBe(false)
})

it.each([en, zh])('keeps file actions and a localized failure when the browser cannot play the video', (dictionary) => {
  const p = props()
  const view = render(<PresentedFileCard {...p} file={{ ...p.file, path: 'out/episode.mov' }}
    videoSource="http://localhost/api/video?path=episode.mov" t={makeTranslate(dictionary)} />)
  fireEvent.error(view.container.querySelector('video')!)
  expect(view.getByRole('alert').textContent).toBe(dictionary['presented.videoError'])
  expect(view.container.querySelector('video')).toBeNull()
  expect(pause).toHaveBeenCalledOnce()
  expect(view.getByRole('button', { name: 'Native file action' })).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: makeTranslate(dictionary)('presented.previewCard', { name: 'out/episode.mov' }) }))
  expect(p.onPreview).toHaveBeenCalledOnce()
  view.rerender(<PresentedFileCard {...p} file={{ ...p.file, path: 'out/revised.mp4' }}
    videoSource="http://localhost/api/video?path=revised.mp4" t={makeTranslate(dictionary)} />)
  expect(view.queryByRole('alert')).toBeNull()
  expect(view.container.querySelector('video')?.getAttribute('src')).toContain('revised.mp4')
})

it('leaves other delivery types as compact file cards', () => {
  const view = render(<PresentedFileCard {...props()} />)
  expect(view.container.querySelector('video')).toBeNull()
  expect(view.container.querySelector('[data-presented-file]')?.hasAttribute('data-video')).toBe(false)
})

it('retains the playable source through StrictMode effect replay and releases it on unmount', () => {
  const source = 'http://localhost/api/video?sessionId=child&path=clip.mp4'
  const view = render(<StrictMode><PresentedFileCard {...props()} videoSource={source} /></StrictMode>)
  const video = view.container.querySelector('video')!
  expect(pause).toHaveBeenCalledOnce()
  expect(video.getAttribute('src')).toBe(source)
  view.unmount()
  expect(pause).toHaveBeenCalledTimes(2)
  expect(load).toHaveBeenCalledTimes(2)
  expect(video.hasAttribute('src')).toBe(false)
})
