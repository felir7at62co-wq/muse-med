/** The Muse media surface stays dark and readable independently of the page palette. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseRules } from './stylesheet-scan.ts'

const platform = parseRules(readFileSync(new URL('../src/styles/design-platform.css', import.meta.url), 'utf8'))
const shelf = readFileSync(new URL('../../ui-session-video/src/client/VideoShelf.module.css', import.meta.url), 'utf8')

type Color = readonly [number, number, number]

function palette(dark: boolean): Map<string, string> {
  return new Map(platform.filter(rule => rule.selectors.includes('body')
    || dark && rule.selectors.includes('body[data-ds-dark-theme]')).flatMap(rule => rule.declarations))
}

function color(values: Map<string, string>, token: string): Color {
  let value = values.get(token)
  for (let depth = 0; depth < 8; depth++) {
    const reference = value?.match(/^var\((--[\w-]+)\)$/)?.[1]
    if (reference === undefined) break
    value = values.get(reference)
  }
  const match = value?.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
  if (match === undefined || match === null) throw new Error(`Unresolved color token ${token}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function luminance(rgb: Color): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const [red = 0, green = 0, blue = 0] = linear
  return red * 0.2126 + green * 0.7152 + blue * 0.0722
}

function contrast(first: Color, second: Color): number {
  const a = luminance(first), b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

it.each([false, true])('keeps a dark Muse material and readable primary and secondary labels, dark=%s', (dark) => {
  const values = palette(dark)
  const fill = color(values, '--dsw-alias-video-shelf-bg')
  expect(Math.max(...fill)).toBeLessThan(40)
  for (const label of ['--dsw-alias-video-shelf-label', '--dsw-alias-video-shelf-label-secondary']) {
    expect(contrast(fill, color(values, label))).toBeGreaterThanOrEqual(4.5)
  }
  expect(Math.max(...color(values, '--dsw-alias-video-shelf-stroke'))).toBeLessThan(100)
})

it('keeps the player, inline card and nested timeline on the independent video material', () => {
  expect(shelf).not.toContain('--dsw-alias-chat-assistant-bg')
  for (const alias of ['label-primary', 'label-secondary', 'label-tertiary', 'bg-base']) {
    expect(shelf).toContain(`--dsw-alias-${alias}: var(--dsw-alias-video-shelf-`)
  }
})
