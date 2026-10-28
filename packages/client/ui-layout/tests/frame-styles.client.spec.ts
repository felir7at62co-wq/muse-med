/** The frame reserves native reopen chrome only when a collapsed desktop column is fully hidden. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/AppFrame.module.css', import.meta.url), 'utf8')

it('limits native leading clearance to a fully hidden sidebar, including fullscreen', () => {
  expect(css).toContain(":global([data-platform='darwin']) .frame[data-sidebar-hidden] {")
  expect(css).toContain(":global([data-platform='darwin'][data-fullscreen]) .frame[data-sidebar-hidden] {")
  expect(css).not.toContain('.frame[data-sidebar-collapsed]')
})

it('removes the macOS column separator only when the column is fully hidden', () => {
  expect(css).toContain(":global([data-platform='darwin']) [data-sidebar-hidden] .centerCol {")
  expect(css).not.toContain('[data-sidebar-collapsed] .centerCol')
})
