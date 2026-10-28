/** Sidebar shell style contracts shared with its slot-owned controls. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SidebarRoot.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one exact selector, keyed by property.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when absent.
 */
function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

describe('SidebarRoot.module.css', () => {
  it('moves the Mac toggle below native buttons before the column reaches the compact rail', () => {
    expect(declarations('.topStrip')?.get('position')).toBe('relative')
    expect(declarations('.topStrip')?.get('z-index')).toBe('1')
    expect(declarations('.topStrip .toggle')?.get('transition'))
      .toBe('transform var(--ds-transition-duration-slow) var(--ds-ease-in-out)')
    expect(declarations('.fading .topStrip .toggle')?.get('transform')).toBe('translateY(36px)')
    expect(declarations('.root[data-sidebar-opening] .topStrip .toggle')?.get('animation'))
      .toBe('toggle-rise var(--ds-transition-duration-slow) var(--ds-ease-in-out)')
    expect(declarations(':global([data-sidebar-collapsed]:not([data-animating])) .fading .topStrip .toggle')?.get('transition'))
      .toBe('none')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.fading \.topStrip \.toggle\s*\{\s*transform: none;/)
  })

  it('hides Windows navigation only when collapse removes the whole column', () => {
    for (const child of ['.panelList', '.regionArea', '.footArea']) {
      expect(declarations(`:global([data-windows-titlebar]) .collapsed:not([data-desktop-rail]) ${child}`)?.get('display')).toBe('none')
      expect(declarations(`:global([data-windows-titlebar]) .collapsed ${child}`)).toBeUndefined()
    }
    expect(declarations(':global([data-windows-titlebar]) .root.collapsed:not([data-desktop-rail])')?.get('padding')).toBe('0')
  })

  it('removes the empty native chrome strip from retained fullscreen rails', () => {
    expect(declarations(':global([data-fullscreen]) .root[data-desktop-rail] .topStrip')?.get('display')).toBe('none')
    expect(declarations(':global([data-fullscreen]) .root[data-desktop-rail] .logoRow')?.get('margin-top')).toBe('0')
  })

  it('shares and cancels the wide shell trailing padding structurally', () => {
    const root = declarations('.root')
    expect(root?.get('--dsh-sidebar-inline-padding')).toBe('12px')
    expect(root?.get('padding')).toBe('6px var(--dsh-sidebar-inline-padding)')
    expect(declarations('.regionArea')?.get('margin-left')).toBe('-4px')
    expect(declarations('.regionArea')?.get('padding-left')).toBe('4px')
    expect(declarations('.regionArea')?.get('margin-right')).toBe(
      'calc(-1 * var(--dsh-sidebar-inline-padding))',
    )
    expect(declarations('.collapsed .regionArea')?.get('margin-left')).toBe('0')
    expect(declarations('.collapsed .regionArea')?.get('padding-left')).toBe('0')
    expect(declarations('.collapsed .regionArea')?.get('margin-right')).toBe('0')
  })

  it('keeps controls visible while wide labels fade and only the browsing region freezes', () => {
    expect(declarations('.root')?.get('width')).toBe('100%')
    expect(declarations('.fading .wide')?.get('opacity')).toBe('0')
    expect(declarations('.fading > *')).toBeUndefined()
    expect(declarations('.fading .regionArea')?.get('width')).toBe(
      'calc(var(--dsh-sidebar-expanded-width) - var(--dsh-sidebar-inline-padding))',
    )
    expect(declarations('.wideIn')?.get('animation')).toBe('region-in 200ms var(--ds-ease-in-out) backwards')
    expect(declarations('.regionArea')?.get('animation')).toBeUndefined()
  })

  it('keeps compact controls inside the rail throughout their short entrance', () => {
    const animation = 'rail-in 150ms var(--ds-ease-in-out) backwards'
    for (const selector of [
      '.railIn .iconButton',
      '.railIn .newSession',
      '.railIn .regionArea',
    ]) {
      expect(declarations(selector)?.get('animation')).toBe(animation)
    }
    expect(declarations('.railIn .footArea')?.get('animation')).toBe(
      'rail-fade-in 150ms var(--ds-ease-in-out) backwards',
    )
    expect(css).toMatch(
      /@keyframes rail-in\s*\{\s*from\s*\{\s*opacity: 0\.6;\s*transform: translateX\(8px\);\s*}\s*}/,
    )
    expect(css).toMatch(/@keyframes rail-fade-in\s*\{\s*from\s*\{\s*opacity: 0\.6;\s*}\s*}/)
  })

  it('gives shell rail controls the same base anchor for their shared translation', () => {
    expect(declarations('.collapsed .logoRow')?.get('justify-content')).toBe('flex-start')
    expect(declarations('.collapsed .newSession')?.get('align-self')).toBe('flex-start')
    expect(declarations('.collapsed .newSession')?.get('width')).toBe('36px')
  })

  it('keeps the slotted brand row at the full artwork height', () => {
    expect(declarations('.brandIdentity')?.get('height')).toBe('24px')
    expect(declarations('.brandName')?.get('height')).toBe('24px')
    expect(declarations('.brandName')?.get('line-height')).toBe('24px')
    expect(declarations('.brandName')?.get('font-size')).toBe('18px')
    expect(declarations('.fallbackBrandName')?.get('font-size')).toBe('17px')
    expect(declarations('.fallbackBrandName')?.get('white-space')).toBe('nowrap')
  })
})
