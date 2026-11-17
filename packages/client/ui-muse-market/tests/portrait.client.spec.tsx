// @vitest-environment jsdom
/** Shared character identity and measured framing across Skill presentations. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveMarketSkillArtwork } from '../src/client/market-skill-artwork.ts'
import { marketPresetPortraits, matchMarketPresetPortrait } from '../src/client/market-preset-portraits.ts'
import { marketPortraitStyle, presetPortraitFraming } from '../src/client/market-portrait-framing.ts'
import { SkillPortrait } from '../src/client/SkillPortrait.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Skill artwork', () => {
  it.each([['anime-3d-assets', '3d-asset-artist'], ['muse-storyboard-checklist', 'storyboard-reviewer'],
    ['office-docx', 'document-specialist'], ['tweet-drama-background-render', 'compositor'], ['audio-transcribe', 'sound-designer']])(
    'keeps the established character for %s', (name, expected) => {
      expect(resolveMarketSkillArtwork({ name, title: name, description: '', category: '' })).toBe(expected)
    })

  it('prefers an existing character binding and safely matches an unknown binding by purpose', () => {
    const metadata = { name: 'anime-3d-assets', title: '3D资产', description: '', category: '' }
    expect(resolveMarketSkillArtwork({ ...metadata, presetPortrait: 'cinematographer' })).toBe('cinematographer')
    expect(resolveMarketSkillArtwork({ ...metadata, presetPortrait: 'unavailable-character' })).toBe('3d-asset-artist')
    expect(resolveMarketSkillArtwork({ name: 'custom', title: '对白润色', description: '', category: '' })).toBe('dialogue-polish')
  })

  it('contains fifty equalized characters and keeps a fixed square display stage', () => {
    expect(marketPresetPortraits).toHaveLength(50)
    for (const portrait of marketPresetPortraits) {
      const framing = presetPortraitFraming[portrait.id]
      expect(framing.every(Number.isFinite)).toBe(true)
      expect(marketPortraitStyle(framing)?.transform).toContain('scale(')
    }
    const css = readFileSync(resolve('packages/client/ui-muse-market/src/client/MarketSection.module.css'), 'utf8')
    expect(css).toContain('height: 224px')
    expect(css).toContain('object-fit: contain')
    expect(marketPortraitStyle(undefined)).toBeUndefined()
  })

  it('matches tags and explicit purpose while using a stable general-purpose fallback', () => {
    expect(matchMarketPresetPortrait({}).id).toBe('document-specialist')
    expect(matchMarketPresetPortrait({ tags: ['dialogue polish'] }).id).toBe('dialogue-polish')
    expect(matchMarketPresetPortrait({ purpose: '分镜审阅', description: 'research assistant' }).id).toBe('storyboard-reviewer')
  })

  it('uses a focusable character and the shared hover card for its full introduction', async () => {
    render(<SkillPortrait metadata={{ name: 'muse-storyboard-checklist', title: 'Review skill', description: 'Review each shot before delivery', category: 'Review' }} />)
    const button = screen.getByRole('button', { name: 'Review skill' })
    expect(button.getAttribute('data-market-portrait')).toBe('storyboard-reviewer')
    expect(button.querySelector('img')?.getAttribute('style')).toContain('scale(0.9521)')
    vi.spyOn(button, 'matches').mockReturnValue(true)
    fireEvent.focus(button)
    expect(await screen.findByText('Review each shot before delivery')).toBeTruthy()
  })
})


it('opens a touch-accessible introduction and recovers an unavailable image', async () => {
  const view = render(<SkillPortrait metadata={{ name: 'anime-3d-assets', title: '3D artist', description: 'Create models', category: '3D' }} introductionLabel="Meet" closeLabel="Close" />)
  const button = screen.getByRole('button', { name: '3D artist' }), image = button.querySelector('img')!
  const original = image.getAttribute('src')
  fireEvent.error(image)
  expect(image.getAttribute('src')).not.toBe(original)
  fireEvent.click(button)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('dialog', { name: '3D artist' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(button.getAttribute('aria-expanded')).toBe('false')
  view.unmount()
})
