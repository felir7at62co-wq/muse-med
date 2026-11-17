// @vitest-environment jsdom
/** Document drag listeners act only for a mounted composer that owns the drag target. */
import { afterEach, expect, it, vi } from 'vitest'
import { installDocumentDropEvents } from '../src/client/drop-events.ts'

afterEach(() => { document.body.innerHTML = '' })

function fileDrag(target: EventTarget): Event {
  const event = new Event('dragenter', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'] } })
  target.dispatchEvent(event)
  return event
}

function install(owner: { readonly current: HTMLElement | null }) {
  const setDragActive = vi.fn()
  const dispose = installDocumentDropEvents(true, vi.fn(), { current: 0 }, setDragActive, () => undefined, undefined, owner)
  return { setDragActive, dispose }
}

it('ignores file drags while no composer marker is mounted', () => {
  const { setDragActive, dispose } = install({ current: null })
  const event = fileDrag(document)
  expect(event.defaultPrevented).toBe(false)
  expect(setDragActive).not.toHaveBeenCalled()
  dispose()
})

it('accepts a page-level file drag whose target is not an element when exactly one composer is mounted', () => {
  const marker = document.createElement('div')
  marker.setAttribute('data-attachment-drop-owner', '')
  document.body.append(marker)
  const { setDragActive, dispose } = install({ current: marker })
  const event = fileDrag(document)
  expect(event.defaultPrevented).toBe(true)
  expect(setDragActive).toHaveBeenCalledWith(true, false)
  dispose()
})
