// @vitest-environment jsdom
/** Covered-content selectors stay inside navigator rows. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROW = 'data-files-navigator-row'

describe('navigator covered-content selectors', () => {
  it.each(['fill', 'overlay', 'wholePage'])('limits %s selectors to marked direct parents', (mode) => {
    const root = document.createElement('div')
    const owned = document.createElement('section')
    owned.setAttribute(ROW, '')
    const content = document.createElement('article')
    const navigator = document.createElement('aside')
    navigator.className = `navigator ${mode}`
    owned.append(content, navigator)
    const unrelated = document.createElement('section')
    const unrelatedContent = document.createElement('article')
    const unrelatedNavigator = document.createElement('aside')
    unrelatedNavigator.className = navigator.className
    unrelated.append(unrelatedContent, unrelatedNavigator)
    root.append(owned, unrelated)

    const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/FilesBody.module.css'), 'utf8')
    // CSS Modules only localizes class names; keep the source selectors concrete.
    const selectors = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(match => /(?:^|;)\s*visibility:\s*hidden\s*(?:;|$)/.test(match[2]!))
      .map(match => match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/:global\(([^)]+)\)/g, '$1'))
    expect(selectors).toHaveLength(2)
    for (const [index, selector] of selectors.entries()) {
      const covered = [...root.querySelectorAll(selector)]
      expect(covered).not.toContain(unrelatedContent)
      expect(covered).not.toContain(navigator)
      expect(covered.includes(content)).toBe(index === 0 ? mode === 'fill' : mode !== 'wholePage')
    }
    owned.removeAttribute(ROW)
    for (const selector of selectors) expect(root.querySelectorAll(selector)).toHaveLength(0)
  })
})
