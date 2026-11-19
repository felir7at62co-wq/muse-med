// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { observeEditor } from '../src/client/editor-conversation.ts'

it('accepts only public project and ownership fields from its own editor frame', () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const select = vi.fn()
  const origin = 'http://127.0.0.1:19843'
  const stop = observeEditor(frame, origin, select)
  const message = (source: Window | null, from: string, data: object) =>
    window.dispatchEvent(new MessageEvent('message', { data, source, origin: from }))
  const project = { id: 'test', name: 'Cut', starters: [{ label: 'Dialogue', prompt: 'Tighten pauses', private: 'discarded' }], owner: { id: 'view', epoch: 2, private: 'discarded' } }
  const valid = { type: 'openchatcut:project', project }
  try {
    message(window, origin, valid)
    message(frame.contentWindow, 'https://other.test', valid)
    message(frame.contentWindow, origin, { type: 'prompt', text: 'send' })
    expect(select.mock.calls).toEqual([[null]])
    message(frame.contentWindow, origin, valid)
    expect(select).toHaveBeenLastCalledWith({ id: 'test', name: 'Cut', owner: { id: 'view', epoch: 2 }, starters: [{ label: 'Dialogue', prompt: 'Tighten pauses' }], shortcuts: [] })
    message(frame.contentWindow, origin, { ...valid, project: { ...project, owner: null } })
    expect(select).toHaveBeenLastCalledWith({ id: 'test', name: 'Cut', owner: null, starters: [{ label: 'Dialogue', prompt: 'Tighten pauses' }], shortcuts: [] })
  } finally { stop(); frame.remove() }
  message(null, origin, valid)
  expect(select).toHaveBeenCalledTimes(3)
})
