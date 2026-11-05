// @vitest-environment jsdom
/** Frame height messages must come from the receiving frame's own Window. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Frame } from '../src/client/VisualizeCard.tsx'
import { StreamingPreview } from '../src/client/StreamingPreview.tsx'
import { HEIGHT_MESSAGE_TYPE } from '../src/shell.ts'

let root: Root | undefined
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})
function mount(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(element))
  return container.querySelector('iframe')!
}
function report(source: MessageEventSource | null, token: string, height: number) {
  act(() => window.dispatchEvent(new MessageEvent('message', { source, data: { type: HEIGHT_MESSAGE_TYPE, token, height } })))
}
it('ignores matching tokens from other Windows for a settled card', () => {
  const frame = mount(<Frame meta={{ kind: 'visualize', title: 'Card', fragment: '<div>Card</div>', mode: 'inline', path: '', style: 'whale' }} callId="height-card" />)
  report(window, 'height-card', 700)
  expect(frame.style.height).toBe('48px')
  report(null, 'height-card', 700)
  expect(frame.style.height).toBe('48px')
  report(frame.contentWindow, 'other-token', 700)
  expect(frame.style.height).toBe('48px')
  report(frame.contentWindow, 'height-card', 321)
  expect(frame.style.height).toBe('321px')
})
it('ignores matching streaming tokens from sibling Windows', () => {
  const frame = mount(<StreamingPreview {...({ session: { partial: { blocks: [{ kind: 'tool-call', name: 'visualize', argsRaw: '{"fragment":"<div>preview</div>"}' }] } } } as never)} />)
  report(window, 'streaming-preview', 700)
  expect(frame.style.height).toBe('0px')
  report(frame.contentWindow, 'streaming-preview', 234)
  expect(frame.style.height).toBe('234px')
})
