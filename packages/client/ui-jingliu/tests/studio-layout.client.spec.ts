// @vitest-environment jsdom
/** Studio documents keep their desktop layout inside a separately scrollable pane. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('fits the studio to its own pane while preserving horizontal access at minimum zoom', () => {
  const style = document.createElement('style')
  style.textContent = readFileSync(resolve(import.meta.dirname, '../src/client/Studio.module.css'), 'utf8')
  document.head.append(style)
  const viewport = document.createElement('div')
  viewport.className = 'viewport'
  const frame = document.createElement('iframe')
  frame.className = 'frame'
  viewport.append(frame)
  document.body.append(viewport)
  try {
    expect(getComputedStyle(viewport).getPropertyValue('container-type')).toBe('inline-size')
    expect(getComputedStyle(viewport).overflowX).toBe('auto')
    const rules = Array.from(style.sheet!.cssRules) as CSSStyleRule[]
    const frameStyle = rules.find(rule => rule.selectorText === '.frame')!.style
    expect(frameStyle.getPropertyValue('min-width')).toBe('var(--studio-layout-width)')
    expect(frameStyle.getPropertyValue('zoom')).toBe('clamp(0.78, calc(100cqw / var(--studio-layout-width)), 1)')
  } finally {
    viewport.remove()
    style.remove()
  }
})
