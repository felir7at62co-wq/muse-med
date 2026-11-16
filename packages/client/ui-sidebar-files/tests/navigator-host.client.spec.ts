// @vitest-environment jsdom
/** Navigator covering rules belong only to parents with a drawn navigator. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import type { PaneId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { mountNavigator, PANE, SESSION } from './mount.client.tsx'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

const MARKER = 'data-files-navigator-host'
const OTHER_PANE = 'pane-2' as PaneId

afterEach(cleanup)

/** Draw real DOM registrations through the face, without opening directory watches. */
function mountHosts() {
  const { face } = mountNavigator(sessionFileAddress(SESSION, 'src/a.ts'))
  const root = document.createElement('div')
  document.body.append(root)
  onTestFinished(() => {
    act(() => {
      face.navigatorDrawn(PANE, null, false)
      face.navigatorDrawn(OTHER_PANE, null, false)
    })
    root.remove()
  })
  const parent = (): HTMLDivElement => {
    const element = document.createElement('div')
    root.append(element)
    return element
  }
  const draw = (host: HTMLElement, pane = PANE, mode = 'fill'): HTMLElement => {
    const navigator = document.createElement('aside')
    navigator.className = `navigator ${mode}`
    host.append(navigator)
    act(() => { face.navigatorDrawn(pane, navigator, false) })
    return navigator
  }
  const remove = (pane = PANE): void => { act(() => { face.navigatorDrawn(pane, null, false) }) }
  return { root, parent, draw, remove, face }
}

describe('navigator host ownership', () => {
  it('marks the direct parent, including a slot wrapper without a layout box', () => {
    const h = mountHosts()
    const row = h.parent()
    const wrapper = document.createElement('div')
    wrapper.style.display = 'contents'
    row.append(wrapper)
    h.draw(wrapper)
    expect(wrapper.hasAttribute(MARKER)).toBe(true)
    expect(row.hasAttribute(MARKER)).toBe(false)
    expect(h.root.hasAttribute(MARKER)).toBe(false)
    h.remove()
    expect(wrapper.hasAttribute(MARKER)).toBe(false)
  })

  it('releases a replaced drawing and removes its final host marker', () => {
    const h = mountHosts()
    const first = h.parent()
    const second = h.parent()
    h.draw(first)
    h.draw(second)
    expect(first.hasAttribute(MARKER)).toBe(false)
    expect(second.hasAttribute(MARKER)).toBe(true)
    h.remove()
    expect(second.hasAttribute(MARKER)).toBe(false)
  })

  it('keeps a shared parent marked until its last navigator leaves', () => {
    const h = mountHosts()
    const parent = h.parent()
    h.draw(parent)
    h.draw(parent, OTHER_PANE)
    h.remove()
    expect(parent.hasAttribute(MARKER)).toBe(true)
    h.remove(OTHER_PANE)
    expect(parent.hasAttribute(MARKER)).toBe(false)
    // The next drawing captures the parent's current attribute, not a stale record.
    parent.setAttribute(MARKER, 'host-owned')
    h.draw(parent)
    h.remove()
    expect(parent.getAttribute(MARKER)).toBe('host-owned')
  })

  it.each(['', 'host-owned'])('preserves an existing host attribute %j', (value) => {
    const h = mountHosts()
    const parent = h.parent()
    parent.setAttribute(MARKER, value)
    h.draw(parent)
    expect(parent.getAttribute(MARKER)).toBe(value)
    h.remove()
    expect(parent.getAttribute(MARKER)).toBe(value)
  })

  it('releases a direct-parent marker even when no ancestor generates a layout box', () => {
    const h = mountHosts()
    const parent = document.createElement('div')
    parent.style.display = 'contents'
    h.draw(parent)
    expect(parent.hasAttribute(MARKER)).toBe(true)
    h.remove()
    expect(parent.hasAttribute(MARKER)).toBe(false)
  })

  it.each(['fill', 'overlay', 'wholePage'])('limits %s covering selectors to registered direct parents', (mode) => {
    const h = mountHosts()
    const owned = h.parent()
    const content = document.createElement('article')
    owned.append(content)
    const navigator = h.draw(owned, PANE, mode)
    const unrelated = h.parent()
    const unrelatedContent = document.createElement('article')
    const unrelatedNavigator = document.createElement('aside')
    unrelatedNavigator.className = navigator.className
    unrelated.append(unrelatedContent, unrelatedNavigator)
    const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/FilesBody.module.css'), 'utf8')
    // CSS Modules only localizes class names; unwrap its global marker before
    // exercising both source selectors against the same concrete DOM shape.
    const covering = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(match => /(?:^|;)\s*visibility:\s*hidden\s*(?:;|$)/.test(match[2]!))
      .map(match => match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/:global\(([^)]+)\)/g, '$1'))
    expect(covering).toHaveLength(2)
    for (const [index, selector] of covering.entries()) {
      const covered = [...h.root.querySelectorAll(selector)]
      expect(covered).not.toContain(unrelatedContent)
      expect(covered).not.toContain(navigator)
      expect(covered.includes(content)).toBe(mode === 'fill' || (index === 1 && mode === 'overlay'))
    }
    h.remove()
    for (const selector of covering) expect(h.root.querySelectorAll(selector)).toHaveLength(0)
  })
})
