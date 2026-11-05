// @vitest-environment jsdom
/** Market artwork previews, portrait failures, and accessible introductions. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MarketAuthorPreview } from '../src/client/MarketAuthorPreview.tsx'
import { MarketCatalogBot, MarketSkillArtwork } from '../src/client/MarketCatalogArtwork.tsx'
import { MarketArtwork, MarketCharacter } from '../src/client/MarketCharacter.tsx'
import { marketFailure } from '../src/client/market-errors.ts'
import { resolveMarketSkillArtwork } from '../src/client/market-skill-artwork.ts'
import { boundMarketPresentation, stockDirectorAnimation, stockMarketPresentation } from '../src/client/market-stock-art.ts'
import { marketFixture } from './market-fixture.client.ts'

afterEach(cleanup)

const blank = { name: '', title: '', description: '', category: '' }
const bot = marketFixture[0]!
const skill = marketFixture[1]!

it('switches a missing catalog Bot portrait to its fallback and loads a different role', () => {
  const fallback = <span>Static artwork</span>
  const view = render(<MarketCatalogBot id="muse/bots/unknown" label="Unknown Bot" fallback={fallback} />)
  expect(screen.getByText('Static artwork')).toBeDefined()
  view.rerender(<MarketCatalogBot id="muse/bots/anime-3d-assets" label="Asset designer" fallback={fallback} />)
  const asset = screen.getByRole('img', { name: 'Asset designer' })
  expect(asset.getAttribute('src')).toContain('catalog-anime-3d-assets.png')
  fireEvent.error(asset)
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByText('Static artwork')).toBeDefined()
  view.rerender(<MarketCatalogBot id="codex-coding" label="Coder" fallback={fallback} />)
  expect(screen.getByRole('img', { name: 'Coder' }).getAttribute('src')).toContain('catalog-codex-coding.png')
})

it('keeps a Skill illustration accessible when its storyboard image fails', () => {
  render(<MarketSkillArtwork metadata={skill.manifest} label="Storyboard" />)
  const image = screen.getByRole('img', { name: 'Storyboard' })
  expect(image.getAttribute('src')).toContain('storyboard-skill-kit.png')
  fireEvent.error(image)
  const fallback = screen.getByRole('img', { name: 'Storyboard' })
  expect(fallback.localName).toBe('svg')
  expect(fallback.querySelector('path')).not.toBeNull()
})

it('retains the correct artwork label and supplied framing after a failed custom portrait', () => {
  const base = { label: 'Director', sampleLabel: 'Default artwork' }
  const view = render(<MarketArtwork {...base} posterUrl="/preview.png" />)
  fireEvent.error(screen.getByRole('img', { name: 'Director' }))
  expect(screen.getByRole('img', { name: 'Director' }).localName).toBe('span')
  expect(screen.getByText('Default artwork')).toBeDefined()
  view.rerender(<MarketArtwork {...base} posterUrl="/replacement.png" posterFraming={[0.75, 10, -2]} />)
  const replacement = screen.getByRole('img', { name: 'Director' })
  expect(replacement.getAttribute('src')).toBe('/replacement.png')
  expect(replacement.getAttribute('style')).toContain('scale(0.75)')
  expect(screen.queryByText('Default artwork')).toBeNull()
})

it('introduces the character by pointer, focus or touch and dismisses it with Escape', () => {
  const presentation = { role: 'Director', introduction: 'I plan shots' }
  const view = render(<MarketCharacter presentation={presentation} artwork={<span>Original artwork</span>}
    introduceLabel="Meet the Bot" sampleLabel="Default artwork" />)
  const [portrait, caption] = screen.getAllByRole('button', { name: 'Meet the Bot' })
  const character = view.container.firstElementChild!
  expect(character.getAttribute('data-introducing')).toBe('false')
  fireEvent.pointerEnter(character)
  expect(character.getAttribute('data-introducing')).toBe('true')
  fireEvent.pointerLeave(character)
  fireEvent.focus(portrait!)
  fireEvent.blur(portrait!, { relatedTarget: caption! })
  expect(character.getAttribute('data-introducing')).toBe('true')
  fireEvent.blur(caption!, { relatedTarget: document.body })
  expect(character.getAttribute('data-introducing')).toBe('false')
  fireEvent.click(portrait!)
  expect(portrait!.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('I plan shots')).toBeDefined()
  fireEvent.keyDown(caption!, { key: 'Enter' })
  expect(caption!.getAttribute('aria-expanded')).toBe('true')
  fireEvent.keyDown(caption!, { key: 'Escape' })
  expect(caption!.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('I plan shots')).toBeNull()
  expect(screen.getByText('Original artwork')).toBeDefined()
})

it('keeps custom sprite dimensions independent from stock director framing', () => {
  const animation = { ...stockDirectorAnimation, sheetUrl: '/custom-sheet.png', cellWidth: 200, cellHeight: 100 }
  const presentation = { role: 'Custom director', introduction: 'I plan shots', animation }
  const view = render(<MarketCharacter presentation={presentation} introduceLabel="Meet the Bot" sampleLabel="Default artwork" />)
  const sprite = view.container.querySelector('svg[viewBox="0 0 200 100"]')
  expect(sprite?.getAttribute('style')).toBeNull()
  expect(sprite?.querySelector('image')?.getAttribute('href')).toBe('/custom-sheet.png')
})

it('previews a missing Bot brief and applies edited role and introduction copy only to the preview', () => {
  render(<MarketAuthorPreview metadata={blank} version="" publisher="" bot skillNames={[]}
    presetPortrait={undefined} t={key => key} />)
  const preview = within(screen.getByRole('complementary', { name: 'preview' }))
  expect(preview.getByRole('heading', { name: 'untitledBot' })).toBeDefined()
  expect(preview.getByText('summaryPlaceholder')).toBeDefined()
  expect(preview.getByText('publisherPending · versionPending')).toBeDefined()
  expect(preview.getByText('noSelectedSkills')).toBeDefined()
  fireEvent.change(preview.getByRole('textbox', { name: 'role' }), { target: { value: 'Storyboard artist' } })
  fireEvent.change(preview.getByRole('textbox', { name: 'introduction' }), { target: { value: 'I sketch scenes' } })
  const introduce = preview.getAllByRole('button', { name: 'introduce' })[1]!
  fireEvent.click(introduce)
  expect(preview.getByRole('img', { name: 'Storyboard artist' })).toBeDefined()
  expect(document.getElementById(introduce.getAttribute('aria-controls')!)?.textContent).toBe('I sketch scenes')
})

it('chooses a cover only when a Skill description has one distinct purpose', () => {
  expect(resolveMarketSkillArtwork({ ...blank, description: 'Prepare voice references' })).toBe('voice')
  expect(resolveMarketSkillArtwork({ ...blank, description: 'Prepare voice and subtitles' })).toBe('document')
  expect(resolveMarketSkillArtwork(blank)).toBe('document')
})

it('uses shipped static and animated assets only for the bound portrait or exact sample release', () => {
  const sample = { ...bot, sha256: 'f10f9df6c7b45d6950ee52aa5375416cec6eb020af8df84d646ab5f00af054fc' }
  expect(stockMarketPresentation(bot)).toBeUndefined()
  expect(stockMarketPresentation({ ...sample, manifest: skill.manifest })).toBeUndefined()
  expect(stockMarketPresentation(sample)).toMatchObject({ role: bot.manifest.title, animation: stockDirectorAnimation })
  expect(boundMarketPresentation(bot.manifest)).toBeUndefined()
  expect(boundMarketPresentation({ ...bot.manifest, portrait: 'storyboard-director' })).toMatchObject({ animation: stockDirectorAnimation })
  expect(boundMarketPresentation({ ...bot.manifest, portrait: 'storyboard-director', presetPortrait: 'video-editor' }))
    .toMatchObject({ posterUrl: expect.stringContaining('video-editor') })
})

it('shows known market errors without leaking unknown upstream details', () => {
  expect(marketFailure(Error('login-required'))).toBe('error.login-required')
  expect(marketFailure(Error('private upstream diagnostic'))).toBe('error.generic')
  expect(marketFailure('login-required')).toBe('error.generic')
})
